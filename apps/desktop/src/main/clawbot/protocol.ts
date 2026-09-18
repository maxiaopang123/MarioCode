import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ClawBotSendResult, ClawBotState } from "@contracts/clawbot";

export const ILINK_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const ILINK_CHANNEL_VERSION = "2.4.9";
export const ILINK_APP_ID = "bot";
export const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (4 << 8) | 9);

export type QrBindingStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "need_verifycode"
  | "verify_code_blocked"
  | "scaned_but_redirect"
  | "binded_redirect";

export interface QrStatusResponse {
  status: QrBindingStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface ILinkResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export function buildBaseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: ILINK_CHANNEL_VERSION, bot_agent: "MarioCode/0.1" };
}

/** Headers used by the unauthenticated QR-status GET endpoint. */
export function buildIlinkCommonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
  };
}

export function buildIlinkHeaders(token?: string, randomUin?: number): Record<string, string> {
  const uin = randomUin ?? randomBytes(4).readUInt32BE(0);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(uin), "utf8").toString("base64"),
    ...buildIlinkCommonHeaders(),
  };
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

/** Monotonic identity used to reject late results from superseded QR polls. */
export class BindingEpoch {
  private value = 0;

  begin(): number { return ++this.value; }
  cancel(): void { this.value++; }
  isCurrent(epoch: number): boolean { return epoch === this.value; }
}

export function buildSendTextBody(
  toUserId: string,
  text: string,
  contextToken: string,
  clientId = `mariocode-${randomUUID()}`,
): Record<string, unknown> {
  return {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
    base_info: buildBaseInfo(),
  };
}

/**
 * Resolve an iLink business result without inventing success.
 *
 * The 2.4.9 protocol defines `ret: 0` as success; `errcode` is an optional
 * error discriminator (not a standalone success acknowledgement). Therefore
 * a missing `ret` — including `{}` and `{ errcode: 0 }` — is malformed.
 */
export function responseCode(response: ILinkResponse): number | null {
  if (typeof response.errcode === "number" && response.errcode !== 0) return response.errcode;
  return typeof response.ret === "number" ? response.ret : null;
}

export function classifySendResponse(response: ILinkResponse): ClawBotSendResult {
  const code = responseCode(response);
  if (code === null) {
    return { status: "failed", error: "微信接口返回了无效的业务响应。" };
  }
  if (code === 0) return { status: "accepted", error: null };
  if (code === -2) {
    return { status: "needs-interaction", error: "微信会话上下文已失效，请先向 ClawBot 发送一条消息。" };
  }
  if (code === -14) {
    return { status: "failed", error: "ClawBot 登录凭证已失效，请重新扫码绑定。" };
  }
  return {
    status: "failed",
    // Do not forward an upstream diagnostic string across IPC. Some gateways
    // echo request fragments in errmsg; exposing it could disclose a token.
    error: `微信接口拒绝请求（${code}）。`,
  };
}

export function isQrStatus(value: unknown): value is QrBindingStatus {
  return [
    "wait", "scaned", "confirmed", "expired", "need_verifycode",
    "verify_code_blocked", "scaned_but_redirect", "binded_redirect",
  ].includes(String(value));
}

export function resolveStoredBindingState(hasToken: boolean, hasContext: boolean): ClawBotState {
  if (!hasToken) return "unbound";
  return hasContext ? "bound" : "needs-interaction";
}

/** Revalidate persisted metadata at every token-bearing request boundary. */
export function normalizeTrustedApiBase(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("ClawBot API 地址必须使用 HTTPS。");
  }
  if (host !== "weixin.qq.com" && !host.endsWith(".weixin.qq.com")) {
    throw new Error("ClawBot API 地址不属于受信任的微信域名。");
  }
  return url.origin;
}

export interface InboundContextCandidate {
  from_user_id?: string;
  context_token?: string;
}

export interface ILinkMessageItem {
  id?: string | number | bigint;
  item_id?: string | number | bigint;
  type?: number;
  text_item?: { text?: string };
  [key: string]: unknown;
}

/** Wire shape observed across current iLink getupdates lanes. */
export interface ILinkInboundMessage extends InboundContextCandidate {
  message_id?: string | number | bigint;
  msg_id?: string | number | bigint;
  client_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  message_type?: number;
  message_state?: number;
  create_time_ms?: string | number;
  item_list?: ILinkMessageItem[];
  room_id?: string;
  group_id?: string;
  chat_type?: string | number;
  deleted?: boolean;
  is_deleted?: boolean;
  [key: string]: unknown;
}

