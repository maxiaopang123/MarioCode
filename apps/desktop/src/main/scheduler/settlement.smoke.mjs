import assert from "node:assert/strict";
import { awaitProviderSettlement, resolveScheduledRunResult } from "./settlement.ts";

// Production grace timers are unref'ed; keep this tiny standalone process
// alive while the zero-ms deterministic grace branch resolves.
const keeper = setInterval(() => {}, 1_000);

const normal = await awaitProviderSettlement(Promise.resolve(), new Promise(() => {}), 100, 0, () => assert.fail("must not cancel"), () => assert.fail("must not force"));
assert.deepEqual(normal, { forced: false, completionError: null, cancellationReason: null });

let forced = false;
const never = new Promise(() => {});
let externalCancelCalled = false;
const cancelled = await awaitProviderSettlement(never, Promise.resolve("approval required"), 100, 0, () => { externalCancelCalled = true; }, () => { forced = true; });
assert.equal(forced, true);
assert.equal(externalCancelCalled, true);
assert.deepEqual(cancelled, { forced: true, completionError: null, cancellationReason: "approval required" });

const rejected = await awaitProviderSettlement(Promise.reject(new Error("provider failed")), new Promise(() => {}), 100, 0, () => assert.fail("must not cancel"), () => assert.fail("must not force"));
assert.equal(rejected.completionError, "provider failed");

let deadlineCancel = false;
let deadlineForce = false;
const deadline = await awaitProviderSettlement(never, new Promise(() => {}), 0, 0, () => { deadlineCancel = true; }, () => { deadlineForce = true; });
assert.equal(deadlineCancel, true, "normal deadline must cancel first");
assert.equal(deadlineForce, true, "non-settling provider must be forced after grace");
assert.equal(deadline.forced, true);
assert.equal(deadline.cancellationReason, "scheduled task timed out");

assert.deepEqual(
  resolveScheduledRunResult(
    { ok: true, error: null },
    { forced: false, completionError: null, cancellationReason: "scheduled task timed out" },
    "forced cleanup",
  ),
  { ok: false, error: "scheduled task timed out" },
  "a provider timeout must override an earlier successful turn.done",
);

clearInterval(keeper);
console.log("scheduler settlement smoke: ok");
