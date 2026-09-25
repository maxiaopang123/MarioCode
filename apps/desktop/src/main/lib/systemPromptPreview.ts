/**
 * Layered system-prompt preview for the settings panel (TODO-006).
 *
 * Reproduces, per provider, the ORDER in which prompt layers reach the model
 * and the text of every layer MarioCode owns. Layers owned by the engine
 * (the CLI's base prompt, output styles, CLAUDE.md / AGENTS.md it loads by
 * itself) are listed as `engine` sections with `text: null` so the user sees
 * where they sit without MarioCode pretending to know their content.
 *
 * The fixed fragments are imported from the same modules the providers use
 * (`systemPrompt.ts`, `askQuestion.ts`, the Codex provider's AGENTS.md
 * builder), so the preview cannot drift from what is actually injected; the
 * conditional ones carry the condition in their id / title instead of being
 * evaluated here (plan mode, missing AskUserQuestion) — except the two that
 * are decided by settings or the OS and can be read right now (built-in
 * browser switch, Windows path hint).
 */
import type { SystemPromptPreviewResult, SystemPromptPreviewSection } from "@contracts/ipc";
import { ASK_NATIVE_TOOL_PROMPT, ASK_SYSTEM_PROMPT } from "./askQuestion.js";
import { bashPathHintFor, detectBashEnv } from "./bashEnv.js";
import { codexHomePath } from "./codexModelsStore.js";
import { getMcpManagement } from "./mcpConfig.js";
import { getOutputStyleSetting } from "./outputStyleConfig.js";
import {
  CLAUDE_IDENTITY_PROMPT,
  CLAUDE_PLAN_MODE_NUDGE,
  PI_IDENTITY_PROMPT,
  PI_PLAN_MODE_PROMPT,
  formatUserGlobalSection,
  formatUserProjectSection,
} from "./systemPrompt.js";
import {
  loadGlobalUserPrompt,
  loadUserSystemPrompt,
  projectPromptFile,
  type UserSystemPrompt,
} from "./userSystemPrompt.js";
import { browserToolsUsagePrompt } from "@main/browser/agentBrowserTools.js";
import { codexHomeAgentsMarkdown } from "@main/providers/codex-sdk/CodexAgentSdkProvider.js";
import { builtinToolsUsagePrompt } from "@main/tools/builtinToolSpecs.js";
import { builtinToolFlags } from "@main/tools/builtinToolsConfig.js";
import path from "node:path";

/** The two user layers, identical for every provider. `text: null` marks an
 *  unset scope so the renderer can show "(未设置)" in place. Built with the
 *  same formatters the providers spread into `joinPromptSections`, so the
 *  precedence line that appears when both scopes are set shows up here too. */
function userSections(prompt: UserSystemPrompt, projectPath: string | null): SystemPromptPreviewSection[] {
  const projectFile = prompt.projectFile ?? (projectPath ? projectPromptFile(projectPath) : null);
  const global = formatUserGlobalSection(prompt.global);
  const project = formatUserProjectSection(prompt.project, global !== null);
  return [
    { id: "user.global", kind: "user", text: global },
    {
      id: "user.project",
      kind: "user",
      text: project,
      ...(projectFile ? { meta: { path: projectFile } } : {}),
    },
  ];
}

export async function previewSystemPrompt(
  providerId: string,
  projectPath: string | null,
): Promise<SystemPromptPreviewResult> {
  // Same loader the providers run at turn start; `cwd` doubles as the only
  // candidate root here (no session → no worktree fallback to add).
  const prompt: UserSystemPrompt = projectPath
    ? await loadUserSystemPrompt({ cwd: projectPath })
    : { global: await loadGlobalUserPrompt(), project: "", projectFile: null };
  const user = userSections(prompt, projectPath);
  const [mcp, outputStyle, builtinFlags] = await Promise.all([
    getMcpManagement().catch(() => ({ browserDisabled: false })),
    getOutputStyleSetting().catch(() => null),
    builtinToolFlags().catch(() => ({ web: false, image: false })),
  ]);
  const browserEnabled = !mcp.browserDisabled;
  const builtinUsage = builtinToolsUsagePrompt(builtinFlags);
  const win32 = process.platform === "win32";

  let sections: SystemPromptPreviewSection[];
  switch (providerId) {
    case "claude-sdk":
      sections = [
        { id: "engine.claude.base", kind: "engine", text: null, meta: { style: outputStyle || "default" } },
        { id: "identity", kind: "fixed", text: CLAUDE_IDENTITY_PROMPT },
        ...user,
        ...(win32
          ? [{ id: "claude.pathHint", kind: "conditional", text: bashPathHintFor(detectBashEnv("claude")) } as const]
          : []),
        { id: "claude.planNudge", kind: "conditional", text: CLAUDE_PLAN_MODE_NUDGE },
        { id: "claude.askFallback", kind: "conditional", text: ASK_SYSTEM_PROMPT },
        { id: "engine.claude.memory", kind: "engine", text: null },
      ];
      break;
    case "pi-sdk":
      sections = [
        { id: "engine.pi.base", kind: "engine", text: null },
        { id: "identity", kind: "fixed", text: PI_IDENTITY_PROMPT },
        ...user,
        { id: "pi.askNative", kind: "fixed", text: ASK_NATIVE_TOOL_PROMPT },
        { id: "pi.plan", kind: "fixed", text: PI_PLAN_MODE_PROMPT },
        {
          id: browserEnabled ? "browser.usage.on" : "browser.usage.off",
          kind: "conditional",
          text: browserEnabled ? browserToolsUsagePrompt() : null,
        },
        {
          id: builtinUsage ? "builtin.usage.on" : "builtin.usage.off",
          kind: "conditional",
          text: builtinUsage || null,
        },
      ];
      break;
    case "codex-sdk":
      sections = [
        { id: "engine.codex.base", kind: "engine", text: null },
        // Both user scopes travel as ONE developer message
        // (thread/start + thread/resume `developerInstructions`), which codex
        // places after its base instructions and before AGENTS.md.
        ...user,
        {
          id: "codex.agentsHome",
          kind: "fixed",
          text: codexHomeAgentsMarkdown(builtinFlags),
          meta: { path: path.join(codexHomePath(), "AGENTS.md") },
        },
        {
          id: "engine.codex.projectAgents",
          kind: "engine",
          text: null,
          ...(projectPath ? { meta: { path: path.join(projectPath, "AGENTS.md") } } : {}),
        },
        { id: "engine.codex.environment", kind: "engine", text: null },
      ];
      break;
    default:
      // Unknown / future provider: show the provider-neutral layers only.
      sections = [{ id: "engine.unknown.base", kind: "engine", text: null }, ...user];
  }
  return { providerId, sections };
}
