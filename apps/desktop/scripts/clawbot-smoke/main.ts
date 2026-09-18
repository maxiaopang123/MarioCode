import assert from "node:assert/strict";
import "./service-smoke.js";
import {
  ILINK_APP_CLIENT_VERSION,
  buildBaseInfo,
  buildIlinkCommonHeaders,
  buildIlinkHeaders,
  buildSendTextBody,
  classifySendResponse,
  isQrStatus,
  resolveStoredBindingState,
  normalizeTrustedApiBase,
  selectOwnerContext,
  BindingEpoch,
  deliverInboundBatch,
  normalizeOwnerInbound,
  readUpdatesCursor,
  readUpdatesMessages,
} from "../../src/main/clawbot/protocol.js";
import {
  consumeReplyContext,
  findReplyContext,
  upsertReplyContexts,
} from "../../src/main/clawbot/inbound.js";

for (const state of [
  "wait", "scaned", "confirmed", "expired", "need_verifycode",
  "verify_code_blocked", "scaned_but_redirect", "binded_redirect",
]) assert.equal(isQrStatus(state), true);
assert.equal(isQrStatus("unknown"), false);
assert.equal(resolveStoredBindingState(false, false), "unbound");
assert.equal(resolveStoredBindingState(true, false), "needs-interaction");
assert.equal(resolveStoredBindingState(true, true), "bound");
assert.equal(normalizeTrustedApiBase("https://ilinkai.weixin.qq.com/some/path"), "https://ilinkai.weixin.qq.com");
assert.throws(() => normalizeTrustedApiBase("https://evil.example/api"), /trusted|\u53d7信任/);
assert.throws(() => normalizeTrustedApiBase("http://ilinkai.weixin.qq.com"), /HTTPS/);
let simulatedFetchCalls = 0;
assert.throws(() => {
  // Mirrors service argument evaluation: validation completes before the
  // request function can be entered, so a tampered settings row cannot leak
  // its Bearer token to an attacker-controlled host.
  const base = normalizeTrustedApiBase("https://evil.example/collect");
  simulatedFetchCalls++;
  return base;
}, /trusted|\u53d7信任/);
assert.equal(simulatedFetchCalls, 0);

const lockedOwner = selectOwnerContext("owner", "owner-old", [
  { from_user_id: "other", context_token: "other-secret" },
  { from_user_id: "owner", context_token: "owner-new" },
]);
assert.deepEqual(lockedOwner, { userId: "owner", contextToken: "owner-new", matched: true });
assert.equal(JSON.stringify(lockedOwner).includes("other-secret"), false);

const firstSenderWins = selectOwnerContext("", "", [
  { from_user_id: "first", context_token: "first-context" },
  { from_user_id: "second", context_token: "second-context" },
]);
assert.deepEqual(firstSenderWins, { userId: "first", contextToken: "first-context", matched: true });

assert.deepEqual(buildBaseInfo(), { channel_version: "2.4.9", bot_agent: "MarioCode/0.1" });
const headers = buildIlinkHeaders("secret-token", 1234);
assert.equal(headers.AuthorizationType, "ilink_bot_token");
assert.equal(headers.Authorization, "Bearer secret-token");
assert.equal(headers["iLink-App-Id"], "bot");
assert.equal(headers["iLink-App-ClientVersion"], ILINK_APP_CLIENT_VERSION);
assert.equal(Buffer.from(headers["X-WECHAT-UIN"], "base64").toString("utf8"), "1234");
const qrStatusHeaders = buildIlinkCommonHeaders();
assert.equal(qrStatusHeaders["iLink-App-Id"], "bot");
assert.equal("AuthorizationType" in qrStatusHeaders, false);
assert.equal("Authorization" in qrStatusHeaders, false);
assert.equal("X-WECHAT-UIN" in qrStatusHeaders, false);

const bindingEpoch = new BindingEpoch();
const firstEpoch = bindingEpoch.begin();
assert.equal(bindingEpoch.isCurrent(firstEpoch), true);
const replacementEpoch = bindingEpoch.begin();
assert.equal(bindingEpoch.isCurrent(firstEpoch), false);
assert.equal(bindingEpoch.isCurrent(replacementEpoch), true);
bindingEpoch.cancel();
assert.equal(bindingEpoch.isCurrent(replacementEpoch), false);

