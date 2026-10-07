import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { invokeMcpTurn } from "@main/mcp/McpToolSession.js";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ProviderContext } from "@contracts/provider";
import { resolvePiRuntimeLaunch } from "@main/runtimes/runtimeSelection.js";
import { networkFingerprint, withEngineNetworkEnv } from "@main/network/engineProxy.js";
import * as browser from "@main/browser/agentBrowserTools.js";
import { invokeBuiltinTool } from "@main/tools/builtinTools.js";
import { isBuiltinToolName } from "@main/tools/builtinToolSpecs.js";
import { PI_HOST_PROTOCOL_VERSION, type MainToPiHost, type PiHostCall, type PiHostToMain } from "./piHostProtocol.js";
import { unpackPiHostPath } from "./piHostPath.js";

const CALL_TIMEOUT_MS = 30_000;
const REVERSE_TIMEOUT_MS = 5 * 60_000;
const BROWSER_METHODS = new Set([
  "browser_list", "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_keys",
  "browser_scroll", "browser_wait", "browser_history", "browser_select", "browser_find", "browser_switch_tab",
  "browser_close_tab", "browser_upload_file", "browser_save_pdf", "browser_downloads", "browser_evaluate", "browser_screenshot",
]);

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

export class PiHostClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly turnContexts = new Map<string, ProviderContext>();
  private ready: Promise<void> | null = null;
  private launchFingerprint: string | null = null;
  private startupReject: ((error: Error) => void) | null = null;
  private startFlight: Promise<void> | null = null;
  private generation = 0;

  private ensureStarted(): Promise<void> {
    if (this.startFlight) return this.startFlight;
    const flight = this.ensureStartedInner();
    const wrapped = flight.finally(() => { if (this.startFlight === wrapped) this.startFlight = null; });
    this.startFlight = wrapped;
    return this.startFlight;
  }

  private async ensureStartedInner(): Promise<void> {
    const launch = await resolvePiRuntimeLaunch();
    const env = await withEngineNetworkEnv({ ...process.env, ELECTRON_RUN_AS_NODE: undefined });
    const runtimeKey = `${launch.nodePath}\u0000${launch.sdkEntry}\u0000${launch.version}`;
    const fingerprint = `${runtimeKey}\u0000${networkFingerprint(env)}`;
    if (this.ready && this.launchFingerprint === fingerprint) return this.ready;
    // A network route change alone must not kill a turn in flight: a busy host
    // keeps its old route, and the first call after it goes idle restarts it.
    const busy = this.pending.size > 0 || this.turnContexts.size > 0;
    if (this.ready && busy && this.launchFingerprint?.startsWith(`${runtimeKey}\u0000`)) return this.ready;
    if (this.child) this.stop(new Error("Pi runtime selection changed"));
    const generation = ++this.generation;
    this.launchFingerprint = fingerprint;
    this.ready = (async () => {
      const hostEntry = unpackPiHostPath(join(__dirname, "..", "pi-host", "piHost.mjs"));
      const child = spawn(launch.nodePath, [hostEntry, launch.sdkEntry, launch.sdkPackageDir, launch.version], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
      this.child = child;
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => console.warn(`[pi-host] ${chunk.trimEnd()}`));
      child.once("exit", (code, signal) => this.failAll(new Error(`Pi host exited (${code ?? signal ?? "unknown"})`), generation));
      child.once("error", (err) => this.failAll(err, generation));
      createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line, generation));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error("Pi host startup timed out")); }, CALL_TIMEOUT_MS);
        this.startupReject = (error) => { clearTimeout(timer); reject(error); };
        const onReady = (message: PiHostToMain) => {
          if (message.type !== "ready") return;
          clearTimeout(timer);
          if (message.protocol !== PI_HOST_PROTOCOL_VERSION) { child.kill(); reject(new Error(`Unsupported Pi host protocol ${message.protocol}`)); return; }
          this.readyListener = null; this.startupReject = null;
          resolve();
        };
        this.readyListener = onReady;
      });
    })().catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  private readyListener: ((message: PiHostToMain) => void) | null = null;

  private onLine(line: string, generation: number): void {
    if (generation !== this.generation) return;
    let message: PiHostToMain;
    try { message = JSON.parse(line) as PiHostToMain; } catch { return; }
    if (!message || typeof message !== "object" || typeof message.type !== "string") return;
    this.readyListener?.(message);
    if (message.type === "result") {
      const p = this.pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer); this.pending.delete(message.id);
      message.ok ? p.resolve(message.value) : p.reject(new Error(message.error));
    } else if (message.type === "event") {
      this.turnContexts.get(message.turnId)?.emit(message.event);
    } else if (message.type === "providerSessionId") {
      this.turnContexts.get(message.turnId)?.onProviderSessionId?.(message.value);
    } else if (message.type === "log") {
      const ctx = message.turnId ? this.turnContexts.get(message.turnId) : undefined;
      (ctx?.log[message.level] ?? console[message.level])(`pi host: ${message.message}`);
    } else if (message.type === "reverse") {
      void this.handleReverse(message);
    }
  }

  private async handleReverse(message: Extract<PiHostToMain, { type: "reverse" }>): Promise<void> {
    const ctx = this.turnContexts.get(message.turnId);
    if (!ctx) return this.write({ type: "reverseResult", id: message.id, ok: false, error: "turn no longer active" });
    try {
      let value: unknown;
      if (message.method === "requestApproval") {
        const request = message.params as import("@contracts/provider").ApprovalRequest;
        const mode = ctx.getPermissionMode?.();
        const auto = ctx.isToolAlwaysAllowed?.(request.toolName)
          || mode === "bypassPermissions" || mode === "dontAsk"
          || (mode === "acceptEdits" && (request.toolName === "write" || request.toolName === "edit"));
        value = auto ? { allow: true, persist: !!ctx.isToolAlwaysAllowed?.(request.toolName) } : await ctx.requestApproval?.(request);
      }
      else if (message.method === "requestUserInput") value = await ctx.requestUserInput?.(message.params as never);
      else if (message.method === "requestPlanApproval") value = await ctx.requestPlanApproval?.(message.params as never);
      else if (message.method === "permissionState") {
        const toolName = (message.params as { toolName: string }).toolName;
        if (typeof toolName !== "string" || !toolName) throw new Error("Invalid permissionState request");
        value = { mode: ctx.getPermissionMode?.(), alwaysAllowed: ctx.isToolAlwaysAllowed?.(toolName) === true };
      }
      else if (message.method === "builtinTool") value = await this.invokeBuiltin(message.params as { name: string; args: unknown; meta?: unknown }, ctx, message.turnId);
      else if (message.method === "mcpTool") {
        const call = message.params as { name: string; args: unknown };
        value = await invokeMcpTurn(message.turnId, call.name, call.args);
      }
      else value = await this.invokeBrowser(message.params as { name: string; args: unknown; meta?: unknown }, ctx, message.turnId);
      this.write({ type: "reverseResult", id: message.id, ok: true, value });
    } catch (err) {
      this.write({ type: "reverseResult", id: message.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** A built-in web / image tool call from the host. The session id comes
   *  from the turn id, not the host-supplied meta. */
  private async invokeBuiltin(call: { name: string; args: unknown; meta?: unknown }, ctx: ProviderContext, turnId: string): Promise<unknown> {
    if (!isBuiltinToolName(call.name)) throw new Error(`Unsupported built-in tool: ${call.name}`);
    const sessionId = turnId.split(":", 1)[0]!;
    const meta = (call.meta ?? {}) as { toolCallId?: unknown; turnNumber?: unknown };
    const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
    return invokeBuiltinTool(call.name, args, {
      toolCallId: typeof meta.toolCallId === "string" && meta.toolCallId ? meta.toolCallId : randomUUID(),
      sessionId,
      turnNumber: typeof meta.turnNumber === "number" ? meta.turnNumber : undefined,
      onImage: (info) => ctx.emit({ type: "browser.image", sessionId, toolCallId: info.toolCallId, data: info.data, mimeType: info.mimeType }),
    });
  }

  private async invokeBrowser(call: { name: string; args: unknown; meta?: unknown }, ctx: ProviderContext, turnId: string): Promise<unknown> {
    if (!BROWSER_METHODS.has(call.name)) throw new Error(`Unsupported browser method: ${call.name}`);
    const a = call.args as Record<string, unknown>;
    switch (call.name) {
      case "browser_list": return browser.browserList();
      case "browser_navigate": return browser.browserNavigate(a as never, (call.meta as { projectPath?: string })?.projectPath ?? "");
      case "browser_snapshot": return browser.browserSnapshot(a);
      case "browser_click": return browser.browserClick(a as never);
      case "browser_type": return browser.browserType(a as never);
      case "browser_keys": return browser.browserKeys(a as never);
      case "browser_scroll": return browser.browserScroll(a as never);
      case "browser_wait": return browser.browserWait(a as never);
      case "browser_history": return browser.browserHistory(a as never);
      case "browser_select": return browser.browserSelect(a as never);
      case "browser_find": return browser.browserFind(a as never);
      case "browser_switch_tab": return browser.browserSwitchTab(a as never);
      case "browser_close_tab": return browser.browserCloseTab(a as never);
      case "browser_upload_file": return browser.browserUploadFile(a as never, (call.meta as { projectPath?: string })?.projectPath ?? "");
      case "browser_save_pdf": return browser.browserSavePdf(a as never, call.meta as never);
      case "browser_downloads": return browser.browserDownloads();
      case "browser_evaluate": return browser.browserEvaluate(a as never);
      case "browser_screenshot": return browser.browserScreenshot(a as never, { ...(call.meta as object), onImage: (info: { toolCallId: string; data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }) => ctx.emit({ type: "browser.image", sessionId: turnId.split(":", 1)[0]!, toolCallId: info.toolCallId, data: info.data, mimeType: info.mimeType }) } as never);
      default: throw new Error("unreachable");
    }
  }

  async call<T>(call: PiHostCall, ctx?: ProviderContext, turnId?: string, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    await this.ensureStarted();
    if (ctx && turnId) this.turnContexts.set(turnId, ctx);
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (call.method === "startTurn") {
          const abortId = randomUUID();
          const generation = this.generation;
          const abortTimer = setTimeout(() => {
            this.pending.delete(abortId);
            if (this.generation === generation) this.stop(new Error("Pi turn did not acknowledge abort after timeout"));
          }, 5_000);
          this.pending.set(abortId, {
            resolve: () => { clearTimeout(abortTimer); this.pending.delete(abortId); },
            reject: () => { clearTimeout(abortTimer); if (this.generation === generation) this.stop(new Error("Pi turn abort failed")); },
            timer: abortTimer,
          });
          this.write({ type: "call", id: abortId, call: { method: "abort", params: { turnId: call.params.turnId } } });
        }
        reject(new Error(`Pi host ${call.method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ type: "call", id, call });
    }).finally(() => { if (call.method === "startTurn" && turnId) this.turnContexts.delete(turnId); });
  }

  private write(message: MainToPiHost): void { this.child?.stdin.write(`${JSON.stringify(message)}\n`); }
  private failAll(error: Error, generation?: number): void {
    if (generation !== undefined && generation !== this.generation) return;
    this.startupReject?.(error); this.startupReject = null; this.readyListener = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.turnContexts.clear(); this.child = null; this.ready = null; this.launchFingerprint = null;
  }

  stop(reason = new Error("Pi host stopped")): void {
    const child = this.child;
    this.generation++;
    this.failAll(reason);
    if (child) {
      // EOF lets the SDK abort its tool processes before the host exits.
      child.stdin.end();
      const killTimer = setTimeout(() => child.kill(), 3000);
      killTimer.unref();
      child.once("exit", () => clearTimeout(killTimer));
    }
  }
}

export const piHostClient = new PiHostClient();
process.once("exit", () => piHostClient.stop());

/** Real no-model-call probe: boots the resolved SDK and creates/disposes an
 * in-memory session without reading or transmitting any configured API key. */
export async function smokePiHost(cwd: string, agentDir: string): Promise<{ ok: boolean; sessionId: string }> {
  return piHostClient.call({ method: "smoke", params: { cwd, agentDir } });
}
