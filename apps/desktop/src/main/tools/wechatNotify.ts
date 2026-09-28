/**
 * mario_wechat_notify — send one plain-text WeChat message to the bound user
 * through ClawBot. clawBotService.sendText never throws; its three outcomes
 * are mapped to model-facing text that tells the model what the USER has to
 * do (activate / bind) instead of retrying blindly.
 *
 * Rate limit: at most WECHAT_NOTIFY_RATE_MAX accepted sends per session per
 * WECHAT_NOTIFY_RATE_WINDOW_MS (in memory; failed sends don't count) — an
 * agent loop must not be able to spam the user's phone.
 */
import type { ClawBotStatus } from "@contracts/clawbot";
import type { WechatToolStatus } from "@contracts/ipc";
import { WECHAT_NOTIFY_MAX_CHARS, type BuiltinToolResult } from "./builtinToolSpecs.js";

export const WECHAT_NOTIFY_RATE_MAX = 5;
export const WECHAT_NOTIFY_RATE_WINDOW_MS = 10 * 60_000;
const TRUNCATION_MARK = "…(已截断)";
/** Where the user binds / activates ClawBot (settings nav 消息通知 → 微信 ClawBot). */
const CLAWBOT_SETTINGS_PATH = "设置 → 消息通知 → 微信 ClawBot";

const sentAt = new Map<string, number[]>();

function text(t: string): BuiltinToolResult {
  return { content: [{ type: "text", text: t }] };
}
function refusal(t: string): BuiltinToolResult {
  return { content: [{ type: "text", text: `❌ ${t}` }] };
}

/** Trim + cap to WECHAT_NOTIFY_MAX_CHARS (the mark included). Pure. */
export function prepareWechatText(raw: unknown): string {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (t.length <= WECHAT_NOTIFY_MAX_CHARS) return t;
  return t.slice(0, WECHAT_NOTIFY_MAX_CHARS - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}

/** Accepted-send stamps of a session key still inside the window (prunes the rest). */
function recentSends(key: string, now: number): number[] {
  const kept = (sentAt.get(key) ?? []).filter((at) => now - at < WECHAT_NOTIFY_RATE_WINDOW_MS);
  if (kept.length) sentAt.set(key, kept);
  else sentAt.delete(key);
  return kept;
}

/** ClawBot status → the tool's readiness summary (settings page + flags). */
export function wechatToolStatus(status: ClawBotStatus): WechatToolStatus {
  if (status.ready) return "ready";
  if (status.state === "unbound" || status.state === "binding") return "unbound";
  if (status.state === "error") return "error";
  return "needs-interaction";
}

async function clawBot() {
  return (await import("@main/clawbot/ClawBotService.js")).clawBotService;
}

export async function wechatNotify(args: Record<string, unknown>, sessionId: string | undefined): Promise<BuiltinToolResult> {
  const message = prepareWechatText(args.text);
  if (!message) return refusal("text 不能为空");
  const key = sessionId ?? "(no-session)";
  const now = Date.now();
  const recent = recentSends(key, now);
  if (recent.length >= WECHAT_NOTIFY_RATE_MAX) {
    const waitMin = Math.max(1, Math.ceil((WECHAT_NOTIFY_RATE_WINDOW_MS - (now - recent[0]!)) / 60_000));
    return refusal(
      `发送太频繁:本会话 10 分钟内已发 ${WECHAT_NOTIFY_RATE_MAX} 条微信,约 ${waitMin} 分钟后才能再发。请把要说的内容合并,不要刷屏。`,
    );
  }
  const svc = await clawBot();
  const result = await svc.sendText(message);
  if (result.status === "accepted") {
    recent.push(now);
    sentAt.set(key, recent);
    return text(message.endsWith(TRUNCATION_MARK) ? `已发送到微信(内容超过 ${WECHAT_NOTIFY_MAX_CHARS} 字,已截断)` : "已发送到微信");
  }
  if (result.status === "needs-interaction") {
    return refusal("微信推送还没激活:请告诉用户先在微信里给 ClawBot 随便发一条消息,之后才能推送。");
  }
  const status = svc.getStatus();
  if (status.state === "unbound" || status.state === "binding") {
    return refusal(`微信 ClawBot 尚未绑定:请告诉用户到 ${CLAWBOT_SETTINGS_PATH} 扫码绑定后再试。`);
  }
  return refusal(
    `微信发送失败${result.error ? `:${result.error}` : ""}。如果持续失败,请用户到 ${CLAWBOT_SETTINGS_PATH} 检查绑定状态(必要时重新绑定)。`,
  );
}
