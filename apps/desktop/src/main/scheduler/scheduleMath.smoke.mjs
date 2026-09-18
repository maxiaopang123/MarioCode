import assert from "node:assert/strict";
import { calculateNextRunAt, validateSchedule } from "./scheduleMath.ts";

// Use local Date constructors so the assertions are stable in every timezone.
const base = new Date(2026, 8, 14, 10, 30, 0, 0); // Monday
const oneTime = new Date(2026, 8, 14, 12, 0, 0, 0).toISOString();
assert.equal(calculateNextRunAt({ scheduleKind: "one-time", runAt: oneTime, timeOfDay: null, weekdays: [] }, base.getTime()), Date.parse(oneTime));

const daily = calculateNextRunAt({ scheduleKind: "daily", runAt: null, timeOfDay: "09:00", weekdays: [] }, base.getTime());
assert.equal(daily, new Date(2026, 8, 15, 9, 0, 0, 0).getTime());

const weekly = calculateNextRunAt({ scheduleKind: "weekly", runAt: null, timeOfDay: "08:15", weekdays: [3] }, base.getTime());
assert.equal(weekly, new Date(2026, 8, 16, 8, 15, 0, 0).getTime());

assert.throws(
  () => validateSchedule({ scheduleKind: "one-time", runAt: new Date(base.getTime() - 1).toISOString(), enabled: true }, base.getTime()),
  /future/,
);
assert.doesNotThrow(
  () => validateSchedule({ scheduleKind: "one-time", runAt: new Date(base.getTime() + 1).toISOString(), enabled: true }, base.getTime()),
);

console.log("scheduler schedule math smoke: ok");