export interface UpdatesResponse extends ILinkResponse {
  msgs?: ILinkInboundMessage[];
  messages?: ILinkInboundMessage[];
  Msgs?: ILinkInboundMessage[];
  get_updates_buf?: string;
  next_key?: string;
  longpolling_timeout_ms?: number;
}

export interface ClawBotInboundEvent {
  accountId: string;
  conversationKey: string;
  messageId: string;
  text: string;
  receivedAt: number;
  replyContextRef: string;
}

export interface NormalizedInbound {
  event: ClawBotInboundEvent;
  senderId: string;
  contextToken: string;
}

function wireId(value: unknown): string {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function stableFallbackId(message: ILinkInboundMessage, text: string): string {
  const canonical = JSON.stringify({
    from: message.from_user_id ?? "",
    to: message.to_user_id ?? "",
    created: message.create_time_ms ?? "",
    client: message.client_id ?? "",
    text,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function isDirectMessage(message: ILinkInboundMessage): boolean {
  const sender = message.from_user_id?.trim() ?? "";
  if (sender.endsWith("@chatroom") || message.room_id || message.group_id) return false;
  if (message.chat_type !== undefined && ![1, "1", "single", "direct", "private"].includes(message.chat_type)) return false;
  return true;
}

/** Normalize only completed owner DMs containing plain text and no tool/media item. */
export function normalizeOwnerInbound(
  message: ILinkInboundMessage,
  ownerUserId: string,
  accountId: string,
): NormalizedInbound | null {
  const senderId = message.from_user_id?.trim() ?? "";
  const contextToken = message.context_token?.trim() ?? "";
  if (!senderId || !contextToken || senderId !== ownerUserId) return null;
  if (message.message_type !== 1 || message.message_state !== 2 || !isDirectMessage(message)) return null;
  if (message.deleted || message.is_deleted) return null;
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  if (items.length === 0 || items.some((item) => item.type !== 1 || typeof item.text_item?.text !== "string")) return null;
  const text = items.map((item) => item.text_item!.text!).join("").trim();
  if (!text) return null;
  const topLevelId = wireId(message.message_id) || wireId(message.msg_id);
  const itemId = items.map((item) => wireId(item.item_id) || wireId(item.id)).find(Boolean) ?? "";
  const messageId = topLevelId || itemId || stableFallbackId(message, text);
  const parsedTime = Number(message.create_time_ms);
  const conversationKey = createHash("sha256").update(accountId).update("\0").update(senderId).digest("hex");
  const replyContextRef = `rc_${createHash("sha256").update(accountId).update("\0").update(messageId).digest("hex")}`;
  return {
    event: {
      accountId,
      conversationKey,
      messageId,
      text,
      receivedAt: Number.isFinite(parsedTime) && parsedTime > 0 ? parsedTime : Date.now(),
      replyContextRef,
    },
    senderId,
    contextToken,
  };
}

export function readUpdatesMessages(response: UpdatesResponse): ILinkInboundMessage[] {
  if (Array.isArray(response.msgs)) return response.msgs;
  if (Array.isArray(response.messages)) return response.messages;
  return Array.isArray(response.Msgs) ? response.Msgs : [];
}

export function readUpdatesCursor(response: UpdatesResponse): string | null {
  const cursor = response.get_updates_buf ?? response.next_key;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}

/** The acknowledgement callback is deliberately after the awaited batch sink. */
export async function deliverInboundBatch(
  events: readonly ClawBotInboundEvent[],
  sink: ((batch: readonly ClawBotInboundEvent[]) => Promise<void>) | null,
  acknowledge: () => void,
): Promise<void> {
  if (events.length > 0) {
    if (!sink) throw new Error("ClawBot 入站处理器尚未注册。");
    await sink(events);
  }
  acknowledge();
}

export interface OwnerContextSelection {
  userId: string;
  contextToken: string;
  matched: boolean;
}

/**
 * Select context only for the bound owner. With no owner, the first valid
 * inbound sender becomes the immutable target; other senders in the same or
 * later batches cannot hijack scheduled-task notifications.
 */
export function selectOwnerContext(
  ownerUserId: string,
  currentContextToken: string,
  messages: readonly InboundContextCandidate[],
): OwnerContextSelection {
  let userId = ownerUserId;
  let contextToken = currentContextToken;
  let matched = false;
  for (const message of messages) {
    const sender = message.from_user_id?.trim();
    const context = message.context_token?.trim();
    if (!sender || !context) continue;
    if (!userId) userId = sender;
    if (sender !== userId) continue;
    contextToken = context;
    matched = true;
  }
  return { userId, contextToken, matched };
}
