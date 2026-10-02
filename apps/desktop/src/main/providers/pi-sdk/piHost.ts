import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { join } from "node:path";
import type { ProviderContext } from "@contracts/provider";
import type { RuntimeEvent } from "@contracts/runtime";
import type { BuiltinModelOption } from "@contracts/provider";
import { PI_1M_CONTEXT_WINDOW } from "@contracts/piModel";
import { resolveContextPolicy } from "@contracts/contextPolicy";
import { PiMessageAdapter } from "./PiMessageAdapter.js";
import { buildPiTokenSnapshot } from "./piTokenUsage.js";
import { buildPiSkillLoader, rewriteSkillPrefix, createMntNormalizingReadTool } from "./piSkillBridge.js";
import { createMarioCodeExtension } from "./mariocodeExtension.js";
import { normalizePiRegisteredModel } from "./piRegisteredModel.js";
import { dropFileSnapshot, getFileSnapshot } from "@main/lib/fileSnapshotRegistry.js";
import { isMainToPiHost, PI_HOST_PROTOCOL_VERSION, type MainToPiHost, type PiHostReverseMethod, type PiHostToMain, type PiHostTurnConfig } from "./piHostProtocol.js";

const sdkEntry = process.argv[2];
const runtimeVersion = process.argv[4];
if (!sdkEntry || !isAbsolute(sdkEntry)) throw new Error("Pi host requires an absolute SDK entry path");
const sdkPromise = import(pathToFileURL(sdkEntry).href) as Promise<typeof import("@earendil-works/pi-coding-agent")>;
const turns = new Map<string, { session: { abort(): Promise<void>; dispose(): void }; aborted: boolean }>();
const reversePending = new Map<string, { turnId: string; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
const abortedTurns = new Set<string>();

let shuttingDown = false;
function send(message: PiHostToMain): void { if (!shuttingDown) process.stdout.write(`${JSON.stringify(message)}\n`); }
function safeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function validateReverseResult(method: PiHostReverseMethod, value: unknown): unknown {
  if (!value || typeof value !== "object") throw new Error(`Invalid ${method} response`);
  const v = value as Record<string, unknown>;
  if (method === "requestApproval" && typeof v.allow !== "boolean") throw new Error("Invalid approval response");
  if (method === "requestUserInput" && (!v.answers || typeof v.answers !== "object" || Array.isArray(v.answers))) throw new Error("Invalid user-input response");
  if (method === "requestPlanApproval" && typeof v.approved !== "boolean") throw new Error("Invalid plan-approval response");
  if (method === "permissionState" && (typeof v.alwaysAllowed !== "boolean" || (v.mode !== undefined && typeof v.mode !== "string"))) throw new Error("Invalid permission-state response");
  if ((method === "browser" || method === "builtinTool") && !Array.isArray(v.content)) throw new Error(`Invalid ${method} response`);
  return value;
}
function reverse(turnId: string, method: PiHostReverseMethod, params: never): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reversePending.delete(id); reject(new Error(`${method} timed out`)); }, 5 * 60_000);
    reversePending.set(id, { turnId, resolve: (value) => { try { resolve(validateReverseResult(method, value)); } catch (err) { reject(err as Error); } }, reject, timer });
    send({ type: "reverse", id, turnId, method, params });
  });
}

async function createRuntime(sdk: typeof import("@earendil-works/pi-coding-agent"), config: Pick<PiHostTurnConfig, "apiKeys" | "providers" | "agentDir">, sharedOnly: boolean) {
  // Shared providers are fully isolated. Legacy providers retain Pi's normal
  // read-only models/auth discovery so existing OAuth/API-key setups continue
  // to work without migration.
  const runtime = await sdk.ModelRuntime.create(sharedOnly ? {
    modelsPath: null,
    authPath: join(config.agentDir, "auth.json"),
    modelsStorePath: join(config.agentDir, "models-store.json"),
    allowModelNetwork: false,
  } : { allowModelNetwork: false });
  for (const [name, provider] of Object.entries(config.providers)) {
    if (!name.startsWith("shared_") || !sharedOnly) continue;
    const { hasApiKey: _presenceOnly, ...providerConfig } = provider;
    runtime.registerProvider(name, {
      ...providerConfig,
      models: providerConfig.models?.map(normalizePiRegisteredModel),
    } as never);
  }
  for (const [name, key] of Object.entries(config.apiKeys)) {
    if (key && (sharedOnly ? name.startsWith("shared_") : !name.startsWith("shared_"))) await runtime.setRuntimeApiKey(name, key);
  }
  return runtime;
}

