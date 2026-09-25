/**
 * Invocation entry for the built-in tools, shared by the Codex dynamic-tool
 * router and the Pi host's reverse channel (Claude's MCP handlers call the
 * tools directly). The switches are re-read on every call: a resumed Codex
 * thread keeps the tool definitions it started with, so a tool switched off
 * since then must still refuse here.
 */
import { builtinToolFlags } from "./builtinToolsConfig.js";
import { imageGenerate, type ImageToolContext } from "./imageGenerate.js";
import { webFetch } from "./webFetch.js";
import { webSearch } from "./webSearch.js";
import type { BuiltinToolResult } from "./builtinToolSpecs.js";

function refusal(msg: string): BuiltinToolResult {
  return { content: [{ type: "text", text: `❌ ${msg}` }] };
}

export async function invokeBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ImageToolContext,
): Promise<BuiltinToolResult> {
  const flags = await builtinToolFlags();
  switch (name) {
    case "web_search":
      return flags.web ? webSearch(args) : refusal("网页搜索已停用(设置 → 内置工具)。");
    case "web_fetch":
      return flags.web ? webFetch(args) : refusal("网页抓取已停用(设置 → 内置工具)。");
    case "image_generate":
      return flags.image ? imageGenerate(args, ctx) : refusal("图片生成已停用或未配置(设置 → 内置工具)。");
    default:
      return refusal(`未知的内置工具:${name}`);
  }
}
