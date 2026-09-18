import assert from "node:assert/strict";
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
} from "../../src/main/clawbot/protocol.js";

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

console.log("ClawBot protocol smoke passed");