function projectModel(model: { id: string; name?: string; provider: string; contextWindow?: number }, providers?: Record<string, PiHostTurnConfig["providers"][string]>): BuiltinModelOption {
  return { id: `${model.provider}/${model.id}`, label: model.name ?? model.id, supplier: providers?.[model.provider]?.name ?? model.provider,
    hint: model.contextWindow && model.contextWindow >= PI_1M_CONTEXT_WINDOW ? "1M" : undefined };
}

async function startTurn(config: PiHostTurnConfig): Promise<void> {
  const sdk = await sdkPromise;
  const { request: req, turnId } = config;
  const alwaysAllowed = new Set<string>();
  const ctx: ProviderContext = {
    emit: (event) => send({ type: "event", turnId, event }),
    requestApproval: async (p) => {
      const decision = await reverse(turnId, "requestApproval", p as never) as import("@contracts/provider").ProviderApprovalDecision;
      if (decision.allow && decision.persist) alwaysAllowed.add(p.toolName);
      return decision;
    },
    requestUserInput: (p) => reverse(turnId, "requestUserInput", p as never) as never,
    requestPlanApproval: (p) => reverse(turnId, "requestPlanApproval", p as never) as never,
    isToolAlwaysAllowed: (name) => alwaysAllowed.has(name),
    getPermissionMode: () => req.permissionMode,
    onProviderSessionId: (value) => send({ type: "providerSessionId", turnId, value }),
    log: {
      info: (...a) => send({ type: "log", turnId, level: "info", message: a.map(String).join(" ") }),
      warn: (...a) => send({ type: "log", turnId, level: "warn", message: a.map(String).join(" ") }),
      error: (...a) => send({ type: "log", turnId, level: "error", message: a.map(String).join(" ") }),
    },
  };
  if (abortedTurns.delete(turnId)) {
    ctx.emit({ type: "turn.done", sessionId: req.sessionId, reason: "interrupted" });
    return;
  }
  const defaultProvider = (!req.model || req.model === "default")
    ? Object.entries(config.providers).find(([name, provider]) => provider.models?.length && (!name.startsWith("shared_") || config.apiKeys[name]))
    : undefined;
  const selectedModel = defaultProvider ? `${defaultProvider[0]}/${defaultProvider[1].models![0]!.id}` : req.model;
  const selectedProvider = selectedModel?.split("/", 1)[0] ?? "";
  const sharedMode = selectedProvider.startsWith("shared_");
  if (sharedMode && (!config.providers[selectedProvider] || !config.apiKeys[selectedProvider])) {
    throw new Error(`统一提供商未配置或缺少 API Key: ${selectedProvider}`);
  }
  let sessionManager;
  const createSessionManager = () => sharedMode
    ? sdk.SessionManager.create(req.cwd, join(config.agentDir, "sessions"))
    : sdk.SessionManager.create(req.cwd);
  try { sessionManager = req.resumeProviderSessionId ? sdk.SessionManager.open(req.resumeProviderSessionId) : createSessionManager(); }
  catch { sessionManager = createSessionManager(); }
  const modelRuntime = await createRuntime(sdk, config, sharedMode);
  let model: ReturnType<typeof modelRuntime.getModel>;
  if (selectedModel && selectedModel !== "default") {
    const i = selectedModel.indexOf("/");
    if (i > 0 && config.providers[selectedModel.slice(0, i)]) {
      try { model = modelRuntime.getModel(selectedModel.slice(0, i), selectedModel.slice(i + 1)); } catch { /* fallback below */ }
    }
  }
  if (sharedMode && !model) throw new Error(`统一提供商模型不可用: ${selectedModel ?? selectedProvider}`);
  if (!model) {
    for (const [provider, pub] of Object.entries(config.providers)) {
      const first = pub.models?.find((m) => m.id?.trim());
      if (first) { try { model = modelRuntime.getModel(provider, first.id); } catch { model = undefined; } if (model) break; }
    }
  }
  if (!model) throw new Error("Pi 未配置可用模型");
  const selectedId = model.id;
  const configuredModel = config.providers[model.provider]?.models?.find((entry) => entry.id === selectedId);
  const policy = resolveContextPolicy(configuredModel?.contextWindow, config.contextPolicy);
  model = { ...model, contextWindow: policy.contextWindow };
  const settingsManager = sdk.SettingsManager.create(req.cwd, config.agentDir);
  settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: policy.reserveTokens } });
  const strict = req.permissionMode !== "bypassPermissions" && req.permissionMode !== "dontAsk";
  dropFileSnapshot(req.sessionId);
  const snapshot = getFileSnapshot(req.sessionId);
  const extension = createMarioCodeExtension({ ctx, cwd: req.cwd, strict, sessionId: req.sessionId, projectPath: req.cwd, turnNumber: req.turnNumber, browserToolsEnabled: config.browserToolsEnabled, userSystemPrompt: config.userSystemPrompt,
    browserBridge: { specs: config.browserToolSpecs, usagePrompt: config.browserUsagePrompt, invoke: (name, args, meta) => reverse(turnId, "browser", { name, args, meta } as never) as never }, snapshot,
    builtinTools: { web: config.webToolsEnabled === true, image: config.imageToolEnabled === true, schedule: config.scheduleToolsEnabled === true, wechat: config.wechatToolEnabled === true },
    unattended: config.unattended === true,
    builtinBridge: { invoke: (name, args, meta) => reverse(turnId, "builtinTool", { name, args, meta } as never) as never },
    permissionState: (toolName) => reverse(turnId, "permissionState", { toolName } as never) as never });
  const loader = await buildPiSkillLoader({ sdk, cwd: req.cwd, agentDir: config.agentDir, allowNames: req.skills?.length ? req.skills : undefined, extraSkillPaths: config.extraSkillPaths, extensionFactories: [extension] });
  const customTools = process.platform === "win32" ? [
    createMntNormalizingReadTool(sdk, req.cwd),
    ...(config.gitBash ? [sdk.createBashToolDefinition(req.cwd, { shellPath: config.gitBash }) as never] : []),
  ] : [];
  const { session } = await sdk.createAgentSession({ cwd: req.cwd, agentDir: config.agentDir, thinkingLevel: req.effort !== "default" ? req.effort as never : undefined, customTools, sessionManager, modelRuntime, resourceLoader: loader, model, settingsManager });
  if (shuttingDown) { await session.abort(); session.dispose(); return; }
  turns.set(turnId, { session, aborted: false });
  if (abortedTurns.delete(turnId)) { turns.get(turnId)!.aborted = true; await session.abort(); }
  if (req.images?.length && session.model && !(session.model.input ?? []).includes("image")) session.model.input = [...(session.model.input ?? []), "image"];
  ctx.onProviderSessionId?.(session.sessionFile ?? session.sessionId);
  // Host owns a separate registry. Replace, rather than clear, so a late
  // flush from an interrupted prior turn retains its captured instance.
  // Pi emits agent_end before its post-run auto-compaction. Keep the turn
  // active until prompt() settles so compaction cannot race a resumed turn.
  let pendingCompletion: Extract<RuntimeEvent, { type: "turn.done" }> | undefined;
  const adapterContext: ProviderContext = { ...ctx, emit: (event) => {
    if (event.type === "turn.done") pendingCompletion = event;
    else ctx.emit(event);
  } };
  const adapter = new PiMessageAdapter(adapterContext, req.sessionId, () => buildPiTokenSnapshot(session.getContextUsage(), session.getSessionStats(), session.model?.id ?? req.model), snapshot);
  const unsubscribe = session.subscribe((event) => adapter.dispatch(event));
  const prompt = rewriteSkillPrefix(req.prompt, new Set(loader.getSkills().skills.map((s) => s.name)));
  try {
    if (req.images?.length) await session.sendUserMessage([...(prompt.trim() ? [{ type: "text" as const, text: prompt }] : []), ...req.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))]);
    else await session.prompt(prompt);
    await adapter.flushFinal();
    if (pendingCompletion) ctx.emit(pendingCompletion);
  } catch (err) {
    await adapter.flushFinal();
    if (turns.get(turnId)?.aborted) ctx.emit({ type: "turn.done", sessionId: req.sessionId, reason: "interrupted" });
    else {
      ctx.emit({ type: "error", sessionId: req.sessionId, message: safeError(err), code: "PI_SDK_ERROR" });
      ctx.emit({ type: "turn.done", sessionId: req.sessionId, reason: "error" });
    }
  } finally { unsubscribe(); session.dispose(); turns.delete(turnId); abortedTurns.delete(turnId); }
}

