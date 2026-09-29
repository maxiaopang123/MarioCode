/**
 * MarioCode's built-in agent tools (MarioTool) — `mario_web_search`,
 * `mario_web_fetch`, `mario_image_generate`, `mario_schedule_*` and
 * `mario_wechat_notify` — shared by Claude (in-process MCP servers
 * `mariocode-web` / `mariocode-image` / `mariocode-schedule` / `mariocode-wechat`), Codex (dynamicTools) and Pi
 * (`pi.registerTool` in the host, executed main-side over the reverse
 * channel). They don't depend on the model endpoint's own search / image
 * abilities.
 *
 * This module is the single source of the tool names, display names,
 * descriptions and the prompt section, like BROWSER_TOOL_SPECS for the
 * browser tools: providers only mirror the parameter shapes in their own
 * schema dialect. It must stay free of Electron (and of anything importing
 * it) because the Pi host bundle imports it; the implementations live in the
 * sibling modules.
 *
 * Context budget is the design constraint: search returns titles + links +
 * ≤200-char snippets only, full text comes from mario_web_fetch one page at a
 * time in bounded slices, and images reach the model as one compressed copy.
 */

/** Hard ceilings on what the model may ask for per call. */
export const WEB_SEARCH_MAX_RESULTS = 10;
export const WEB_SEARCH_SNIPPET_CHARS = 200;
export const WEB_FETCH_MIN_CHARS = 1000;
export const WEB_FETCH_MAX_CHARS = 20000;

/** A text content block (MCP TextContent's minimal shape). */
export interface BuiltinTextBlock {
  type: "text";
  text: string;
}

/** An image content block (MCP ImageContent). `data` is base64. */
export interface BuiltinImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

/** Provider-neutral result, returned verbatim by every provider (same
 *  contract as the browser tools' ToolResult; a type alias so it keeps the
 *  implicit index signature the Claude SDK's CallToolResult needs). */
export type BuiltinToolResult = {
  content: Array<BuiltinTextBlock | BuiltinImageBlock>;
  details?: Record<string, unknown>;
  [k: string]: unknown;
};

export interface BuiltinToolSpec {
  /** Model-facing tool id. */
  name: string;
  /** Display name (product name) shown on tool cards / Pi's tool label. */
  label: string;
  /** Full tool description shown in the providers' tool registries. */
  description: string;
  /** One-line summary for the system-prompt usage section. */
  promptSnippet: string;
}

/** Model-facing ids, kept as constants so descriptions can cross-reference
 *  each other without a self-referencing object literal. */
const SEARCH = "mario_web_search";
const FETCH = "mario_web_fetch";
const IMAGE = "mario_image_generate";
const SCHEDULE_LIST = "mario_schedule_list";
const SCHEDULE_CREATE = "mario_schedule_create";
const SCHEDULE_UPDATE = "mario_schedule_update";
const SCHEDULE_DELETE = "mario_schedule_delete";
const WECHAT_NOTIFY = "mario_wechat_notify";

/** mario_wechat_notify's text ceiling (longer text is truncated). */
export const WECHAT_NOTIFY_MAX_CHARS = 1800;

