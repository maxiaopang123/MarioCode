/**
 * Inline Pi extension — bridges MarioCode's host-side approval, AskUserQuestion,
 * and system-prompt capabilities into the Pi agent via the SDK's extension API.
 *
 * ## Why an extension (not customTools wrapping)
 *
 * The previous implementation wrapped `write`/`edit`/`bash` tool definitions
 * via `customTools` same-name override (see `createGuardedFileTools` /
 * `createGuardedBashTool` in the pre-refactor `PiAgentSdkProvider`). That had
 * three limitations the extension model fixes:
 *
 *   1. **Coverage**: customTools only intercept the 3 wrapped tools. The
 *      `tool_call` event fires for *every* tool (bash/read/edit/write/grep/
 *      find/ls + extension-registered), so the path/command guard and the
 *      approval prompt now apply uniformly.
 *   2. **Approval**: Pi's SDK has no `canUseTool` callback. The `tool_call`
 *      event with `{ block: true, reason }` is the equivalent — the agent loop
 *      converts a block into an `isError` tool result the model can react to
 *      (verified: `agent-loop.js` `prepareToolCall` → `createErrorToolResult`).
 *   3. **AskUserQuestion**: the extension registers a native tool the model
 *      calls autonomously; `execute` bridges to the host's
 *      `requestUserInput` IPC. This replaces the sentinel-text fallback.
 *
 * ## Injection
 *
 * The factory is passed as an `InlineExtension` via
 * `DefaultResourceLoader({ extensionFactories })`. The loader calls
 * `factory(pi)` during `getExtensions()` (before `_refreshToolRegistry`), so
 * `pi.registerTool` / `pi.on` are wired before the first turn. Inline
 * extensions survive `session.reload()` — `loadExtensionFactories` runs in
 * both the initial and reload code paths.
 *
 * ## Argument mutation
 *
 * `event.input` is the same object reference as the `validatedArgs` the agent
 * loop will pass to `tool.execute` (verified: `validateToolArguments` returns
 * a `structuredClone`, passed by reference through `beforeToolCall` →
 * `emitToolCall` → handler → `prepared.args`). So in-place mutation of
 * `event.input.path` is the equivalent of Claude's `updatedInput` — the
 * rewritten path reaches the actual tool execution.
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { McpToolSpec, McpToolResult } from "@contracts/mcpTool";
import { isSshMcpTool } from "@contracts/ssh";
import type {
  InlineExtension,
  ExtensionAPI,
  ToolCallEvent,
  ToolCallEventResult,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";
import type { ProviderContext } from "@contracts/provider";
import type { PermissionMode } from "@contracts/runtime";
import { normalizeToolFilePath } from "@main/lib/fileSnapshot.js";
import type { FileSnapshot } from "@main/lib/fileSnapshot.js";
import { normalizeBashCommand } from "@main/lib/msysPath.js";
import { guardBashCommand, expandTilde } from "./bashWriteGuard.js";
import {
  parseQuestions,
  formatAnswersForModel,
  ASK_NATIVE_TOOL_PROMPT,
} from "@main/lib/askQuestion.js";
import { PI_IDENTITY_PROMPT, joinPromptSections } from "@main/lib/systemPrompt.js";
import {
  BUILTIN_TOOL_SPECS,
  NO_BUILTIN_TOOLS,
  builtinToolNeedsApproval,
  builtinToolsUsagePrompt,
  isBuiltinToolName,
  type BuiltinToolFlags,
  type BuiltinToolResult,
} from "@main/tools/builtinToolSpecs.js";
type ToolResult = { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean };
export interface PiBrowserBridge {
  specs: Record<string, { description: string; promptSnippet?: string }>;
  usagePrompt: string;
  invoke(name: string, args: unknown, meta?: unknown): Promise<ToolResult>;
}
/** Runs a built-in tool (mario_web_search / mario_web_fetch / mario_image_generate) main-side;
 *  `meta` carries the toolCallId / session / turn for the image path. */
export interface PiBuiltinBridge {
  invoke(name: string, args: unknown, meta: { toolCallId: string; sessionId: string; turnNumber?: number }): Promise<BuiltinToolResult>;
}

/** Pi's write/edit tools carry their target path in the `path` field (unlike
 *  Claude's `file_path`). Both schemas are `{ path, ... }`. */
type PathToolParams = { path?: unknown };

/**
 * Guard a file-tool path. Mirrors the Claude provider's canUseTool guard:
 * WSL-style `/mnt/<drive>/...` paths are normalized to native Windows paths
 * (otherwise they'd resolve to a garbage `D:\mnt\...` folder), and writes
 * resolving outside the project working directory are denied except in
 * bypassPermissions/dontAsk, where the user explicitly opted out of all checks.
 *
 * This is the same logic the pre-refactor `guardToolPath` in
 * `PiAgentSdkProvider` implemented — extracted here so the `tool_call` handler
 * and the (still-used) customTools read-wrapper share one implementation.
 */
export function guardToolPath(
  cwd: string,
  rawPath: string,
  strict: boolean,
): { denied: true; message: string } | { denied: false; path: string } {
  const norm = normalizeToolFilePath(cwd, expandTilde(rawPath));
  if (!norm) return { denied: false, path: rawPath };
  if (!norm.insideProject && strict) {
    return {
      denied: true,
      message: `拒绝:目标路径在项目工作目录之外(${norm.absPath})。只允许在项目目录内写入文件,请改用相对路径。`,
    };
  }
  // Rewrite to the normalized absolute path so the write lands where the user
  // expects — an in-project `/mnt/d/...` path would otherwise resolve to a
  // garbage `D:\mnt\...` folder on Windows.
  return { denied: false, path: norm.absPath };
}

/** Pi's read-only built-in tools — auto-approved in every mode (including plan). */
const PI_READONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** MarioCode browser tools that are purely read-only (they can't mutate the page,
 *  navigate, or submit) — auto-approved in every mode, never routed through the
 *  approval prompt. scroll/wait/find are pure reading aids; save_pdf writes
 *  only into the managed artifacts dir with sanitized names. `browser_navigate`
 *  / `browser_click` / `browser_keys` / `browser_upload_file` etc. have side
 *  effects and DO go through approval (the user can still "always allow" them
 *  per session). */
const MARIOCODE_BROWSER_READONLY = new Set([
  "browser_list",
  "browser_snapshot",
  "browser_screenshot",
  "browser_find",
  "browser_scroll",
  "browser_wait",
  "browser_switch_tab",
  "browser_save_pdf",
  "browser_downloads",
]);

/**
 * Decide whether a Pi tool should be auto-approved (skip the prompt) based on
 * the session's CURRENT permission mode. Mirrors the Claude provider's
 * `shouldAutoApprove`, but uses Pi's lowercase tool names
 * (`write`/`edit` not `Write`/`Edit`).
 *
 *   - bypassPermissions / dontAsk → everything auto-approved
 *   - acceptEdits                  → file-editing tools auto-approved
 *   - plan                         → read-only tools auto-approved, writes prompt
 *   - default / auto               → prompt the user (return false)
 */
