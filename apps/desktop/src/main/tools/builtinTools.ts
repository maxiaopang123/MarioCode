/**
 * Invocation entry for the built-in tools, shared by the Codex dynamic-tool
 * router and the Pi host's reverse channel (Claude's MCP handlers call it
 * too for the schedule / WeChat tools). The switches are re-read on every
 * call: a resumed Codex thread keeps the tool definitions it started with,
 * so a tool switched off since then must still refuse here.
 */
import { builtinToolFlags } from "./builtinToolsConfig.js";
import { imageGenerate, type ImageToolContext } from "./imageGenerate.js";
import { webFetch } from "./webFetch.js";
import { webSearch } from "./webSearch.js";
import { runScheduleTool } from "./scheduleTools.js";
import { wechatNotify } from "./wechatNotify.js";
import { BUILTIN_TOOL_SPECS, type BuiltinToolResult } from "./builtinToolSpecs.js";

function refusal(msg: string): BuiltinToolResult {
  return { content: [{ type: "text", text: `❌ ${msg}` }] };
}

const SCHEDULE_OFF = "定时任务工具已停用(设置 → MarioTool)。";
const WECHAT_OFF = "微信通知工具已停用,或微信 ClawBot 从未绑定(设置 → MarioTool / 设置 → 消息通知 → 微信 ClawBot)。";

export async function invokeBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ImageToolContext,
): Promise<BuiltinToolResult> {
  const flags = await builtinToolFlags();
  switch (name) {
    case BUILTIN_TOOL_SPECS.mario_web_search.name:
      return flags.web
        ? webSearch(args)
        : refusal(`${BUILTIN_TOOL_SPECS.mario_web_search.name}(网页搜索)已停用(设置 → MarioTool)。`);
    case BUILTIN_TOOL_SPECS.mario_web_fetch.name:
      return flags.web
        ? webFetch(args)
        : refusal(`${BUILTIN_TOOL_SPECS.mario_web_fetch.name}(网页抓取)已停用(设置 → MarioTool)。`);
    case BUILTIN_TOOL_SPECS.mario_image_generate.name:
      return flags.image
        ? imageGenerate(args, ctx)
        : refusal(`${BUILTIN_TOOL_SPECS.mario_image_generate.name}(图片生成)已停用或未配置(设置 → MarioTool)。`);
    case BUILTIN_TOOL_SPECS.mario_schedule_list.name:
      return flags.schedule ? runScheduleTool("list", args, ctx.sessionId) : refusal(SCHEDULE_OFF);
    case BUILTIN_TOOL_SPECS.mario_schedule_create.name:
      return flags.schedule ? runScheduleTool("create", args, ctx.sessionId) : refusal(SCHEDULE_OFF);
    case BUILTIN_TOOL_SPECS.mario_schedule_update.name:
      return flags.schedule ? runScheduleTool("update", args, ctx.sessionId) : refusal(SCHEDULE_OFF);
    case BUILTIN_TOOL_SPECS.mario_schedule_delete.name:
      return flags.schedule ? runScheduleTool("delete", args, ctx.sessionId) : refusal(SCHEDULE_OFF);
    case BUILTIN_TOOL_SPECS.mario_wechat_notify.name:
      return flags.wechat ? wechatNotify(args, ctx.sessionId) : refusal(WECHAT_OFF);
    default:
      return refusal(`未知的 MarioTool 工具:${name}`);
  }
}