export const BUILTIN_TOOL_SPECS = {
  mario_web_search: {
    name: SEARCH,
    label: "Mario Web 搜索器",
    description:
      `联网搜索网页,返回结果的标题、链接和摘要(每条摘要不超过 ${WEB_SEARCH_SNIPPET_CHARS} 字),不返回网页正文。` +
      `适合查最新信息、官方文档地址、报错原因、版本发布情况等。count 可选(1–${WEB_SEARCH_MAX_RESULTS},默认用设置里的条数)。` +
      `需要某条结果的详细内容时,再用 ${FETCH} 读取它的链接。` +
      "由 MarioCode 在本机执行,不依赖模型端点:引擎自带的搜索工具不可用、报错或没有结果时,用它顶上。只读。",
    promptSnippet: `${SEARCH}({query, count?}): 联网搜索,只回标题/链接/摘要(自带搜索不可用时用它)`,
  },
  mario_web_fetch: {
    name: FETCH,
    label: "Mario Web 阅读器",
    description:
      "读取网页正文:在后台加载 URL(需要 JS 渲染的页面也能读),提取主内容并转成 Markdown(已去掉导航、侧栏、页脚和广告位),默认返回开头一段;" +
      `没读完时结果末尾会给出 offset,带上它续读下一段(同一网址 30 分钟内走缓存,不会重新加载)。maxChars 调整本次字数(${WEB_FETCH_MIN_CHARS}–${WEB_FETCH_MAX_CHARS});` +
      `links=true 时保留正文里的链接。不能用于搜索引擎结果页(请用 ${SEARCH}),也不能读本地或内网地址(请用浏览器工具)。` +
      "由 MarioCode 在本机执行,不依赖模型端点:引擎自带的网页读取工具不可用或失败时,用它顶上。只读。",
    promptSnippet: `${FETCH}({url, offset?, maxChars?, links?}): 读取网页正文(Markdown),长文按 offset 分段续读`,
  },
  mario_image_generate: {
    name: IMAGE,
    label: "Mario 图片生成器",
    description:
      "根据文字描述生成一张图片,调用用户在设置里配置的图片模型——会产生费用,每次调用都要用户审批。" +
      "prompt 写清主体、风格、构图、光线和色调等细节;size 可选,如 1024x1024 / 1536x1024 / 1024x1536(以所配模型支持的尺寸为准)。" +
      "生成的图片会直接显示给用户并保存到本地,结果里带保存路径。" +
      "回复里要把图片放在说明文字旁边(比如逐张点评、对比多张)时,用 Markdown `![简短名称](结果里的保存路径)` 引用,路径原样照抄;几张连着写会排成一组。只是提到文件时直接写路径即可。",
    promptSnippet: `${IMAGE}({prompt, size?}): 生成图片(会产生费用,需用户审批);回复里用 ![名称](保存路径) 把图放进正文`,
  },
  mario_schedule_list: {
    name: SCHEDULE_LIST,
    label: "Mario 定时器 · 查看",
    description:
      "列出 MarioCode 里的定时任务:先给出当前本地时间(带时区偏移),再逐条列出 id、名称、所属项目、引擎、执行时间、是否启用、是否推送微信、下次执行时间和上次结果。" +
      `projectId 可选,只看某个项目的任务。创建一次性任务前先调它看当前时间;修改 / 删除前先调它拿到任务 id。只读。`,
    promptSnippet: `${SCHEDULE_LIST}({projectId?}): 查看定时任务和当前时间(只读)`,
  },
  mario_schedule_create: {
    name: SCHEDULE_CREATE,
    label: "Mario 定时器 · 创建",
    description:
      "创建一个定时任务:到点后 MarioCode 会在指定项目里新开一个会话、用指定引擎执行 prompt。" +
      "scheduleKind = daily(每天,需 timeOfDay \"HH:mm\")/ weekly(每周,需 timeOfDay 和 weekdays,1=周一 … 7=周日)/ one-time(一次性,需 runAt,带时区偏移的 ISO 时间如 2026-09-28T09:00:00+08:00)。" +
      "projectId / providerId 省略时用当前会话的项目和引擎;pushEnabled=true 时任务结束会把结果摘要推送到用户微信。" +
      "任务在无人值守下以普通权限运行,遇到需要审批的操作会自动停止,所以 prompt 要写成具体的只读 / 检查 / 汇总类指令。需要用户审批。",
    promptSnippet: `${SCHEDULE_CREATE}({name, prompt, scheduleKind, timeOfDay?, weekdays?, runAt?, pushEnabled?, projectId?, providerId?}): 创建定时任务(需用户审批)`,
  },
  mario_schedule_update: {
    name: SCHEDULE_UPDATE,
    label: "Mario 定时器 · 修改",
    description:
      `修改一个定时任务:id 必填(先用 ${SCHEDULE_LIST} 查),其余字段只传要改的(name / prompt / scheduleKind / timeOfDay / weekdays / runAt / pushEnabled / enabled / projectId / providerId),没传的保持原值。` +
      "enabled=false 暂停任务、true 恢复。运行中的任务不能修改。需要用户审批。",
    promptSnippet: `${SCHEDULE_UPDATE}({id, ...要改的字段}): 修改 / 暂停 / 恢复定时任务(需用户审批)`,
  },
  mario_schedule_delete: {
    name: SCHEDULE_DELETE,
    label: "Mario 定时器 · 删除",
    description: `删除一个定时任务(不可恢复;只想暂停请用 ${SCHEDULE_UPDATE} 设 enabled=false)。id 先用 ${SCHEDULE_LIST} 查。运行中的任务不能删除。需要用户审批。`,
    promptSnippet: `${SCHEDULE_DELETE}({id}): 删除定时任务(需用户审批)`,
  },
  mario_wechat_notify: {
    name: WECHAT_NOTIFY,
    label: "Mario 微信通知",
    description:
      `通过用户绑定的微信 ClawBot 给用户本人发一条纯文本消息(最多 ${WECHAT_NOTIFY_MAX_CHARS} 字,超出会被截断)。` +
      "适合汇报定时任务结果、长任务完成提醒等。内容简洁,不要刷屏;每个会话 10 分钟内最多发 5 条。",
    promptSnippet: `${WECHAT_NOTIFY}({text}): 给用户发一条微信消息(纯文本,简洁)`,
  },
} satisfies Record<string, BuiltinToolSpec>;