function shouldAutoApproveForPi(mode: PermissionMode | undefined, toolName: string): boolean {
  if (!mode) return false;
  // Read-only tools never need approval — they can't change anything.
  if (PI_READONLY_TOOLS.has(toolName)) return true;
  if (mode === "bypassPermissions" || mode === "dontAsk") return true;
  if (mode === "acceptEdits") return toolName === "write" || toolName === "edit";
  return false;
}

export interface CreateMarioCodeExtensionOptions {
  /** The host provider context — carries the IPC bridges for approval /
   *  user-input / permission-mode / always-allow checks. */
  ctx: ProviderContext;
  /** Project working directory. */
  cwd: string;
  /** Strict in-project policy: deny writes outside cwd. False in
   *  bypassPermissions/dontAsk (user opted out of all checks). */
  strict: boolean;
  /** The MarioCode session id — needed for all emit() calls (plan.update /
   * mode.change / plan.approval_request events carry it). */
  sessionId: string;
  /** Project root path — bound to auto-created browser views (for consistency
   *  with terminal/git). Passed through to the shared browser tools. */
  projectPath: string;
  /** 1-based turn number within the session (see StartTurnRequest.turnNumber).
   *  Passed to the browser tools so screenshots land in per-turn folders. */
  turnNumber?: number;
  /** Whether the in-app browser tools should be registered. Mirrors the MCP
   *  panel's built-in server switch (`browserDisabled` — same gate as the
   *  Claude provider's options.mcpServers injection); read per-turn by the
   *  provider, so flipping it lands on the next message. */
  browserToolsEnabled: boolean;
  /** The user's global + project system prompt, pre-joined main-side
   *  (`PiHostTurnConfig.userSystemPrompt`). Empty string = nothing to inject. */
  userSystemPrompt?: string;
  browserBridge: PiBrowserBridge;
  /** Built-in web / image tools registered this turn (resolved main-side). */
  builtinTools?: BuiltinToolFlags;
  builtinBridge?: PiBuiltinBridge;
  mcpBridge?: { specs: McpToolSpec[]; invoke(name: string, args: unknown): Promise<McpToolResult> };
  /** Unattended run (scheduled task / ClawBot turn), resolved main-side —
   *  input to builtinToolNeedsApproval in the tool_call guard. */
  unattended?: boolean;
  snapshot: FileSnapshot;
  permissionState?(toolName: string): Promise<{ mode?: PermissionMode; alwaysAllowed: boolean }>;
}

/**
 * Build the inline MarioCode extension. Returned as an `InlineExtension` (named
 * form) so it shows up as `<inline:mariocode>` in Pi's startup Extensions list —
 * useful for debugging whether the extension loaded.
 */
/**
 * Build the inline MarioCode extension. Returned as an `InlineExtension` (named
 * form) so it shows up as `<inline:mariocode>` in Pi's startup Extensions list —
 * useful for debugging whether the extension loaded.
 */
export function createMarioCodeExtension(opts: CreateMarioCodeExtensionOptions): InlineExtension {
  const { ctx, cwd, strict, sessionId, projectPath, turnNumber, browserToolsEnabled, userSystemPrompt, browserBridge, snapshot, permissionState } = opts;
  const builtinTools: BuiltinToolFlags = opts.builtinBridge ? opts.builtinTools ?? NO_BUILTIN_TOOLS : NO_BUILTIN_TOOLS;
  const unattended = opts.unattended === true;

  // ── Plan mode state (per-turn, in-process) ──────────────────────────
  // Tracked here rather than via ctx.getPermissionMode() because the latter
  // updates through an async IPC round-trip (renderer → updateSettings →
  // setPermissionMode) that can't be relied on to land before the next
  // tool_call handler runs. This boolean is synchronous: EnterPlanMode's
  // execute sets it before returning, so the next tool_call handler sees it.
  //
  // The extension is recreated every turn (createMarioCodeExtension is called in
  // each startTurn), so this doesn't persist across turns — which matches
  // Claude's semantics (plan mode is a turn-internal state).
  const planMode = { active: false };

  return {
    name: "mariocode",
    factory: (pi: ExtensionAPI) => {
      registerToolCallGuard(pi, { ctx, cwd, strict, sessionId, planMode, snapshot, permissionState, unattended });
      registerAskUserQuestionTool(pi, ctx);
      for (const spec of opts.mcpBridge?.specs ?? []) {
        pi.registerTool({ name: spec.name, label: spec.label, description: spec.description,
          parameters: Type.Unsafe<Record<string, unknown>>(spec.inputSchema),
          async execute(_id, params) {
            const result = await opts.mcpBridge!.invoke(spec.name, params);
            // Pi extension results do not expose isError to the agent loop;
            // throwing preserves error status and still returns text to it.
            if (result.isError) throw new Error(result.content.filter(b => b.type === "text").map(b => b.text).join("\n") || "MCP tool failed");
            return { content: result.content, details: {} };
          },
        });
      }
      // Browser tools + their usage prompt ride the same switch: when the
      // built-in server is disabled in the MCP panel, the model must neither
      // see the tools nor the prompt section advertising them.
      if (browserToolsEnabled) {
        registerBrowserTools(pi, { ctx, sessionId, projectPath, turnNumber, browserBridge });
      }
      if (opts.builtinBridge && (builtinTools.web || builtinTools.image || builtinTools.schedule || builtinTools.wechat)) {
        registerBuiltinTools(pi, { sessionId, turnNumber, flags: builtinTools, bridge: opts.builtinBridge });
      }
      registerPlanModeTools(pi, { ctx, sessionId, planMode });
      registerSystemPromptInjector(pi, {
        browserToolsEnabled,
        browserUsagePrompt: browserBridge.usagePrompt,
        builtinUsagePrompt: builtinToolsUsagePrompt(builtinTools),
        userSystemPrompt: userSystemPrompt ?? "",
      });
    },
  };
}

/**
 * `tool_call` handler — the Pi equivalent of Claude's `canUseTool`.
 *
 * Runs before every tool execution. Responsibilities, in order:
 *   1. Path/command guard (write/edit/bash) — replaces the old customTools
 *      wrapping. Denials return `{ block: true, reason }`; path normalization
 *      mutates `event.input` in place (same-ref → reaches execution).
 *   2. Plan tools bypass — EnterPlanMode/ExitPlanMode/AskUserQuestion handle
 *      their own logic in execute(); never route through approval.
 *   3. Host approval — permission-mode auto-approve, always-allow, then the
 *      IPC approval prompt. In plan mode, shouldAutoApproveForPi returns false
 *      for everything, so every mutating tool (write/edit/bash) triggers an
 *      approval dialog — the model can experiment during planning, but the user
 *      approves each action.
 */
