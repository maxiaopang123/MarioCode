import { randomBytes, randomUUID } from "node:crypto";
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