async function dispatch(message: Extract<MainToPiHost, { type: "call" }>): Promise<unknown> {
  const sdk = await sdkPromise;
  switch (message.call.method) {
    case "healthCheck": {
      const { session } = await sdk.createAgentSession({ agentDir: message.call.params.agentDir, modelRuntime: await createRuntime(sdk, { agentDir: message.call.params.agentDir, providers: {}, apiKeys: {} }, true), sessionManager: sdk.SessionManager.inMemory() });
      session.dispose();
      return { ok: true, version: (sdk as { VERSION?: string }).VERSION ?? runtimeVersion };
    }
    case "smoke": {
      const providers = message.call.params.providers ?? {};
      const apiKeys = message.call.params.apiKeys ?? {};
      const modelRuntime = await createRuntime(sdk, { agentDir: message.call.params.agentDir, providers, apiKeys }, true);
      const { session } = await sdk.createAgentSession({ cwd: message.call.params.cwd, agentDir: message.call.params.agentDir, modelRuntime, sessionManager: sdk.SessionManager.inMemory() });
      const snapshotKey = `smoke:${randomUUID()}`;
      const first = getFileSnapshot(snapshotKey);
      await first.freeze();
      dropFileSnapshot(snapshotKey);
      const second = getFileSnapshot(snapshotKey);
      const firstShared = Object.entries(providers).find(([name, provider]) => name.startsWith("shared_") && provider.models?.[0]);
      const registeredModel = firstShared ? modelRuntime.getModel(firstShared[0], firstShared[1].models![0]!.id) : undefined;
      const value = { ok: true, sessionId: session.sessionId, snapshotFresh: first !== second && second.size === 0,
        registeredModel: registeredModel ? {
          id: registeredModel.id, name: registeredModel.name, provider: registeredModel.provider, api: registeredModel.api,
          baseUrl: registeredModel.baseUrl, reasoning: registeredModel.reasoning, input: registeredModel.input,
          cost: registeredModel.cost, contextWindow: registeredModel.contextWindow, maxTokens: registeredModel.maxTokens,
        } : undefined };
      dropFileSnapshot(snapshotKey);
      session.dispose();
      if (!value.snapshotFresh) throw new Error("FileSnapshot registry did not replace the frozen turn instance");
      return value;
    }
    case "listModels": {
      const providers = message.call.params.providers;
      const names = Object.keys(providers);
      const shared = new Set(names.filter((name) => name.startsWith("shared_")));
      const legacy = new Set(names.filter((name) => !name.startsWith("shared_")));
      const [legacyModels, sharedModels] = await Promise.all([
        legacy.size ? createRuntime(sdk, message.call.params, false).then((runtime) => runtime.getAvailable())
          .catch(() => { send({ type: "log", level: "warn", message: "Legacy Pi model discovery failed; shared providers remain isolated." }); return []; }) : Promise.resolve([]),
        shared.size ? createRuntime(sdk, message.call.params, true).then((runtime) => runtime.getAvailable()) : Promise.resolve([]),
      ]);
      return [...legacyModels.filter((m) => legacy.has(m.provider)), ...sharedModels.filter((m) => shared.has(m.provider))]
        .map((model) => projectModel(model, providers));
    }
    case "abort": {
      const turnId = message.call.params.turnId;
      const active = turns.get(turnId);
      if (active) { active.aborted = true; await active.session.abort(); } else abortedTurns.add(turnId);
      for (const [id, pending] of reversePending) if (pending.turnId === turnId) {
        clearTimeout(pending.timer); reversePending.delete(id); pending.reject(new Error("Turn interrupted"));
      }
      return { ok: true };
    }
    case "startTurn": await startTurn(message.call.params); return { ok: true };
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (shuttingDown) return;
  let message: unknown; try { message = JSON.parse(line); } catch { return; }
  if (!isMainToPiHost(message)) return;
  if (message.type === "reverseResult") {
    const p = reversePending.get(message.id); if (!p) return;
    clearTimeout(p.timer); reversePending.delete(message.id); message.ok ? p.resolve(message.value) : p.reject(new Error(message.error)); return;
  }
  void dispatch(message).then((value) => send({ type: "result", id: message.id, ok: true, value }), (err) => send({ type: "result", id: message.id, ok: false, error: safeError(err) }));
});
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const pending of reversePending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Host input closed")); }
  reversePending.clear();
  await Promise.race([
    Promise.allSettled([...turns.values()].map((active) => active.session.abort())),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  process.exit(0);
}
input.once("close", () => void shutdown());
process.once("disconnect", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
process.stdout.once("error", () => void shutdown());
send({ type: "ready", protocol: PI_HOST_PROTOCOL_VERSION });
