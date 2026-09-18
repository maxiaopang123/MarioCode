import assert from "node:assert/strict";
import { ClawBotService } from "../../src/main/clawbot/ClawBotService.js";
import type { ClawBotMetadata, ClawBotSecrets } from "../../src/main/clawbot/ClawBotCredentialStore.js";
import { normalizeOwnerInbound } from "../../src/main/clawbot/protocol.js";

// Exercise the actual service; only OS credentials, DB and network boundaries
// are replaced with deterministic test fixtures.
const message = {
  from_user_id: "owner", to_user_id: "bot", message_id: "message-1",
  message_type: 1, message_state: 2, context_token: "new-context",
  item_list: [{ type: 1, text_item: { text: "hello" } }],
};
const ref = normalizeOwnerInbound(message, "owner", "account")!.event.replyContextRef;

function fixture() {
  const service = new ClawBotService();
  const internal = service as any;
  let metadata: ClawBotMetadata = {
    accountId: "account", userId: "owner", baseUrl: "https://ilinkai.weixin.qq.com",
    boundAt: 1, lastInteractionAt: null, lastError: null,
  };
  let secrets: ClawBotSecrets = { botToken: "token", cursor: "old", contextToken: "old-context" };
  let disposed = false;
  let touchesAfterDispose = 0;
  const order: string[] = [];
  const check = () => {
    if (disposed) { touchesAfterDispose++; throw new Error("DB disposed"); }
  };
  internal.store = {
    readMetadata() { check(); return structuredClone(metadata); },
    readSecrets() { check(); return structuredClone(secrets); },
    writeMetadata(value: ClawBotMetadata) { check(); metadata = structuredClone(value); },
    writeSecrets(value: ClawBotSecrets) {
      check(); order.push(value.cursor === "old" ? "context" : "cursor");
      secrets = structuredClone(value);
    },
    clear() { check(); },
  };
  return { service, internal, order, secrets: () => secrets,
    dispose: () => { disposed = true; }, touches: () => touchesAfterDispose };
}

for (const failSink of [false, true]) {
  const f = fixture();
  const controller = new AbortController();
  f.internal.requestJson = async (url: string) => {
    if (url.endsWith("sendmessage")) return { ret: 0 };
    if (f.secrets().cursor === "new") { controller.abort(); return { ret: 0 }; }
    return { ret: 0, next_key: "new", messages: [message] };
  };
  f.service.registerInboundSink(async () => {
    f.order.push("sink");
    assert.equal(f.secrets().cursor, "old");
    assert.equal(f.secrets().replyContexts?.[0]?.ref, ref);
    if (failSink) { controller.abort(); throw new Error("Inbox rollback"); }
    const sent = await f.service.replyTo(ref, "reply", "stable-client");
    assert.equal(sent.status, "accepted");
    assert.equal(f.secrets().replyContexts?.length, 0);
  });
  await f.internal.monitorLoop(controller.signal);
  if (failSink) {
    assert.deepEqual(f.order, ["context", "sink"]);
    assert.equal(f.secrets().cursor, "old");
    assert.equal(f.secrets().replyContexts?.length, 1);
  } else {
    assert.deepEqual(f.order, ["context", "sink", "context", "cursor"]);
    assert.equal(f.secrets().cursor, "new");
    assert.equal(f.secrets().contextToken, "new-context");
    assert.equal(f.secrets().replyContexts?.length, 0, "ack must not resurrect consumed ref");
  }
}

for (const ret of [0, -2, -14]) {
  const f = fixture();
  f.secrets().replyContexts = [{ ref, senderId: "owner", contextToken: "reply", createdAt: 1 }];
  let complete!: (value: { ret: number }) => void;
  f.internal.requestJson = (url: string) => url.endsWith("sendmessage")
    ? new Promise((resolve) => { complete = resolve; }) : Promise.resolve({ ret: 0 });
  const pending = f.service.replyTo(ref, "reply", "client");
  await f.service.stop();
  f.dispose();
  complete({ ret });
  await pending;
  assert.equal((await f.service.replyTo(ref, "late", "late-client")).status, "failed");
  assert.equal(f.touches(), 0, "reply continuations and new replies must not access closed DB");
}
console.log("ClawBot service ordering/shutdown smoke passed");