export type BuiltinToolName = keyof typeof BUILTIN_TOOL_SPECS;

export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return Object.prototype.hasOwnProperty.call(BUILTIN_TOOL_SPECS, name);
}

/** Read-only built-in tools: auto-approved in every mode, like the read-only
 *  browser tools. mario_image_generate spends the user's money, so it always
 *  goes through approval (always-allow still applies). */
export const BUILTIN_READONLY_TOOLS: ReadonlySet<string> = new Set([
  BUILTIN_TOOL_SPECS.mario_web_search.name,
  BUILTIN_TOOL_SPECS.mario_web_fetch.name,
  BUILTIN_TOOL_SPECS.mario_schedule_list.name,
]);

/** Tools that create / change / delete scheduled tasks. */
export const BUILTIN_SCHEDULE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  BUILTIN_TOOL_SPECS.mario_schedule_create.name,
  BUILTIN_TOOL_SPECS.mario_schedule_update.name,
  BUILTIN_TOOL_SPECS.mario_schedule_delete.name,
]);

/**
 * Approval policy of the built-in tools, shared by the three engines'
 * permission gates (Claude canUseTool, Codex invokeDynamicTool, Pi tool_call).
 * `false` = run without asking; `true` = the engine's normal approval flow
 * (permission mode / always-allow still apply there).
 *
 * `unattended` = the turn is a scheduled-task run or a ClawBot DM turn, where
 * any approval request cancels the whole run instead of reaching a human:
 *  - read-only tools (web search / fetch, schedule list) → never ask;
 *  - mario_image_generate → always asks (spends money; an unattended run
 *    stops there, which is the intended outcome);
 *  - mario_schedule_create / update / delete → ask when interactive; when
 *    unattended they don't ask because their execute() REFUSES (an unattended
 *    run must not reprogram the scheduler) — asking would cancel the run
 *    instead of returning that refusal to the model;
 *  - mario_wechat_notify → ask when interactive (always-allow works as
 *    usual); unattended runs push results without asking — that's the point.
 * Unknown names → true (fail closed).
 */
export function builtinToolNeedsApproval(name: string, unattended: boolean): boolean {
  if (BUILTIN_READONLY_TOOLS.has(name)) return false;
  if (name === IMAGE) return true;
  if (BUILTIN_SCHEDULE_MUTATING_TOOLS.has(name)) return !unattended;
  if (name === WECHAT_NOTIFY) return !unattended;
  return true;
}

/** Which built-in tools a turn registers: `web` = mario_web_search +
 *  mario_web_fetch (switch on), `image` = mario_image_generate (switch on AND
 *  an image model configured), `schedule` = mario_schedule_* (switch on),
 *  `wechat` = mario_wechat_notify (switch on AND ClawBot bound at least once;
 *  readiness is re-checked per call). */
