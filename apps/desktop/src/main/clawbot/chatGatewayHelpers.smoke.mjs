import assert from "node:assert/strict";
import { isAbsolute, resolve } from "node:path";
import {
  isNewSessionCommand,
  KeyedSerialQueue,
  publicChatConfig,
  resolveSafeChild,
} from "./chatGatewayHelpers.ts";

assert.deepEqual(
  publicChatConfig({ providerId: "claude-sdk", model: "default", permissionMode: "default" }),
  { providerId: "claude-sdk", model: "default" },
  "strict IPC projection must not leak permissionMode",
);

assert.equal(isNewSessionCommand("新会话"), true);
assert.equal(isNewSessionCommand(" 新会话"), false);
assert.equal(isNewSessionCommand("新会话\n"), false);

const root = resolve("gateway-smoke-root");
const child = resolveSafeChild(root, "clawbot", "workspace");
assert.equal(isAbsolute(child), true);
assert.equal(child.startsWith(root), true);
assert.throws(() => resolveSafeChild(root, ".."), /non-root child/);
assert.throws(() => resolveSafeChild(root), /non-root child/);

const queue = new KeyedSerialQueue();
const order = [];
let release;
const gate = new Promise((resolveGate) => { release = resolveGate; });
const first = queue.run("same", async () => { order.push("first:start"); await gate; order.push("first:end"); });
const second = queue.run("same", async () => { order.push("second"); });
await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
assert.deepEqual(order, ["first:start"]);
release();
await Promise.all([first, second]);
assert.deepEqual(order, ["first:start", "first:end", "second"]);

await assert.rejects(queue.run("recover", async () => { throw new Error("expected"); }), /expected/);
await queue.run("recover", async () => { order.push("recovered"); });
assert.equal(order.at(-1), "recovered");

console.log("clawbot chat gateway helpers smoke: ok");
