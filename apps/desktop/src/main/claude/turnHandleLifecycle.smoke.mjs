import assert from "node:assert/strict";
import { isCurrentProviderContext, keepLateHandleOnlyIfCurrent, runIfCurrentProviderContext } from "./turnHandleLifecycle.ts";

const expected = {};
let interrupted = 0;
let rejected = 0;
const late = {
  interrupt() { interrupted++; },
  done: Promise.reject(new Error("late handle interrupted")),
};
assert.equal(keepLateHandleOnlyIfCurrent(undefined, expected, late, () => { rejected++; }), false);
assert.equal(interrupted, 1);
assert.equal(rejected, 1);
await new Promise((resolve) => setImmediate(resolve));

const current = { id: "current" };
const healthy = { interrupt() { assert.fail("current handle must remain mounted"); }, done: Promise.resolve() };
assert.equal(keepLateHandleOnlyIfCurrent(current, current, healthy, () => assert.fail("must not reject current bridge")), true);
assert.equal(isCurrentProviderContext(current, current), true);
assert.equal(isCurrentProviderContext({ id: "rebound" }, current), false, "old ctx identity must be rejected after rebind");
assert.equal(isCurrentProviderContext(undefined, current), false, "disposed ctx identity must be rejected");
let pendingBridgeCreated = 0;
const staleDecision = runIfCurrentProviderContext(
  undefined,
  current,
  () => { pendingBridgeCreated++; return { allow: true }; },
  () => ({ allow: false, reason: "inactive" }),
);
assert.deepEqual(staleDecision, { allow: false, reason: "inactive" });
assert.equal(pendingBridgeCreated, 0, "stale approval must not establish pending bridge state");

console.log("runtime late turn handle smoke: ok");
