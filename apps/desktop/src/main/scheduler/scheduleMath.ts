import type { ScheduledTaskCreateInput } from "@contracts/scheduledTask";

function parseTimeOfDay(value: string): [number, number] {
  const [hour, minute] = value.split(":").map(Number);
  return [hour!, minute!];
}

/** Calculate in the machine's local timezone; Date#setHours preserves DST semantics. */
export function calculateNextRunAt(
  input: Pick<ScheduledTaskCreateInput, "scheduleKind" | "timeOfDay" | "weekdays" | "runAt">,
  after: number,
): number | null {
  if (input.scheduleKind === "one-time") {
    const at = Date.parse(input.runAt!);
    return Number.isFinite(at) ? at : null;
  }
  const [hour, minute] = parseTimeOfDay(input.timeOfDay!);
  const base = new Date(after);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(base);
    candidate.setDate(base.getDate() + offset);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() <= after) continue;
    if (input.scheduleKind === "daily") return candidate.getTime();
    const day = candidate.getDay() === 0 ? 7 : candidate.getDay();
    if (input.weekdays.includes(day)) return candidate.getTime();
  }
  return null;
}

export function validateSchedule(
  input: Pick<ScheduledTaskCreateInput, "scheduleKind" | "runAt" | "enabled">,
  now = Date.now(),
): void {
  if (input.enabled && input.scheduleKind === "one-time" && Date.parse(input.runAt!) <= now) {
    throw new Error("one-time task must be scheduled in the future");
  }
}