const body = buildSendTextBody("user-1", "hello", "context-secret", "client-1") as any;
assert.equal(body.msg.to_user_id, "user-1");
assert.equal(body.msg.client_id, "client-1");
assert.equal(body.msg.message_type, 2);
assert.equal(body.msg.message_state, 2);
assert.equal(body.msg.item_list[0].text_item.text, "hello");
assert.equal(body.base_info.channel_version, "2.4.9");

assert.deepEqual(classifySendResponse({ ret: 0 }), { status: "accepted", error: null });
assert.equal(classifySendResponse({}).status, "failed");
assert.equal(classifySendResponse({ errcode: 0 }).status, "failed");
assert.equal(classifySendResponse({ ret: -2 }).status, "needs-interaction");
assert.equal(classifySendResponse({ errcode: -14 }).status, "failed");
const rejected = classifySendResponse({ ret: 500, errmsg: "secret-token context-secret" });
assert.equal(rejected.status, "failed");
assert.equal(JSON.stringify(rejected).includes("secret-token"), false);
assert.equal(JSON.stringify(rejected).includes("context-secret"), false);

const baseInbound = {
  from_user_id: "owner@im.wechat",
  to_user_id: "bot@im.bot",
  message_type: 1,
  message_state: 2,
  context_token: "reply-secret",
  create_time_ms: "1770000000000",
  item_list: [{ type: 1, item_id: "item-7", text_item: { text: " hello " } }],
};
const normalized = normalizeOwnerInbound(
  { ...baseInbound, message_id: "18446744073709551615" },
  "owner@im.wechat",
  "account-1",
);
assert.equal(normalized?.event.messageId, "18446744073709551615");
assert.equal(normalized?.event.text, "hello");
assert.match(normalized!.event.replyContextRef, /^rc_[0-9a-f]{64}$/);
assert.equal(normalized?.event.accountId, "account-1");
assert.match(normalized!.event.conversationKey, /^[0-9a-f]{64}$/);
assert.equal(JSON.stringify(normalized?.event).includes("reply-secret"), false);
assert.equal(JSON.stringify(normalized?.event).includes("owner@im.wechat"), false);
assert.equal(normalizeOwnerInbound({ ...baseInbound, message_id: undefined }, "owner@im.wechat", "account-1")?.event.messageId, "item-7");
const fallback1 = normalizeOwnerInbound(
  { ...baseInbound, item_list: [{ type: 1, text_item: { text: "same" } }] },
  "owner@im.wechat",
  "account-1",
)?.event.messageId;
const fallback2 = normalizeOwnerInbound(
  { ...baseInbound, item_list: [{ type: 1, text_item: { text: "same" } }] },
  "owner@im.wechat",
  "account-1",
)?.event.messageId;
assert.equal(fallback1, fallback2);
assert.match(fallback1!, /^sha256:[0-9a-f]{64}$/);

for (const rejectedMessage of [
  { ...baseInbound, message_type: 2 },
  { ...baseInbound, message_state: 1 },
  { ...baseInbound, from_user_id: "other@im.wechat" },
  { ...baseInbound, group_id: "group-1" },
  { ...baseInbound, deleted: true },
  { ...baseInbound, item_list: [{ type: 10, text_item: { text: "tool" } }] },
  { ...baseInbound, item_list: [{ type: 2, image_item: {} }] },
]) assert.equal(normalizeOwnerInbound(rejectedMessage, "owner@im.wechat", "account-1"), null);

const sameConversation = normalizeOwnerInbound({ ...baseInbound, message_id: "18446744073709551615" }, "owner@im.wechat", "account-1");
const replayedMessage = normalizeOwnerInbound({ ...baseInbound, message_id: "18446744073709551615" }, "owner@im.wechat", "account-1");
const otherConversation = normalizeOwnerInbound({ ...baseInbound, message_id: "18446744073709551615" }, "owner@im.wechat", "account-2");
const otherMessage = normalizeOwnerInbound({ ...baseInbound, message_id: "different-message" }, "owner@im.wechat", "account-1");
assert.equal(sameConversation?.event.conversationKey, normalized?.event.conversationKey);
assert.notEqual(otherConversation?.event.conversationKey, normalized?.event.conversationKey);
assert.equal(replayedMessage?.event.replyContextRef, normalized?.event.replyContextRef);
assert.notEqual(otherConversation?.event.replyContextRef, normalized?.event.replyContextRef);
assert.notEqual(otherMessage?.event.replyContextRef, normalized?.event.replyContextRef);
assert.equal(normalized?.event.replyContextRef.includes("owner@im.wechat"), false);
assert.equal(normalized?.event.replyContextRef.includes("reply-secret"), false);