export interface BuiltinToolFlags {
  web: boolean;
  image: boolean;
  schedule: boolean;
  wechat: boolean;
}

/** All built-in tools off (fallbacks / hosts without the bridge). */
export const NO_BUILTIN_TOOLS: BuiltinToolFlags = { web: false, image: false, schedule: false, wechat: false };

/** Shared flow guidance: Claude's MCP server instructions and the tail of the
 *  prompt section below. The engine's own WebSearch / WebFetch keep their
 *  native names. */
export const WEB_TOOLS_FLOW =
  "与引擎自带联网工具的分工:如果你还有引擎自带的搜索 / 网页读取工具(如 WebSearch、WebFetch),可以先用它们;" +
  `自带工具不存在、报错、返回空结果或明显不可用(很多第三方模型端点不支持)时,改用这里的 ${SEARCH} / ${FETCH} 顶上,不要放弃搜索、也不要凭记忆作答。` +
  `使用 MarioTool 时:先 ${SEARCH} 看摘要,只对真正需要的一两条结果调用 ${FETCH},不要一次抓很多网页;长文按结果末尾给出的 offset 续读,不要调大 maxChars 一次读完。` +
  `回答里用到网上的信息时附上来源链接。不要用浏览器工具打开搜索引擎代替 ${SEARCH}。`;

/** Scheduled-task flow guidance (prompt section + mariocode-schedule instructions). */
export const SCHEDULE_FLOW =
  `定时任务:用户要求"定期 / 每天 / 每周 / 某个时间"做某事时用 ${SCHEDULE_CREATE};` +
  "任务会在无人值守下以普通权限运行,遇到需要审批的操作会自动停止,所以任务提示词应写成只读 / 检查 / 汇总类的具体指令;" +
  `需要把结果发给用户时设 pushEnabled=true(任务结束自动推送摘要)或在任务提示词里要求调用 ${WECHAT_NOTIFY};` +
  `runAt 用带时区偏移的 ISO 时间(先调 ${SCHEDULE_LIST} 看当前时间);修改 / 删除前先 ${SCHEDULE_LIST} 拿到 id。` +
  "无人值守运行中不能创建、修改或删除定时任务。";

/** WeChat-notify guidance (prompt section + mariocode-wechat instructions). */
export const WECHAT_FLOW =
  `微信通知:仅在用户要求或定时任务需要汇报时调用 ${WECHAT_NOTIFY},内容简洁,不要刷屏。`;

/**
 * The system-prompt section teaching the built-in tools, listing only what the
 * turn registered ("" when nothing is). Pi injects it in before_agent_start,
 * Codex writes it into CODEX_HOME/AGENTS.md; the preview panel shows the same
 * text.
 */
export function builtinToolsUsagePrompt(flags: BuiltinToolFlags): string {
  const specs = [
    ...(flags.web ? [BUILTIN_TOOL_SPECS.mario_web_search, BUILTIN_TOOL_SPECS.mario_web_fetch] : []),
    ...(flags.image ? [BUILTIN_TOOL_SPECS.mario_image_generate] : []),
    ...(flags.schedule
      ? [
          BUILTIN_TOOL_SPECS.mario_schedule_list,
          BUILTIN_TOOL_SPECS.mario_schedule_create,
          BUILTIN_TOOL_SPECS.mario_schedule_update,
          BUILTIN_TOOL_SPECS.mario_schedule_delete,
        ]
      : []),
    ...(flags.wechat ? [BUILTIN_TOOL_SPECS.mario_wechat_notify] : []),
  ];
  if (specs.length === 0) return "";
  return [
    "## MarioTool(MarioCode 内置的联网、生成、定时与通知工具)",
    ...specs.map((s) => `- ${s.promptSnippet}`),
    ...(flags.web ? [WEB_TOOLS_FLOW] : []),
    ...(flags.schedule ? [SCHEDULE_FLOW] : []),
    ...(flags.wechat ? [WECHAT_FLOW] : []),
  ].join("\n");
}