function registerToolCallGuard(
  pi: ExtensionAPI,
  deps: {
    ctx: ProviderContext;
    cwd: string;
    strict: boolean;
    sessionId: string;
    planMode: { active: boolean };
    snapshot: FileSnapshot;
    permissionState?: CreateMarioCodeExtensionOptions["permissionState"];
    unattended: boolean;
  },
): void {
  const { ctx, cwd, strict, sessionId, planMode, unattended } = deps;

  pi.on("tool_call", async (event: ToolCallEvent): Promise<ToolCallEventResult | void> => {
    const { toolName } = event;
    // SSH execution always requests a one-shot approval in the main broker.
    // Never add a second generic approval (nor bypass the broker).
    if (isSshMcpTool(toolName)) return;

    // ① Path guard for write/edit.
    //    `event.input` is a shared reference with the args the agent will pass
    //    to execute, so mutating it in place is equivalent to Claude's
    //    `updatedInput` round-trip.
    if (toolName === "write" || toolName === "edit") {
      const input = event.input as PathToolParams;
      const raw = input.path;
      if (typeof raw === "string" && raw.length > 0) {
        const checked = guardToolPath(cwd, raw, strict);
        if (checked.denied) {
          return { block: true, reason: checked.message };
        }
        if (checked.path !== raw) {
          input.path = checked.path;
        }
        // Snapshot the file's pre-turn state for the "本轮修改" card + 撤销本轮
        // (rewind) — the same FileSnapshot the Claude provider's canUseTool
        // path uses. Await'd (not fire-and-forget) because the tool executes
        // right after this handler resolves: we want `before` to be the
        // pre-write content, not a racing partial read.
        await deps.snapshot.recordPre(cwd, checked.path);
      }
    }

    // ② Bash write-target guard. Same scope/limits as the pre-refactor
    //    createGuardedBashTool — NOT a sandbox, just blocks the common
    //    "write a helper script outside the project" pattern.
    if (toolName === "bash") {
      const input = event.input as { command?: unknown };
      const command = input.command;
      if (typeof command === "string" && command.length > 0) {
        // Normalize Git Bash `/d/...` and WSL `/mnt/d/...` dialects to native
        // `D:/...` BEFORE the guard: (1) the rewritten command is what actually
        // executes (event.input is the shared ref, same as write/edit), so the
        // command succeeds in Git Bash / PowerShell / cmd alike; (2) the write
        // targets extracted by guardBashCommand then resolve as real Windows
        // paths — `> /d/workspace/x.txt` was previously DENIED as out-of-project
        // because `/d/` resolved to a garbage root-relative folder.
        const normalized = normalizeBashCommand(command);
        if (normalized !== command) {
          input.command = normalized;
        }
        const denial = guardBashCommand(cwd, normalized, strict);
        if (denial) {
          return { block: true, reason: denial };
        }
      }
    }

    // ③ Plan tools + AskUserQuestion — their own execute() handles the IPC
    //    bridging; never route through the approval prompt or the plan-mode
    //    read-only gate.
    if (toolName === "EnterPlanMode" || toolName === "ExitPlanMode" || toolName === "AskUserQuestion") {
      return;
    }
    //    Read-only browser tools (list/snapshot/screenshot) can't mutate the
    //    page or navigate, so they're safe to auto-approve in every mode.
    //    `browser_navigate` / `browser_click` DO have side effects and fall
    //    through to the normal approval flow below.
    if (MARIOCODE_BROWSER_READONLY.has(toolName)) {
      return;
    }
    //    Built-in MarioTool tools follow the shared policy: read-only ones
    //    always pass; schedule mutations / WeChat notify pass without asking
    //    in unattended runs (the schedule tools then refuse main-side).
    if (isBuiltinToolName(toolName) && !builtinToolNeedsApproval(toolName, unattended)) {
      return;
    }

    // ④ Plan-mode: write tools allowed but require approval.
    //    Unlike Claude's plan mode (strictly read-only), Pi's plan mode lets the
    //    model write files / run commands to verify hypotheses during planning —
    //    but every mutating tool goes through the approval prompt (step ⑤).
    //    planMode.active doesn't block tools here; it only means
    //    shouldAutoApproveForPi returns false for everything, so the user gets
    //    an approval dialog for each write/edit/bash. The model can experiment
    //    safely while the user retains control.

    // ⑤ Permission-mode auto-approve (reads the LIVE mode so a mid-turn flip
    //    applies to the next tool immediately). In plan mode, nothing is
    //    auto-approved — every tool hits the approval prompt below.
    // The SDK lives in another process, so sync ProviderContext getters are
    // only a conservative initial snapshot. Query main for every mutating
    // tool. A transport failure must block: an initial bypass mode could
    // have been revoked by the user while the turn was running.
    let live: { mode?: PermissionMode; alwaysAllowed: boolean } = { mode: ctx.getPermissionMode?.(), alwaysAllowed: false };
    if (deps.permissionState) {
      try { live = await deps.permissionState(toolName); }
      catch { return { block: true, reason: "Cannot verify current tool permissions: the desktop connection is unavailable." }; }
    }
    const mode = live.mode;
    if (shouldAutoApproveForPi(mode, toolName)) {
      return;
    }
    if (deps.permissionState ? live.alwaysAllowed : ctx.isToolAlwaysAllowed?.(toolName)) {
      return;
    }

    // ⑥ Host-moderated approval via IPC. Missing approval must never grant
    // a mutating tool permission implicitly.
    const requestApproval = ctx.requestApproval;
    if (!requestApproval) {
      return { block: true, reason: "Tool approval is unavailable." };
    }
    const r = await requestApproval({
      requestId: randomUUID(),
      toolName,
      input: event.input,
    });
    return r.allow ? undefined : { block: true, reason: r.reason ?? "Denied by user" };
  });
}

/**
 * Register a native `AskUserQuestion` tool. The model calls it autonomously;
 * `execute` bridges to the host's `requestUserInput` IPC (the same one the
 * Claude provider's canUseTool uses), and returns the user's answers as a
 * text tool result the model reads as its reply.
 *
 * This replaces the sentinel-text fallback (model emits
 * `<<<ASK_USER_QUESTION>>>` JSON that the adapter scans for). The native tool
 * is more reliable — no format drift, the model gets a structured result
 * back, and the question panel opens deterministically.
 */
function registerAskUserQuestionTool(pi: ExtensionAPI, ctx: ProviderContext): void {
  pi.registerTool({
    name: "AskUserQuestion",
    label: "Ask User Question",
    description:
      "Ask the user a question when you need information or a decision. " +
      "Provide a clear question and 2-4 options the user can choose from. " +
      "After calling this tool, STOP and wait for the user's answer.",
    promptSnippet: "AskUserQuestion: ask the user a question with selectable options",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          header: Type.String({ description: "A short label for the question" }),
          question: Type.String({ description: "The full question text" }),
          multiSelect: Type.Boolean({
            description: "Whether the user can select multiple options",
          }),
          options: Type.Array(
            Type.Object({
              label: Type.String({ description: "The option label" }),
              description: Type.Optional(
                Type.String({ description: "Why this option, or its consequence" }),
              ),
            }),
          ),
        }),
      ),
    }),
    async execute(toolCallId, params) {
      const requestUserInput = ctx.requestUserInput;
      if (!requestUserInput) {
        throw new Error("User input not available");
      }
      const questions = parseQuestions(params);
      if (questions.length === 0) {
        throw new Error("Malformed AskUserQuestion input: no valid questions");
      }
      const requestId = randomUUID();
      const decision = await requestUserInput({
        requestId,
        toolUseId: toolCallId,
        questions,
      });
      // User closed the question card without answering: throw so the SDK's
      // agent-loop turns it into an error tool result the model can see —
      // the SAME turn continues instead of blocking forever.
      if (decision.dismissed) {
        throw new Error("用户关闭了提问,未提供答案,请继续当前任务");
      }
      return {
        content: [
          { type: "text", text: formatAnswersForModel(decision.answers, questions) },
        ],
        details: {},
      };
    },
  });
}

