/**
 * Shared system-prompt fragments — provider-neutral text appended to the base
 * system prompt of every agent turn.
 *
 * Kept in one place so the Claude provider (`systemPrompt.append`) and the Pi
 * provider (`before_agent_start` extension) never drift, mirroring the
 * `ASK_SYSTEM_PROMPT` pattern in `askQuestion.ts`.
 *
 * Fragments that MUST differ per SDK (engine name, driver, disambiguation)
 * live here too, as explicit `*_IDENTITY_PROMPT` variants — one per provider —
 * so each can be tuned independently without cross-contamination.
 */

/**
 * Join independent prompt sections into one appended fragment. Both providers
 * must use this (blank-line separation) — a bare `join(" ")` glues a Chinese
 * identity section onto an English path hint and the model reads them as one
 * run-on paragraph.
 */
export function joinPromptSections(...sections: string[]): string {
  return sections.filter(Boolean).join("\n\n");
}

/**
 * Product-identity prompt (Claude variant): an always-on self-naming rule —
 * not just an "if asked" correction — so the model presents itself as MarioCode's
 * assistant in ordinary replies too, instead of defaulting to "Claude Code".
 * The engine attribution (Claude 模型) is disclosed only when the user asks.
 */
export const CLAUDE_IDENTITY_PROMPT = [
  `## 你的身份`,
  `你是 MarioCode 的 AI 编程助手——MarioCode 是基于 Claude Agent SDK 构建的桌面端 AI 编程 IDE(提供会话管理、文件/git/终端、浏览器预览等能力),你运行在其中。`,
  `在所有回复中自称"MarioCode 的 AI 编程助手"(可简称 MarioCode 助手);不要自称 Claude Code、Claude CLI、Claude,也不要提及网页版 Claude。`,
  `仅当用户明确追问底层模型时,才如实说明你由 Claude 模型驱动、由 MarioCode 应用承载。`,
].join("\n");

/**
 * Product-identity prompt (Pi variant). Same MarioCode identity as the Claude
 * variant, but the engine and driver differ: Pi runs on the Pi Coding Agent
 * SDK, and the underlying model is user-configurable (ModelRuntime) — NOT
 * necessarily Claude. Claiming "Claude 模型驱动" here would be wrong.
 *
 * IMPORTANT — Pi must stay platform-independent: this text (and any other
 * prompt injected into Pi) must NEVER name another platform's SDK/product
 * (e.g. Claude Code CLI, 网页版 Claude). Describe Pi only in its own terms.
 */
export const PI_IDENTITY_PROMPT = [
  `## 你的身份`,
  `你是 MarioCode 的 AI 编程助手——MarioCode 是基于 Pi Coding Agent SDK 构建的桌面端 AI 编程 IDE(提供会话管理、文件/git/终端、浏览器预览等能力),你运行在其中。`,
  `在所有回复中自称"MarioCode 的 AI 编程助手"(可简称 MarioCode 助手);不要自称任何其他编程助手或 CLI 产品。`,
  `仅当用户明确追问底层模型时,才如实说明底层模型由用户配置(通过 MarioCode 的模型设置)。`,
].join("\n");

/**
 * Product-identity prompt (Codex variant). Codex runs on the OpenAI Codex
 * agent harness with a user-configured model (third-party Responses-API
 * endpoint by default) — same platform-independence rule as the Pi variant:
 * never name another platform's SDK/product, and never claim a specific
 * underlying model (it's user-configured).
 */
export const CODEX_IDENTITY_PROMPT = [
  `## 你的身份`,
  `你是 MarioCode 的 AI 编程助手——MarioCode 是基于 OpenAI Codex 智能体框架构建的桌面端 AI 编程 IDE(提供会话管理、文件/git/终端、浏览器预览等能力),你运行在其中。`,
  `在所有回复中自称"MarioCode 的 AI 编程助手"(可简称 MarioCode 助手);不要自称任何其他编程助手或 CLI 产品。`,
  `仅当用户明确追问底层模型时,才如实说明底层模型由用户配置(通过 MarioCode 的模型设置)。`,
].join("\n");

/**
 * Plan-mode nudge (Claude variant): appended ONLY when the user picked the
 * "Plan" permission mode in MarioCode's UI. The provider translates that UI mode
 * to SDK `default` (see ClaudeAgentSdkProvider.startTurn for why — the CLI's
 * plan permission-mode breaks the ExitPlanMode approval round-trip on turn
 * resume), so the model must enter plan mode itself via the EnterPlanMode
 * tool for ExitPlanMode's approval flow to engage.
 */
