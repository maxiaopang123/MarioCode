/**
 * MarioCode's built-in agent tools — `web_search`, `web_fetch` and
 * `image_generate` — shared by Claude (in-process MCP servers `mcode-web` /
 * `mcode-image`), Codex (dynamicTools) and Pi (`pi.registerTool` in the host,
 * executed main-side over the reverse channel). They don't depend on the
 * model endpoint's own search / image abilities.
 *
 * This module is the single source of the tool descriptions and the prompt
 * section, like BROWSER_TOOL_SPECS for the browser tools: providers only
 * mirror the parameter shapes in their own schema dialect. It must stay free
 * of Electron (and of anything importing it) because the Pi host bundle
 * imports it; the implementations live in the sibling modules.
 *
 * Context budget is the design constraint: search returns titles + links +
 * ≤200-char snippets only, full text comes from web_fetch one page at a time
 * in bounded slices, and images reach the model as one compressed copy.
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
  name: string;
  /** Full tool description shown in the providers' tool registries. */
  description: string;
  /** One-line summary for the system-prompt usage section. */
  promptSnippet: string;
}

export const BUILTIN_TOOL_SPECS = {
  web_search: {
    name: "web_search",
    description:
      `联网搜索网页,返回结果的标题、链接和摘要(每条摘要不超过 ${WEB_SEARCH_SNIPPET_CHARS} 字),不返回网页正文。` +
      `适合查最新信息、官方文档地址、报错原因、版本发布情况等。count 可选(1–${WEB_SEARCH_MAX_RESULTS},默认用设置里的条数)。` +
      "需要某条结果的详细内容时,再用 web_fetch 读取它的链接。只读。",
    promptSnippet: "web_search({query, count?}): 联网搜索,只回标题/链接/摘要",
  },
  web_fetch: {
    name: "web_fetch",
    description:
      "读取网页正文:在后台加载 URL(需要 JS 渲染的页面也能读),提取主内容并转成 Markdown(已去掉导航、侧栏、页脚和广告位),默认返回开头一段;" +
      `没读完时结果末尾会给出 offset,带上它续读下一段(同一网址 30 分钟内走缓存,不会重新加载)。maxChars 调整本次字数(${WEB_FETCH_MIN_CHARS}–${WEB_FETCH_MAX_CHARS});` +
      "links=true 时保留正文里的链接。不能用于搜索引擎结果页(请用 web_search),也不能读本地或内网地址(请用浏览器工具)。只读。",
    promptSnippet: "web_fetch({url, offset?, maxChars?, links?}): 读取网页正文(Markdown),长文按 offset 分段续读",
  },
  image_generate: {
    name: "image_generate",
    description:
      "根据文字描述生成一张图片,调用用户在设置里配置的图片模型——会产生费用,每次调用都要用户审批。" +
      "prompt 写清主体、风格、构图、光线和色调等细节;size 可选,如 1024x1024 / 1536x1024 / 1024x1536(以所配模型支持的尺寸为准)。" +
      "生成的图片会直接显示给用户并保存到本地,结果里带保存路径。",
    promptSnippet: "image_generate({prompt, size?}): 生成图片(会产生费用,需用户审批)",
  },
} satisfies Record<string, BuiltinToolSpec>;

export type BuiltinToolName = keyof typeof BUILTIN_TOOL_SPECS;

export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return Object.prototype.hasOwnProperty.call(BUILTIN_TOOL_SPECS, name);
}

/** Read-only built-in tools: auto-approved in every mode, like the read-only
 *  browser tools. image_generate spends the user's money, so it always goes
 *  through approval (always-allow still applies). */
export const BUILTIN_READONLY_TOOLS: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);

/** Which built-in tools a turn registers: `web` = web_search + web_fetch
 *  (switch on), `image` = image_generate (switch on AND an image model
 *  configured). */
export interface BuiltinToolFlags {
  web: boolean;
  image: boolean;
}

/** Shared flow guidance: Claude's MCP server instructions and the tail of the
 *  prompt section below. */
export const WEB_TOOLS_FLOW =
  "先 web_search 看摘要,只对真正需要的一两条结果调用 web_fetch,不要一次抓很多网页;长文按结果末尾给出的 offset 续读,不要调大 maxChars 一次读完。" +
  "回答里用到网上的信息时附上来源链接。不要用浏览器工具打开搜索引擎代替 web_search。";

/**
 * The system-prompt section teaching the built-in tools, listing only what the
 * turn registered ("" when nothing is). Pi injects it in before_agent_start,
 * Codex writes it into CODEX_HOME/AGENTS.md; the preview panel shows the same
 * text.
 */
export function builtinToolsUsagePrompt(flags: BuiltinToolFlags): string {
  const specs = [
    ...(flags.web ? [BUILTIN_TOOL_SPECS.web_search, BUILTIN_TOOL_SPECS.web_fetch] : []),
    ...(flags.image ? [BUILTIN_TOOL_SPECS.image_generate] : []),
  ];
  if (specs.length === 0) return "";
  return [
    "## 联网与生成工具(MarioCode 内置)",
    ...specs.map((s) => `- ${s.promptSnippet}`),
    ...(flags.web ? [WEB_TOOLS_FLOW] : []),
  ].join("\n");
}
