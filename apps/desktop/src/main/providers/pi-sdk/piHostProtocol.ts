import type { RuntimeEvent, PermissionMode } from "@contracts/runtime";
import type { StartTurnRequest, ApprovalRequest, ProviderApprovalDecision, UserInputRequest, UserInputDecision, PlanApprovalRequest, PlanApprovalDecision } from "@contracts/provider";
import type { PiProviderPublic } from "@contracts/piModel";

export const PI_HOST_PROTOCOL_VERSION = 1 as const;

export type PiHostCall =
  | { method: "healthCheck"; params: { agentDir: string } }
  | { method: "listModels"; params: { providers: Record<string, PiProviderPublic>; apiKeys: Record<string, string>; agentDir: string } }
  | { method: "smoke"; params: { cwd: string; agentDir: string; providers?: Record<string, PiProviderPublic>; apiKeys?: Record<string, string> } }
  | { method: "startTurn"; params: PiHostTurnConfig }
  | { method: "abort"; params: { turnId: string } };

export interface PiHostTurnConfig {
  turnId: string;
  request: StartTurnRequest;
  providers: Record<string, PiProviderPublic>;
  apiKeys: Record<string, string>;
  extraSkillPaths: string[];
  gitBash: string | null;
  browserToolsEnabled: boolean;
  browserToolSpecs: Record<string, { description: string; promptSnippet?: string }>;
  browserUsagePrompt: string;
  /** Built-in mario_web_search / mario_web_fetch and mario_image_generate switches for this
   *  turn (main resolves them; the tools run main-side via the
   *  `builtinTool` reverse method). Absent = off. */
  webToolsEnabled?: boolean;
  imageToolEnabled?: boolean;
  /** mario_schedule_* and mario_wechat_notify switches (same resolution). */
  scheduleToolsEnabled?: boolean;
  wechatToolEnabled?: boolean;
  /** The turn is an unattended run (scheduled task / ClawBot DM), resolved
   *  main-side by isUnattendedSession — feeds builtinToolNeedsApproval in
   *  the tool_call guard. Absent = attended. */
  unattended?: boolean;
  /** The user's global + project system prompt, already formatted into
   *  sections and joined (see `userSystemPromptSections`); "" when unset.
   *  Resolved main-side (settings DB + project file) because the host
   *  process has neither. */
  userSystemPrompt: string;
  agentDir: string;
}

export type PiHostReverseMethod = "requestApproval" | "requestUserInput" | "requestPlanApproval" | "permissionState" | "browser" | "builtinTool";
export type PiHostReverseParams = ApprovalRequest | UserInputRequest | PlanApprovalRequest | { toolName: string } | { name: string; args: unknown; meta?: unknown };
export type PiHostReverseResult = ProviderApprovalDecision | UserInputDecision | PlanApprovalDecision | unknown;

export type PiHostToMain =
  | { type: "ready"; protocol: typeof PI_HOST_PROTOCOL_VERSION }
  | { type: "result"; id: string; ok: true; value: unknown }
  | { type: "result"; id: string; ok: false; error: string }
  | { type: "event"; turnId: string; event: RuntimeEvent }
  | { type: "providerSessionId"; turnId: string; value: string }
  | { type: "log"; turnId?: string; level: "info" | "warn" | "error"; message: string }
  | { type: "reverse"; id: string; turnId: string; method: PiHostReverseMethod; params: PiHostReverseParams };

export type MainToPiHost =
  | { type: "call"; id: string; call: PiHostCall }
  | { type: "reverseResult"; id: string; ok: true; value: PiHostReverseResult }
  | { type: "reverseResult"; id: string; ok: false; error: string };

export function isMainToPiHost(value: unknown): value is MainToPiHost {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type === "reverseResult") return typeof v.id === "string" && typeof v.ok === "boolean";
  if (v.type !== "call" || typeof v.id !== "string" || !v.call || typeof v.call !== "object") return false;
  const call = v.call as { method?: unknown; params?: unknown };
  if (!call.params || typeof call.params !== "object") return false;
  const p = call.params as Record<string, unknown>;
  if (call.method === "healthCheck") return typeof p.agentDir === "string" && p.agentDir.length > 0;
  if (call.method === "abort") return typeof p.turnId === "string" && p.turnId.length > 0;
  if (call.method === "smoke") return typeof p.cwd === "string" && p.cwd.length > 0 && typeof p.agentDir === "string" && p.agentDir.length > 0
    && (p.providers === undefined || isRecord(p.providers)) && (p.apiKeys === undefined || isStringRecord(p.apiKeys));
  if (call.method === "listModels") return isRecord(p.providers) && isStringRecord(p.apiKeys) && typeof p.agentDir === "string" && p.agentDir.length > 0;
  if (call.method !== "startTurn") return false;
  if (typeof p.turnId !== "string" || !p.turnId || !p.request || typeof p.request !== "object") return false;
  const req = p.request as Record<string, unknown>;
  return typeof req.sessionId === "string" && !!req.sessionId
    && typeof req.cwd === "string" && !!req.cwd
    && typeof req.prompt === "string"
    && isRecord(p.providers) && isStringRecord(p.apiKeys)
    && Array.isArray(p.extraSkillPaths) && p.extraSkillPaths.every((x) => typeof x === "string")
    && (p.gitBash === null || typeof p.gitBash === "string")
    && typeof p.browserToolsEnabled === "boolean"
    && (p.webToolsEnabled === undefined || typeof p.webToolsEnabled === "boolean")
    && (p.imageToolEnabled === undefined || typeof p.imageToolEnabled === "boolean")
    && (p.scheduleToolsEnabled === undefined || typeof p.scheduleToolsEnabled === "boolean")
    && (p.wechatToolEnabled === undefined || typeof p.wechatToolEnabled === "boolean")
    && (p.unattended === undefined || typeof p.unattended === "boolean")
    && typeof p.agentDir === "string" && p.agentDir.length > 0
    && isRecord(p.browserToolSpecs) && typeof p.browserUsagePrompt === "string"
    && typeof p.userSystemPrompt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((x) => typeof x === "string");
}

export function normalizePermissionMode(value: unknown): PermissionMode | undefined {
  return typeof value === "string" ? value : undefined;
}