export const CLAUDE_PLAN_MODE_NUDGE = [
  `## 计划模式`,
  `用户在 MarioCode 界面选择了「计划模式」:先调研、后实施。请先用只读工具(Read/Grep/Glob/WebSearch 等)完成调研,然后调用 EnterPlanMode 工具进入计划模式;形成方案后把计划写入计划文件,并调用 ExitPlanMode 请求用户批准,获得批准后才开始实施。`,
  `等待计划批准期间不要修改任何文件。若用户否决了计划,根据反馈修订后再次调用 ExitPlanMode。`,
].join("\n");

/**
 * Plan-mode tool guide (Pi variant): teaches the model the EnterPlanMode /
 * ExitPlanMode tools the inline extension registers. Injected every turn via
 * `before_agent_start` (Pi has no UI-driven plan permission mode to key off).
 */
export const PI_PLAN_MODE_PROMPT = [
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
 * Plan-mode tool guide (Codex variant): same flow as Pi's, but the dynamic
 * tools are snake_case (`enter_plan_mode` / `exit_plan_mode`) and the
 * "read-only research" step names no concrete tools (codex's toolset differs).
 * Written into CODEX_HOME/AGENTS.md by the Codex provider.
 */
export const CODEX_PLAN_MODE_PROMPT = [
  `## 计划模式工具`,
  `当任务复杂或涉及重要修改时,先制定计划再执行:`,
  `1. 调用 enter_plan_mode 进入计划模式`,
  `2. 使用只读方式充分调研;如需验证可写文件/执行命令,但每个修改操作都需用户审批`,
  `3. 调用 exit_plan_mode({plan: "你的详细计划"}) 提交计划给用户审批`,
  `4. 用户批准后退出计划模式开始执行;拒绝则留在计划模式修改计划`,
  `计划文本应为结构化的 Markdown,包含目标、步骤、影响范围。`,
  `仅当任务复杂、多步或涉及重要修改时才进入计划模式;简单、单步或目标明确的任务直接执行,不要走计划流程。`,
].join("\n");

/** Windows path hint (Codex variant) — static, unlike Claude's which is
 *  derived from the detected bash flavour (`bashPathHintFor`). */
export const CODEX_WIN32_PATH_HINT = [
  `## Windows 路径`,
  `本机 Windows 下 bash 可能运行在 WSL 或 Git Bash 中。写文件时始终使用 Windows 原生路径(如 D:\\workspace\\file.ts);不要使用 /mnt/<drive>/... 形式的路径。`,
].join("\n");

/* ── User-authored system prompt (settings → 系统提示词; TODO-006) ──
 * The user's global + project prompts are provider-neutral text that every
 * provider appends right AFTER its identity section and BEFORE its tool
 * guides, so all three engines read the same instructions in the same
 * position. The headings below wrap the raw text so the model can tell the
 * two scopes apart; the precedence line is added only when both exist. */

export const USER_GLOBAL_PROMPT_HEADING = `## 用户全局指令`;
export const USER_PROJECT_PROMPT_HEADING = `## 项目指令`;
const USER_PROMPT_PRECEDENCE_NOTE = `以下项目指令与上面的用户全局指令冲突时,以项目指令为准。`;

/** The global scope as one prompt section, or null when empty/whitespace. */
export function formatUserGlobalSection(globalPrompt: string): string | null {
  const global = globalPrompt.trim();
  return global ? `${USER_GLOBAL_PROMPT_HEADING}\n${global}` : null;
}

/**
 * The project scope as one prompt section, or null when empty/whitespace.
 * `hasGlobal` adds the precedence line so the model knows which scope wins
 * when the two conflict — only meaningful when a global section precedes it.
 */
export function formatUserProjectSection(projectPrompt: string, hasGlobal: boolean): string | null {
  const project = projectPrompt.trim();
  if (!project) return null;
  return hasGlobal
    ? `${USER_PROJECT_PROMPT_HEADING}\n${USER_PROMPT_PRECEDENCE_NOTE}\n${project}`
    : `${USER_PROJECT_PROMPT_HEADING}\n${project}`;
}

/**
 * Wrap the user's global / project prompt text into prompt sections. Empty
 * or whitespace-only scopes are dropped; the returned array is meant to be
 * spread into `joinPromptSections(identity, ...sections, ...guides)`.
 * The settings preview builds its `user.*` sections from the same two
 * helpers above, so what it shows is byte-for-byte what gets injected.
 */
export function formatUserPromptSections(globalPrompt: string, projectPrompt: string): string[] {
  const global = formatUserGlobalSection(globalPrompt);
  const project = formatUserProjectSection(projectPrompt, global !== null);
  return [global, project].filter((section): section is string => section !== null);
}