/**
 * Register the `browser_*` tools that drive the app's embedded browser (the
 * same `BrowserManager` `WebContentsView` the browser panel uses). The actual
 * operations live in `agentBrowserTools.ts` (shared with the Claude provider);
 * here we only define the typebox parameter schemas + bridge screenshots to
 * `ctx.emit` so the renderer can render them inline.
 *
 * Read-only tools (list/snapshot/screenshot) are auto-approved by the
 * `tool_call` guard (see `MARIOCODE_BROWSER_READONLY`); `navigate`/`click` have
 * side effects and go through the normal approval prompt.
 */
function registerBrowserTools(
  pi: ExtensionAPI,
  deps: { ctx: ProviderContext; sessionId: string; projectPath: string; turnNumber?: number; browserBridge: PiBrowserBridge },
): void {
  const { ctx, sessionId, projectPath, turnNumber, browserBridge } = deps;
  const BROWSER_TOOL_SPECS = browserBridge.specs;
  const call = (name: string, args: unknown = {}, meta?: unknown) => browserBridge.invoke(name, args, meta);
  const browserList = () => call("browser_list");
  const browserNavigate = (args: unknown, p: string) => call("browser_navigate", args, { projectPath: p });
  const browserSnapshot = (args: unknown) => call("browser_snapshot", args);
  const browserClick = (args: unknown) => call("browser_click", args);
  const browserType = (args: unknown) => call("browser_type", args);
  const browserKeys = (args: unknown) => call("browser_keys", args);
  const browserScroll = (args: unknown) => call("browser_scroll", args);
  const browserWait = (args: unknown) => call("browser_wait", args);
  const browserHistory = (args: unknown) => call("browser_history", args);
  const browserSelect = (args: unknown) => call("browser_select", args);
  const browserFind = (args: unknown) => call("browser_find", args);
  const browserSwitchTab = (args: unknown) => call("browser_switch_tab", args);
  const browserCloseTab = (args: unknown) => call("browser_close_tab", args);
  const browserUploadFile = (args: unknown, p: string) => call("browser_upload_file", args, { projectPath: p });
  const browserSavePdf = (args: unknown, meta: unknown) => call("browser_save_pdf", args, meta);
  const browserDownloads = () => call("browser_downloads");
  const browserEvaluate = (args: unknown) => call("browser_evaluate", args);
  const browserScreenshot = (args: unknown, meta: unknown) => call("browser_screenshot", args, meta);

  // Convert a shared ToolResult into Pi's execute() return shape. They're
  // structurally identical (content[] + details), so this is effectively an
  // identity — but spelling it out keeps the return type tied to ToolResult's
  // TextBlock|ImageBlock union, which satisfies Pi's (TextContent|ImageContent)[].
  const toPiResult = (r: ToolResult) => ({
    content: r.content,
    details: (r.details ?? {}) as Record<string, unknown>,
  });

  pi.registerTool({
    name: "browser_list",
    label: "Browser List",
    description: BROWSER_TOOL_SPECS.browser_list.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_list.promptSnippet,
    parameters: Type.Object({}),
    async execute() {
      return toPiResult(await browserList());
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: BROWSER_TOOL_SPECS.browser_navigate.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_navigate.promptSnippet,
    parameters: Type.Object({
      url: Type.String({ description: "目标 URL,http(s):// 网页或 file:/// 本地文件" }),
      browserId: Type.Optional(
        Type.String({ description: "目标浏览器视图 id;省略则自动复用当前目标视图或新建" }),
      ),
      device: Type.Optional(
        Type.Union(
          [
            Type.Literal("desktop"),
            Type.Literal("iphone"),
            Type.Literal("android"),
          ],
          { description: "打开方式:desktop(PC 全宽,默认)/iphone(移动端)/android(移动端),仅新建视图时生效" },
        ),
      ),
      newTab: Type.Optional(Type.Boolean({ description: "true=强制新开一个标签页再导航" })),
    }),
    async execute(_toolCallId, params) {
      const { url, browserId, device, newTab } = params as {
        url: string;
        browserId?: string;
        device?: "desktop" | "iphone" | "android";
        newTab?: boolean;
      };
      return toPiResult(await browserNavigate({ url, browserId, device, newTab }, projectPath));
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: BROWSER_TOOL_SPECS.browser_snapshot.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_snapshot.promptSnippet,
    parameters: Type.Object({
      mode: Type.Optional(
        Type.Union([Type.Literal("both"), Type.Literal("interactive"), Type.Literal("text")], {
          description: "both(默认,元素+正文)/ interactive(只要元素)/ text(只要正文,读文章用)",
        }),
      ),
      maxChars: Type.Optional(Type.Number({ description: "正文最多返回多少字,默认 4000,范围 500–20000" })),
      offset: Type.Optional(Type.Number({ description: "从正文第几个字开始读,续读长文时填上次结果末尾给出的值" })),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { browserId, mode, maxChars, offset } = params as {
        browserId?: string;
        mode?: string;
        maxChars?: number;
        offset?: number;
      };
      return toPiResult(await browserSnapshot({ browserId, mode, maxChars, offset }));
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description: BROWSER_TOOL_SPECS.browser_click.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_click.promptSnippet,
    parameters: Type.Object({
      index: Type.Optional(Type.Number({ description: "要点击元素的索引(来自最近一次 browser_snapshot 的 [n]),优先使用" })),
      selector: Type.Optional(Type.String({ description: "要点击元素的 CSS selector(index 的替代写法)" })),
      coordinateX: Type.Optional(Type.Number({ description: "视口坐标点击的 X(canvas 等无 selector 元素用)" })),
      coordinateY: Type.Optional(Type.Number({ description: "视口坐标点击的 Y" })),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { index, selector, coordinateX, coordinateY, browserId } = params as {
        index?: number;
        selector?: string;
        coordinateX?: number;
        coordinateY?: number;
        browserId?: string;
      };
      return toPiResult(await browserClick({ index, selector, coordinateX, coordinateY, browserId }));
    },
  });

  pi.registerTool({
    name: "browser_type",
    label: "Browser Type",
    description: BROWSER_TOOL_SPECS.browser_type.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_type.promptSnippet,
    parameters: Type.Object({
      index: Type.Optional(Type.Number({ description: "目标输入元素的索引(来自最近一次 browser_snapshot),优先使用" })),
      selector: Type.Optional(Type.String({ description: "目标输入元素的 CSS selector(index 的替代写法)" })),
      text: Type.String({ description: "要输入的文本内容;空串=清空字段" }),
      clear: Type.Optional(Type.Boolean({ description: "true(默认)=清空后输入;false=追加" })),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { index, selector, text, clear, browserId } = params as {
        index?: number;
        selector?: string;
        text: string;
        clear?: boolean;
        browserId?: string;
      };
      return toPiResult(await browserType({ index, selector, text, clear, browserId }));
    },
  });

  pi.registerTool({
    name: "browser_keys",
    label: "Browser Keys",
    description: BROWSER_TOOL_SPECS.browser_keys.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_keys.promptSnippet,
    parameters: Type.Object({
      keys: Type.String({ description: '按键或组合键,如 "Enter" / "Escape" / "Control+a" / "Shift+Enter"' }),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { keys, browserId } = params as { keys: string; browserId?: string };
      return toPiResult(await browserKeys({ keys, browserId }));
    },
  });

  pi.registerTool({
    name: "browser_scroll",
    label: "Browser Scroll",
    description: BROWSER_TOOL_SPECS.browser_scroll.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_scroll.promptSnippet,
    parameters: Type.Object({
      direction: Type.Union([Type.Literal("up"), Type.Literal("down")], { description: "滚动方向" }),
      pages: Type.Optional(Type.Number({ description: "滚动量(单位=视口高,默认 1;10≈滚到底)" })),
      selector: Type.Optional(Type.String({ description: "改为滚动该元素内部的滚动区" })),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { direction, pages, selector, browserId } = params as {
        direction: "up" | "down";
        pages?: number;
        selector?: string;
        browserId?: string;
      };
      return toPiResult(await browserScroll({ direction, pages, selector, browserId }));
    },
  });

  pi.registerTool({
    name: "browser_wait",
    label: "Browser Wait",
    description: BROWSER_TOOL_SPECS.browser_wait.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_wait.promptSnippet,
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "等待该 CSS selector 元素出现" })),
      text: Type.Optional(Type.String({ description: "等待该文本出现在页面中" })),
      seconds: Type.Optional(Type.Number({ description: "固定等待秒数" })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "等待超时(默认 10,上限 30)" })),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { selector, text, seconds, timeoutSeconds, browserId } = params as {
        selector?: string;
        text?: string;
        seconds?: number;
        timeoutSeconds?: number;
        browserId?: string;
      };
      return toPiResult(await browserWait({ selector, text, seconds, timeoutSeconds, browserId }));
    },
  });

  pi.registerTool({
    name: "browser_history",
    label: "Browser History",
    description: BROWSER_TOOL_SPECS.browser_history.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_history.promptSnippet,
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("back"), Type.Literal("forward"), Type.Literal("reload")],
        { description: "后退/前进/刷新" },
      ),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { action, browserId } = params as { action: "back" | "forward" | "reload"; browserId?: string };
      return toPiResult(await browserHistory({ action, browserId }));
    },
  });

  pi.registerTool({
    name: "browser_select",
    label: "Browser Select",
    description: BROWSER_TOOL_SPECS.browser_select.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_select.promptSnippet,
    parameters: Type.Object({
      index: Type.Optional(Type.Number({ description: "下拉框元素的索引(来自最近一次 browser_snapshot),优先使用" })),
      selector: Type.Optional(Type.String({ description: "下拉框元素的 CSS selector(index 的替代写法)" })),
      value: Type.String({ description: "选项的 value 或精确可见文本" }),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { index, selector, value, browserId } = params as {
        index?: number;
        selector?: string;
        value: string;
        browserId?: string;
      };
      return toPiResult(await browserSelect({ index, selector, value, browserId }));
    },
  });

  pi.registerTool({
    name: "browser_find",
    label: "Browser Find",
    description: BROWSER_TOOL_SPECS.browser_find.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_find.promptSnippet,
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "按 CSS 查询元素(与 text 二选一)" })),
      text: Type.Optional(Type.String({ description: "在页面文本中搜索(与 selector 二选一)" })),
      regex: Type.Optional(Type.Boolean({ description: "text 按正则解释(默认字面)" })),
      caseSensitive: Type.Optional(Type.Boolean({ description: "区分大小写(默认不区分)" })),
      contextChars: Type.Optional(Type.Number({ description: "文本匹配的上下文字符数(默认 150)" })),
      maxResults: Type.Optional(Type.Number({ description: "最多返回条数(默认 25)" })),
      attributes: Type.Optional(Type.Array(Type.String(), { description: 'selector 模式下要提取的属性,如 ["href","src"]' })),
      cssScope: Type.Optional(Type.String({ description: "把查找范围限定在该 CSS selector 内" })),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { selector, text, regex, caseSensitive, contextChars, maxResults, attributes, cssScope, browserId } =
        params as {
          selector?: string;
          text?: string;
          regex?: boolean;
          caseSensitive?: boolean;
          contextChars?: number;
          maxResults?: number;
          attributes?: string[];
          cssScope?: string;
          browserId?: string;
        };
      return toPiResult(
        await browserFind({ selector, text, regex, caseSensitive, contextChars, maxResults, attributes, cssScope, browserId }),
      );
    },
  });

  pi.registerTool({
    name: "browser_switch_tab",
    label: "Browser Switch Tab",
    description: BROWSER_TOOL_SPECS.browser_switch_tab.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_switch_tab.promptSnippet,
    parameters: Type.Object({
      browserId: Type.String({ description: "要切换到的浏览器视图 id(browser_list 查询)" }),
    }),
    async execute(_toolCallId, params) {
      const { browserId } = params as { browserId: string };
      return toPiResult(await browserSwitchTab({ browserId }));
    },
  });

  pi.registerTool({
    name: "browser_close_tab",
    label: "Browser Close Tab",
    description: BROWSER_TOOL_SPECS.browser_close_tab.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_close_tab.promptSnippet,
    parameters: Type.Object({
      browserId: Type.String({ description: "要关闭的浏览器视图 id" }),
    }),
    async execute(_toolCallId, params) {
      const { browserId } = params as { browserId: string };
      return toPiResult(await browserCloseTab({ browserId }));
    },
  });

  pi.registerTool({
    name: "browser_upload_file",
    label: "Browser Upload File",
    description: BROWSER_TOOL_SPECS.browser_upload_file.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_upload_file.promptSnippet,
    parameters: Type.Object({
      index: Type.Optional(Type.Number({ description: "文件输入框元素的索引(来自最近一次 browser_snapshot),优先使用" })),
      selector: Type.Optional(Type.String({ description: '文件输入框元素的 CSS selector(index 的替代写法)' })),
      paths: Type.Array(Type.String(), { description: "要上传的本地文件路径数组(绝对路径,或相对项目根的路径)" }),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { index, selector, paths, browserId } = params as {
        index?: number;
        selector?: string;
        paths: string[];
        browserId?: string;
      };
      return toPiResult(await browserUploadFile({ index, selector, paths, browserId }, projectPath));
    },
  });

  pi.registerTool({
    name: "browser_save_pdf",
    label: "Browser Save PDF",
    description: BROWSER_TOOL_SPECS.browser_save_pdf.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_save_pdf.promptSnippet,
    parameters: Type.Object({
      fileName: Type.Optional(Type.String({ description: "保存的文件名(不含路径;省略则按时间戳命名)" })),
      paperFormat: Type.Optional(
        Type.Union(
          [
            Type.Literal("letter"),
            Type.Literal("legal"),
            Type.Literal("tabloid"),
            Type.Literal("a3"),
            Type.Literal("a4"),
            Type.Literal("a5"),
          ],
          { description: "纸张格式,默认 a4" },
        ),
      ),
      landscape: Type.Optional(Type.Boolean({ description: "横向(默认纵向)" })),
      printBackground: Type.Optional(Type.Boolean({ description: "是否打印背景色/图(默认 true)" })),
      scale: Type.Optional(Type.Number({ description: "缩放 0.1-2(默认 1)" })),
      headerFooter: Type.Optional(Type.Boolean({ description: "显示页眉页脚(默认 false)" })),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { fileName, paperFormat, landscape, printBackground, scale, headerFooter, browserId } = params as {
        fileName?: string;
        paperFormat?: string;
        landscape?: boolean;
        printBackground?: boolean;
        scale?: number;
        headerFooter?: boolean;
        browserId?: string;
      };
      return toPiResult(
        await browserSavePdf(
          { fileName, paperFormat, landscape, printBackground, scale, headerFooter, browserId },
          { toolCallId: _toolCallId, sessionId, turnNumber },
        ),
      );
    },
  });

  pi.registerTool({
    name: "browser_downloads",
    label: "Browser Downloads",
    description: BROWSER_TOOL_SPECS.browser_downloads.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_downloads.promptSnippet,
    parameters: Type.Object({}),
    async execute() {
      return toPiResult(await browserDownloads());
    },
  });

  pi.registerTool({
    name: "browser_evaluate",
    label: "Browser Evaluate",
    description: BROWSER_TOOL_SPECS.browser_evaluate.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_evaluate.promptSnippet,
    parameters: Type.Object({
      script: Type.String({ description: "要在页面中执行的 JavaScript 代码(可访问 document/window 等页面对象)" }),
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
    }),
    async execute(_toolCallId, params) {
      const { script, browserId } = params as { script: string; browserId?: string };
      return toPiResult(await browserEvaluate({ script, browserId }));
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: BROWSER_TOOL_SPECS.browser_screenshot.description,
    promptSnippet: BROWSER_TOOL_SPECS.browser_screenshot.promptSnippet,
    parameters: Type.Object({
      browserId: Type.Optional(Type.String({ description: "目标浏览器视图 id;省略则用当前目标视图" })),
      fullPage: Type.Optional(Type.Boolean({ description: "true=截整页(含滚动外内容)" })),
    }),
    async execute(toolCallId, params) {
      const { browserId, fullPage } = params as { browserId?: string; fullPage?: boolean };
      const r = await browserScreenshot({ browserId, fullPage }, {
        toolCallId,
        sessionId,
        turnNumber,
        onImage: (info: { toolCallId: string; data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }) => {
          // Emit a structured event so the renderer attaches an inline image
          // block (Pi path). Claude's image surfacing happens via the
          // tool_result content instead.
          ctx.emit({
            type: "browser.image",
            sessionId,
            toolCallId: info.toolCallId,
            data: info.data,
            mimeType: info.mimeType,
          });
        },
      });
      return toPiResult(r);
    },
  });
}

/**
 * Register the built-in web / image tools. Descriptions come from
 * builtinToolSpecs.ts; execution happens main-side over the `builtinTool`
 * reverse channel (the host has no Electron: no hidden windows, no settings
 * or keys). Approval follows builtinToolNeedsApproval in the `tool_call`
 * guard (read-only ones pass, mario_image_generate asks, schedule mutations /
 * WeChat notify ask unless the run is unattended). Labels are the specs' display names. The
 * generated image reaches the tool card through a `browser.image` event that
 * main emits with this call's toolCallId.
 */
function registerBuiltinTools(
  pi: ExtensionAPI,
  deps: { sessionId: string; turnNumber?: number; flags: BuiltinToolFlags; bridge: PiBuiltinBridge },
): void {
  const { sessionId, turnNumber, flags, bridge } = deps;
  const run = async (name: string, toolCallId: string, params: unknown) => {
    const r = await bridge.invoke(name, params, { toolCallId, sessionId, turnNumber });
    return { content: r.content, details: (r.details ?? {}) as Record<string, unknown> };
  };
  if (flags.web) {
    pi.registerTool({
      name: BUILTIN_TOOL_SPECS.mario_web_search.name,
      label: BUILTIN_TOOL_SPECS.mario_web_search.label,
      description: BUILTIN_TOOL_SPECS.mario_web_search.description,
      promptSnippet: BUILTIN_TOOL_SPECS.mario_web_search.promptSnippet,
      parameters: Type.Object({
        query: Type.String({ description: "搜索关键词" }),
        count: Type.Optional(Type.Number({ description: "返回条数,1–10,默认按设置" })),
      }),
      async execute(toolCallId, params) {
        return run(BUILTIN_TOOL_SPECS.mario_web_search.name, toolCallId, params);
      },
    });
    pi.registerTool({
      name: BUILTIN_TOOL_SPECS.mario_web_fetch.name,
      label: BUILTIN_TOOL_SPECS.mario_web_fetch.label,
      description: BUILTIN_TOOL_SPECS.mario_web_fetch.description,
      promptSnippet: BUILTIN_TOOL_SPECS.mario_web_fetch.promptSnippet,
      parameters: Type.Object({
        url: Type.String({ description: "网页地址,http(s)://" }),
        offset: Type.Optional(Type.Number({ description: "从正文第几个字开始读,续读时填上次结果末尾给出的值" })),
        maxChars: Type.Optional(Type.Number({ description: "本次最多返回多少字,1000–20000,默认按设置" })),
        links: Type.Optional(Type.Boolean({ description: "true=保留正文里的链接" })),
      }),
      async execute(toolCallId, params) {
        return run(BUILTIN_TOOL_SPECS.mario_web_fetch.name, toolCallId, params);
      },
    });
  }
  if (flags.image) {
    pi.registerTool({
      name: BUILTIN_TOOL_SPECS.mario_image_generate.name,
      label: BUILTIN_TOOL_SPECS.mario_image_generate.label,
      description: BUILTIN_TOOL_SPECS.mario_image_generate.description,
      promptSnippet: BUILTIN_TOOL_SPECS.mario_image_generate.promptSnippet,
      parameters: Type.Object({
        prompt: Type.String({ description: "图片描述:主体、风格、构图、光线、色调等" }),
        size: Type.Optional(Type.String({ description: "尺寸,如 1024x1024 / 1536x1024 / 1024x1536,省略用设置里的默认值" })),
      }),
      async execute(toolCallId, params) {
        return run(BUILTIN_TOOL_SPECS.mario_image_generate.name, toolCallId, params);
      },
    });
  }
  if (flags.schedule) {
    const kind = Type.Union([Type.Literal("one-time"), Type.Literal("daily"), Type.Literal("weekly")], {
      description: "one-time 一次性 / daily 每天 / weekly 每周",
    });
    const optionalDefinition = {
      timeOfDay: Type.Optional(Type.String({ description: "每天 / 每周任务的时间,\"HH:mm\"(24 小时制)" })),
      weekdays: Type.Optional(Type.Array(Type.Number(), { description: "每周任务的星期,1=周一 … 7=周日" })),
      runAt: Type.Optional(Type.String({ description: "一次性任务的执行时间,带时区偏移的 ISO 时间,如 2026-09-28T09:00:00+08:00" })),
      pushEnabled: Type.Optional(Type.Boolean({ description: "true=任务结束后把结果摘要推送到微信" })),
      projectId: Type.Optional(Type.String({ description: "所属项目 id,省略=当前会话的项目" })),
      providerId: Type.Optional(Type.String({ description: "执行引擎 id(claude-sdk / codex-sdk / pi-sdk),省略=当前会话的引擎" })),
    };
    const nameDesc = { description: "任务名称" };
    const promptDesc = { description: "到点后发给 Agent 的提示词:写成具体的只读 / 检查 / 汇总类指令" };
    const idParam = Type.String({ description: "任务 id(mario_schedule_list 里查)" });
    const specs = BUILTIN_TOOL_SPECS;
    pi.registerTool({
      name: specs.mario_schedule_list.name,
      label: specs.mario_schedule_list.label,
      description: specs.mario_schedule_list.description,
      promptSnippet: specs.mario_schedule_list.promptSnippet,
      parameters: Type.Object({
        projectId: Type.Optional(Type.String({ description: "只看这个项目的任务,省略=全部" })),
      }),
      async execute(toolCallId, params) {
        return run(specs.mario_schedule_list.name, toolCallId, params);
      },
    });
    pi.registerTool({
      name: specs.mario_schedule_create.name,
      label: specs.mario_schedule_create.label,
      description: specs.mario_schedule_create.description,
      promptSnippet: specs.mario_schedule_create.promptSnippet,
      parameters: Type.Object({
        name: Type.String(nameDesc),
        prompt: Type.String(promptDesc),
        scheduleKind: kind,
        ...optionalDefinition,
      }),
      async execute(toolCallId, params) {
        return run(specs.mario_schedule_create.name, toolCallId, params);
      },
    });
    pi.registerTool({
      name: specs.mario_schedule_update.name,
      label: specs.mario_schedule_update.label,
      description: specs.mario_schedule_update.description,
      promptSnippet: specs.mario_schedule_update.promptSnippet,
      parameters: Type.Object({
        id: idParam,
        name: Type.Optional(Type.String(nameDesc)),
        prompt: Type.Optional(Type.String(promptDesc)),
        scheduleKind: Type.Optional(kind),
        ...optionalDefinition,
        enabled: Type.Optional(Type.Boolean({ description: "false=暂停,true=恢复" })),
      }),
      async execute(toolCallId, params) {
        return run(specs.mario_schedule_update.name, toolCallId, params);
      },
    });
    pi.registerTool({
      name: specs.mario_schedule_delete.name,
      label: specs.mario_schedule_delete.label,
      description: specs.mario_schedule_delete.description,
      promptSnippet: specs.mario_schedule_delete.promptSnippet,
      parameters: Type.Object({ id: idParam }),
      async execute(toolCallId, params) {
        return run(specs.mario_schedule_delete.name, toolCallId, params);
      },
    });
  }
  if (flags.wechat) {
    pi.registerTool({
      name: BUILTIN_TOOL_SPECS.mario_wechat_notify.name,
      label: BUILTIN_TOOL_SPECS.mario_wechat_notify.label,
      description: BUILTIN_TOOL_SPECS.mario_wechat_notify.description,
      promptSnippet: BUILTIN_TOOL_SPECS.mario_wechat_notify.promptSnippet,
      parameters: Type.Object({
        text: Type.String({ description: "要发给用户的纯文本消息,简洁" }),
      }),
      async execute(toolCallId, params) {
        return run(BUILTIN_TOOL_SPECS.mario_wechat_notify.name, toolCallId, params);
      },
    });
  }
}

/**
 * Register `EnterPlanMode` and `ExitPlanMode` tools, bridging to the host's
 * plan-mode UI (the same `plan.update` / `mode.change` / `plan.approval_request`
 * RuntimeEvents that Claude's SdkMessageAdapter emits). The frontend plan
 * card system (`PlanStreamBlock` / `PlanViewer` / `PlanApprovalPrompt`) is
 * provider-neutral — it reacts to those events regardless of source, so Pi
 * reuses the entire Claude plan UI with zero renderer changes.
 *
 * ## State tracking
 *
 * `planMode.active` is an in-process boolean (closure-captured), NOT
 * `ctx.getPermissionMode()`. The latter updates via an async IPC round-trip
 * (renderer → updateSettings → setPermissionMode) that races with the next
 * tool_call. The boolean is synchronous: EnterPlanMode sets it before
 * returning, so the tool_call handler's read-only gate (above) is immediately
 * enforced.
 *
 * ## ExitPlanMode blocking
 *
 * ExitPlanMode's `execute` awaits `ctx.requestPlanApproval()` — a Deferred
 * that resolves when the user approves/rejects via the IPC bridge. This blocks
 * the agent loop (verified: `agent-loop.js` awaits `tool.execute`), so the
 * model pauses until the user decides. This is the Pi equivalent of Claude's
 * `canUseTool`/`onUserDialog` blocking on ExitPlanMode.
 */
function registerPlanModeTools(
  pi: ExtensionAPI,
  deps: { ctx: ProviderContext; sessionId: string; planMode: { active: boolean } },
): void {
  const { ctx, sessionId, planMode } = deps;

  pi.registerTool({
    name: "EnterPlanMode",
    label: "Enter Plan Mode",
    description:
      "进入计划模式。在计划模式中你可以进行只读探索(读文件、搜索)来调研问题,也可以写文件/执行命令做验证——" +
      "但每个修改操作都需要用户审批。充分调研后,调用 ExitPlanMode 提交你的执行计划给用户审批。" +
      "适用于复杂任务或涉及重要修改的场景。",
    promptSnippet: "EnterPlanMode: 进入计划模式,调研+验证(写操作需审批),完成后用 ExitPlanMode 提交",
    parameters: Type.Object({}),
    async execute() {
      planMode.active = true;
      // Notify the frontend: sync the composer chip to "plan" + show drafting
      // state in the activity capsule. The plan text is empty (drafting) so no
      // plan card appears yet — only the chip + capsule update.
      ctx.emit({ type: "mode.change", sessionId, mode: "plan", source: "model" });
      ctx.emit({ type: "plan.update", sessionId, plan: "", phase: "drafting" });
      return {
        content: [
          {
            type: "text",
            text: "已进入计划模式。你可以使用 read/grep/find/ls 等只读工具调研,也可以写文件或执行命令做验证(每个修改操作需用户审批)。调研完成后,调用 ExitPlanMode 提交你的计划。",
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "ExitPlanMode",
    label: "Exit Plan Mode",
    description:
      "提交你的执行计划给用户审批。用户可以批准(退出计划模式开始执行)、拒绝(留在计划模式修改计划)或编辑计划内容。" +
      "调用此工具后会暂停等待用户决策。计划应为结构化的 Markdown 文本,包含目标、步骤和影响范围。",
    promptSnippet: "ExitPlanMode({plan}): 提交计划给用户审批,批准后退出计划模式",
    parameters: Type.Object({
      plan: Type.String({ description: "完整的执行计划(Markdown 格式),包含目标、步骤、影响范围" }),
    }),
    async execute(toolCallId, params) {
      const plan = (params as { plan?: string }).plan ?? "";
      // Phase "ready" → the plan card appears in the message stream with the
      // full plan text (PlanStreamBlock renders it as an inline card).
      ctx.emit({ type: "plan.update", sessionId, plan, phase: "ready" });

      try {
        // Bridge to the host's approval UI. This awaits a Deferred that
        // resolves when the user clicks approve/reject in the
        // PlanApprovalPrompt. The agent loop is blocked here (same-turn).
        const requestPlanApproval = ctx.requestPlanApproval;
        if (!requestPlanApproval) {
          // No bridge wired — fail open (exit plan mode without approval).
          planMode.active = false;
          ctx.emit({ type: "mode.change", sessionId, mode: "default", source: "model" });
          return {
            content: [{ type: "text", text: "计划审批不可用,已自动退出计划模式。" }],
            details: {},
          };
        }
        const decision = await requestPlanApproval({
          requestId: randomUUID(),
          plan,
          toolUseId: toolCallId,
        });

        if (decision.approved) {
          const finalPlan = decision.editedPlan ?? plan;
          planMode.active = false;
          // Exit plan mode → the composer chip returns to default, and the
          // tool_call handler's read-only gate is lifted (next write/edit/bash
          // passes through). The plan card stays as a frozen historical card
          // (frontend turn.done freezes ready+nonempty plan blocks).
          ctx.emit({ type: "mode.change", sessionId, mode: "default", source: "model" });
          // The user's adjustment feedback (typed into the approval sheet)
          // rides along in the tool result so the model incorporates it while
          // executing. Without feedback the text stays the stock approval.
          const feedback = decision.feedback?.trim();
          const feedbackText = feedback ? `\n\n用户调整意见:${feedback}` : "";
          return {
            content: [{ type: "text", text: `计划已批准,开始执行:\n\n${finalPlan}${feedbackText}` }],
            details: {},
          };
        }

        // Rejected — stay in plan mode so the model can revise and resubmit.
        // Flip the plan back to "drafting" so the card reflects the ongoing
        // revision cycle (the frontend keeps the card but updates the badge).
        const reason = decision.reason ?? "用户未提供理由";
        ctx.emit({ type: "plan.update", sessionId, plan, phase: "drafting" });
        return {
          content: [
            {
              type: "text",
              text: `计划被用户拒绝。原因:${reason}。你仍处于计划模式,请修改计划后重新调用 ExitPlanMode 提交。`,
            },
          ],
          details: {},
        };
      } catch (err) {
        // Interrupted (user abort / session dispose) — clean up plan mode
        // state so a stale read-only gate doesn't linger. Re-throw so the
        // agent loop records the tool as failed.
        planMode.active = false;
        ctx.emit({ type: "plan.update", sessionId, plan: "", phase: "cleared" });
        ctx.emit({ type: "mode.change", sessionId, mode: "default", source: "model" });
        throw err;
      }
    },
  });
}

/**
 * System-prompt text teaching the model how to use the plan-mode tools.
 * Appended (alongside the AskUserQuestion hint) via `before_agent_start`.
 */
const PLAN_MODE_PROMPT = [
  `## 计划模式工具`,
  `当任务复杂或涉及重要修改时,先制定计划再执行:`,
  `1. 调用 EnterPlanMode 进入计划模式`,
  `2. 使用 read/grep/find/ls 等只读工具充分调研;如需验证可写文件/执行命令,但每个修改操作都需用户审批`,
  `3. 调用 ExitPlanMode({plan: "你的详细计划"}) 提交计划给用户审批`,
  `4. 用户批准后退出计划模式开始执行;拒绝则留在计划模式修改计划`,
  `计划文本应为结构化的 Markdown,包含目标、步骤、影响范围。`,
  `仅当任务复杂、多步或涉及重要修改时才进入计划模式;简单、单步或目标明确的任务直接执行,不要走计划流程。`,
].join("\n");

/**
 * `before_agent_start` handler — injects the MarioCode identity prompt, the
 * AskUserQuestion usage hint and the plan-mode tool usage guide into the
 * system prompt. The event fires each turn before the agent loop starts;
 * returning `systemPrompt` overrides `agent.state.systemPrompt` for the turn.
 *
 * The identity fragment is Pi's own variant (`PI_IDENTITY_PROMPT` — the
 * engine/driver differs from Claude's), co-located with the Claude variant in
 * `@main/lib/systemPrompt`. The AskUserQuestion text is
 * `ASK_NATIVE_TOOL_PROMPT` (use-the-native-tool guidance); Claude's sentinel
 * fallback `ASK_SYSTEM_PROMPT` is NOT injected here — Pi has the native tool,
 * and a "MUST emit this exact text format" instruction would make the model
 * bypass it. Sections are joined via `joinPromptSections` (blank-line
 * separation) shared with the Claude provider to avoid drift.
 */
function registerSystemPromptInjector(
  pi: ExtensionAPI,
  deps: { browserToolsEnabled: boolean; browserUsagePrompt: string; builtinUsagePrompt: string; userSystemPrompt: string },
): void {
  pi.on(
    "before_agent_start",
    async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult | void> => {
      const base = event.systemPrompt ?? "";
      const injected = joinPromptSections(
        PI_IDENTITY_PROMPT,
        ...(deps.userSystemPrompt ? [deps.userSystemPrompt] : []),
        ASK_NATIVE_TOOL_PROMPT,
        PLAN_MODE_PROMPT,
        // Advertise the browser tools only when they are actually registered
        // (MCP panel's built-in switch) — otherwise the model would call
        // tools that don't exist.
        ...(deps.browserToolsEnabled ? [deps.browserUsagePrompt] : []),
        // Empty when no built-in tool is registered this turn.
        deps.builtinUsagePrompt,
      );
      const next = base ? `${base}\n\n${injected}` : injected;
      return { systemPrompt: next };
    },
  );
}