const persistedContexts = upsertReplyContexts(undefined, Array.from({ length: 300 }, (_, index) => ({
  ref: `ref-${index}`,
  senderId: `sender-${index}`,
  contextToken: `context-${index}`,
  createdAt: index,
})));
assert.equal(persistedContexts.length, 300);
assert.equal(findReplyContext(persistedContexts, "ref-299")?.contextToken, "context-299");
assert.equal(findReplyContext(persistedContexts, "ref-0")?.contextToken, "context-0");
const serializedReload = JSON.parse(JSON.stringify({ replyContexts: persistedContexts })) as { replyContexts: typeof persistedContexts };
assert.equal(findReplyContext(serializedReload.replyContexts, "ref-257")?.senderId, "sender-257");
const afterAccepted = consumeReplyContext(serializedReload.replyContexts, "ref-257");
assert.equal(findReplyContext(afterAccepted, "ref-257"), null);
assert.equal(findReplyContext(afterAccepted, "ref-256")?.senderId, "sender-256");
assert.equal(afterAccepted.length, 299);

// Mirrors monitor ordering: persist ref with the old cursor, deliver Inbox,
// then acknowledge from a fresh secrets read. A ref consumed during the sink
// must not be resurrected by the cursor acknowledgement.
const commitOrder: string[] = [];
let simulatedSecrets = { cursor: "old", replyContexts: [] as typeof persistedContexts };
simulatedSecrets = {
  ...simulatedSecrets,
  replyContexts: upsertReplyContexts(simulatedSecrets.replyContexts, [{
    ref: "stable-ref",
    senderId: "owner",
    contextToken: "context",
    createdAt: 1,
  }]),
};
commitOrder.push("context");
await deliverInboundBatch([normalized!.event], async () => {
  commitOrder.push("sink");
  simulatedSecrets = {
    ...simulatedSecrets,
    replyContexts: consumeReplyContext(simulatedSecrets.replyContexts, "stable-ref"),
  };
}, () => {
  const freshlyRead = simulatedSecrets;
  simulatedSecrets = { ...freshlyRead, cursor: "new" };
  commitOrder.push("cursor");
});
assert.deepEqual(commitOrder, ["context", "sink", "cursor"]);
assert.equal(simulatedSecrets.cursor, "new");
assert.equal(findReplyContext(simulatedSecrets.replyContexts, "stable-ref"), null);

assert.deepEqual(readUpdatesMessages({ ret: 0, messages: [baseInbound] }), [baseInbound]);
assert.equal(readUpdatesCursor({ ret: 0, next_key: "cursor-2" }), "cursor-2");

const gate: string[] = [];
await deliverInboundBatch([normalized!.event], async (batch) => {
  assert.equal(batch.length, 1);
  gate.push("sink");
}, () => gate.push("cursor"));
assert.deepEqual(gate, ["sink", "cursor"]);
let cursorAdvanced = false;
await assert.rejects(
  deliverInboundBatch([normalized!.event], async () => { throw new Error("db rollback"); }, () => { cursorAdvanced = true; }),
  /db rollback/,
);
assert.equal(cursorAdvanced, false);
await assert.rejects(deliverInboundBatch([normalized!.event], null, () => { cursorAdvanced = true; }), /尚未注册/);
assert.equal(cursorAdvanced, false);

const stableReply = buildSendTextBody("owner", "answer", "secret", "stable-job:message-1") as any;
assert.equal(stableReply.msg.client_id, "stable-job:message-1");
assert.equal(stableReply.msg.context_token, "secret");

console.log("ClawBot protocol smoke passed");
