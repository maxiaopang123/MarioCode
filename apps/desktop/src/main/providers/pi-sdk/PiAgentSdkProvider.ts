import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app } from "electron";
import type { AgentProvider, StartTurnRequest, ProviderContext, TurnHandle, ProviderCapabilities } from "@contracts/provider";
import type { PiProviderPublic } from "@contracts/piModel";
import { PiModelsStore } from "@main/lib/piModelsStore.js";
import { resolveGitBash } from "@main/lib/binaryResolve.js";
import { getEnabledPluginSkillRoots } from "@main/plugins/pluginManager.js";
import { getMcpManagement } from "@main/lib/mcpConfig.js";
import { BROWSER_TOOL_SPECS, browserToolsUsagePrompt } from "@main/browser/agentBrowserTools.js";
import { piHostClient } from "./PiHostClient.js";

const PI_PERMISSION_MODES = [
  { value: "default", label: "Default", icon: "shield", hint: "标准行为,工具按规则触发审批" },
  { value: "acceptEdits", label: "Edit Auto", icon: "shieldCheck", color: "text-warning", hint: "工作目录内的文件编辑自动放行" },
  { value: "plan", label: "Plan", icon: "shieldHalf", color: "text-info", hint: "只读探索,所有写操作都需审批" },
  { value: "bypassPermissions", label: "Bypass", icon: "shieldLock", color: "text-danger", hint: "跳过所有权限检查(慎用)" },
];

export function piPrivateAgentDir(): string {
  return join(app.getPath("userData"), "agent-config", "pi");
}

async function loadHostConfiguration(): Promise<{ providers: Record<string, PiProviderPublic>; apiKeys: Record<string, string>; extraSkillPaths: string[]; gitBash: string | null; browserToolsEnabled: boolean; agentDir: string }> {
  const providers = await PiModelsStore.listPublic();
  const apiKeys: Record<string, string> = {};
  for (const [name, provider] of Object.entries(providers)) {
    if (!provider.hasApiKey) continue;
    const key = PiModelsStore.resolveApiKey(name);
    if (key) apiKeys[name] = key;
  }
  const mcp = await getMcpManagement();
  return { providers, apiKeys, extraSkillPaths: await getEnabledPluginSkillRoots(), gitBash: process.platform === "win32" ? resolveGitBash() : null, browserToolsEnabled: !mcp.browserDisabled, agentDir: piPrivateAgentDir() };
}

export class PiAgentSdkProvider implements AgentProvider {
  readonly id = "pi-sdk";
  readonly displayName = "Pi";
  readonly capabilities: ProviderCapabilities = {
    supportsApproval: true, supportsResume: true, supportsStreaming: true, supportsMcp: false, supportsAskUserQuestion: true,
    thinkingLevels: [
      { value: "default", label: "Auto", hint: "让 Pi 自选" }, { value: "off", label: "Off", hint: "关闭思考" },
      { value: "minimal", label: "Minimal", hint: "极少思考" }, { value: "low", label: "Low", hint: "快速" },
      { value: "medium", label: "Med", hint: "平衡" }, { value: "high", label: "High", hint: "更多思考" },
      { value: "xhigh", label: "XHigh", hint: "深度思考" }, { value: "max", label: "Max", hint: "最充分,最慢" },
    ], permissionModes: PI_PERMISSION_MODES, builtinModels: [], supportsCustomEndpoint: false,
  };

  async startTurn(req: StartTurnRequest, ctx: ProviderContext): Promise<TurnHandle> {
    const config = await loadHostConfiguration();
    if (Object.keys(config.providers).length === 0) {
      ctx.emit({ type: "error", sessionId: req.sessionId, message: "Pi 未配置任何模型:请先在「设置 → 模型配置」中添加模型后再发送。", code: "PI_NO_MODEL" });
      ctx.emit({ type: "turn.done", sessionId: req.sessionId, reason: "error" });
      return { done: Promise.resolve(), interrupt: () => {}, isRunning: () => false };
    }
    const selectedProvider = req.model?.split("/", 1)[0];
    if (selectedProvider?.startsWith("shared_")) {
      const selected = config.providers[selectedProvider];
      const selectedModel = req.model?.slice(selectedProvider.length + 1);
      if (!selected || !selectedModel || !selected.models?.some((model) => model.id === selectedModel)) {
        const message = `统一提供商模型不可用: ${req.model ?? selectedProvider}`;
        ctx.emit({ type: "error", sessionId: req.sessionId, message, code: "PI_SHARED_MODEL_INVALID" });
        ctx.emit({ type: "turn.done", sessionId: req.sessionId, reason: "error" });
        return { done: Promise.resolve(), interrupt: () => {}, isRunning: () => false };
      }
      if (!config.apiKeys[selectedProvider]) {
        const message = `统一提供商「${selected.name ?? selectedProvider}」未配置 API Key`;
        ctx.emit({ type: "error", sessionId: req.sessionId, message, code: "PI_SHARED_KEY_MISSING" });
        ctx.emit({ type: "turn.done", sessionId: req.sessionId, reason: "error" });
        return { done: Promise.resolve(), interrupt: () => {}, isRunning: () => false };
      }
    }
    const turnId = `${req.sessionId}:${randomUUID()}`;
    let running = true;
    const done = piHostClient.call({ method: "startTurn", params: { turnId, request: req, ...config, browserToolSpecs: BROWSER_TOOL_SPECS, browserUsagePrompt: browserToolsUsagePrompt() } }, ctx, turnId, 24 * 60 * 60_000)
      .then(() => {}, (err) => {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.error(`pi host error: ${message}`);
        ctx.emit({ type: "error", sessionId: req.sessionId, message, code: "PI_HOST_ERROR" });
        ctx.emit({ type: "turn.done", sessionId: req.sessionId, reason: "error" });
      }).finally(() => { running = false; });
    return { done, interrupt: () => { if (running) void piHostClient.call({ method: "abort", params: { turnId } }).catch(() => {}); }, isRunning: () => running };
  }

  async healthCheck(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try { return await piHostClient.call({ method: "healthCheck", params: { agentDir: piPrivateAgentDir() } }); }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  }
}
