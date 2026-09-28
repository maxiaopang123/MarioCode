/**
 * Display names for MarioCode's built-in tools (MarioTool). The model-facing
 * ids live in main/tools/builtinToolSpecs.ts and main/browser/agentBrowserTools.ts
 * (the renderer can't import main); this mirrors the ids + `label`s there.
 * Codex / Pi report the bare id, Claude the MCP-qualified one
 * (`mcp__mcode-web__…` / `mcp__mcode-image__…` / `mcp__mcode-browser__…`).
 * The names are product names, so they aren't localized.
 */

/** Claude MCP server name per built-in tool id. */
const MARIO_TOOLS: { id: string; server: string; label: string }[] = [
  { id: "mario_web_search", server: "mcode-web", label: "Mario Web 搜索器" },
  { id: "mario_web_fetch", server: "mcode-web", label: "Mario Web 阅读器" },
  { id: "mario_image_generate", server: "mcode-image", label: "Mario 图片生成器" },
  { id: "mario_schedule_list", server: "mcode-schedule", label: "Mario 定时器 · 查看" },
  { id: "mario_schedule_create", server: "mcode-schedule", label: "Mario 定时器 · 创建" },
  { id: "mario_schedule_update", server: "mcode-schedule", label: "Mario 定时器 · 修改" },
  { id: "mario_schedule_delete", server: "mcode-schedule", label: "Mario 定时器 · 删除" },
  { id: "mario_wechat_notify", server: "mcode-wechat", label: "Mario 微信通知" },
];

/** Agent browser tools (BROWSER_TOOL_SPECS) → action name, shown as
 *  "Mario 浏览器 · <动作>". Ids are unchanged model-facing names. */
const BROWSER_ACTIONS: Record<string, string> = {
  browser_navigate: "打开网页",
  browser_history: "后退/前进/刷新",
  browser_list: "列出标签页",
  browser_switch_tab: "切换标签页",
  browser_close_tab: "关闭标签页",
  browser_snapshot: "读取页面",
  browser_find: "页面查找",
  browser_screenshot: "截图",
  browser_click: "点击",
  browser_type: "输入",
  browser_keys: "按键",
  browser_select: "选择",
  browser_scroll: "滚动",
  browser_wait: "等待",
  browser_evaluate: "执行脚本",
  browser_upload_file: "上传文件",
  browser_downloads: "下载列表",
  browser_save_pdf: "保存 PDF",
};

const BUILTIN_TOOL_LABELS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  const add = (id: string, server: string, label: string) => {
    map[id] = label;
    map[`mcp__${server}__${id}`] = label;
  };
  for (const tool of MARIO_TOOLS) add(tool.id, tool.server, tool.label);
  for (const [id, action] of Object.entries(BROWSER_ACTIONS)) add(id, "mcode-browser", `Mario 浏览器 · ${action}`);
  return map;
})();

/** The name to show on a tool card: the built-in tools' display name, any
 *  other tool's raw name unchanged. */
export function toolDisplayName(name: string): string {
  return BUILTIN_TOOL_LABELS[name] ?? name;
}
