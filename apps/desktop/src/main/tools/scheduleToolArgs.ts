/**
 * Pure helpers for the mario_schedule_* tools: turn the model's loose
 * arguments into a ScheduledTaskCreateInput (validated with the same zod
 * schema the settings page uses), merge partial updates onto an existing
 * task, and render tasks / times as short model-facing text. No Electron, no
 * DB — the offline smoke exercises these directly.
 */
import {
  ScheduledTaskCreateSchema,
  type ScheduledTask,
  type ScheduledTaskCreateInput,
} from "@contracts/scheduledTask";

/** Definition fields the tools accept (everything a ScheduledTaskCreateInput has). */
const DEFINITION_KEYS = [
  "name",
  "projectId",
  "providerId",
  "prompt",
  "scheduleKind",
  "timeOfDay",
  "weekdays",
  "runAt",
  "enabled",
  "pushEnabled",
] as const;
type DefinitionKey = (typeof DEFINITION_KEYS)[number];

export type ScheduleParseResult =
  | { ok: true; input: ScheduledTaskCreateInput }
  | { ok: false; error: string };

/** Weekdays arrive as numbers, numeric strings or a single number; anything
 *  else is passed through untouched so the schema reports it. */
function coerceWeekdays(value: unknown): unknown {
  if (typeof value === "number") return [value];
  if (!Array.isArray(value)) return value;
  return value.map((d) => (typeof d === "string" && /^\d+$/.test(d.trim()) ? Number(d.trim()) : d));
}

/** Copy the definition keys the model actually supplied (undefined = absent). */
function pickDefinition(args: Record<string, unknown>): Partial<Record<DefinitionKey, unknown>> {
  const out: Partial<Record<DefinitionKey, unknown>> = {};
  for (const key of DEFINITION_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    out[key] = key === "weekdays" ? coerceWeekdays(value) : value;
  }
  return out;
}

function formatIssues(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string {
  return error.issues
    .map((i) => `${i.path.length ? i.path.map(String).join(".") : "参数"}: ${i.message}`)
    .join(";");
}

/** Validate a candidate definition with ScheduledTaskCreateSchema. */
export function parseScheduleInput(candidate: Record<string, unknown>): ScheduleParseResult {
  const parsed = ScheduledTaskCreateSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, input: parsed.data };
  return { ok: false, error: formatIssues(parsed.error) };
}

/** mario_schedule_create: the model's args + defaults for project / engine
 *  (the calling session's). `enabled` defaults to true via the schema. */
export function buildScheduleCreateInput(
  args: Record<string, unknown>,
  defaults: { projectId?: string; providerId?: string },
): ScheduleParseResult {
  const picked = pickDefinition(args);
  const candidate: Record<string, unknown> = { ...picked };
  if (candidate.projectId === undefined || candidate.projectId === "") candidate.projectId = defaults.projectId;
  if (candidate.providerId === undefined || candidate.providerId === "") candidate.providerId = defaults.providerId;
  if (!candidate.projectId) return { ok: false, error: "projectId: 无法确定项目(当前会话没有项目),请传 projectId" };
  if (!candidate.providerId) return { ok: false, error: "providerId: 无法确定引擎,请传 providerId" };
  return parseScheduleInput(candidate);
}

/** The existing task's definition as a create-input candidate. */
export function taskDefinition(task: ScheduledTask): Record<DefinitionKey, unknown> {
  return {
    name: task.name,
    projectId: task.projectId,
    providerId: task.providerId,
    prompt: task.prompt,
    scheduleKind: task.scheduleKind,
    timeOfDay: task.timeOfDay,
    weekdays: task.weekdays,
    runAt: task.runAt,
    enabled: task.enabled,
    pushEnabled: task.pushEnabled,
  };
}

/** mario_schedule_update: supplied fields override the existing task's
 *  (SchedulerService.update is a FULL replacement, so merge first). */
export function mergeScheduleUpdate(existing: ScheduledTask, args: Record<string, unknown>): ScheduleParseResult {
  return parseScheduleInput({ ...taskDefinition(existing), ...pickDefinition(args) });
}

/** Keys of the update args that differ from the existing task — lets the
 *  caller use setEnabled when only `enabled` changes. */
export function changedDefinitionKeys(existing: ScheduledTask, args: Record<string, unknown>): DefinitionKey[] {
  const current = taskDefinition(existing);
  const picked = pickDefinition(args);
  return (Object.keys(picked) as DefinitionKey[]).filter(
    (k) => JSON.stringify(picked[k] ?? null) !== JSON.stringify(current[k] ?? null),
  );
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "+08:00" style offset of a local Date. */
export function formatUtcOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** "2026-09-28 09:00" in local time. */
export function formatLocalMinute(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "2026-09-28T09:00:00+08:00" — the runAt format the tools ask for. */
export function formatLocalIso(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${formatUtcOffset(d)}`
  );
}

const WEEKDAY_NAMES = ["一", "二", "三", "四", "五", "六", "日"];

/** 每天 09:00 / 每周一、三 09:00 / 一次性 2026-09-28 09:00. */
export function formatScheduleText(task: Pick<ScheduledTask, "scheduleKind" | "timeOfDay" | "weekdays" | "runAt">): string {
  if (task.scheduleKind === "daily") return `每天 ${task.timeOfDay ?? "?"}`;
  if (task.scheduleKind === "weekly") {
    const days = [...new Set(task.weekdays)]
      .filter((d) => d >= 1 && d <= 7)
      .sort((a, b) => a - b)
      .map((d) => WEEKDAY_NAMES[d - 1])
      .join("、");
    return `每周${days || "?"} ${task.timeOfDay ?? "?"}`;
  }
  const at = task.runAt ? Date.parse(task.runAt) : NaN;
  return `一次性 ${Number.isFinite(at) ? formatLocalMinute(at) : task.runAt ?? "?"}`;
}

/** Trim a long error to one short line. */
export function shortText(text: string | null | undefined, max = 120): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
