import { z } from "zod";

export const ScheduleKindSchema = z.enum(["one-time", "daily", "weekly"]);
export type ScheduleKind = z.infer<typeof ScheduleKindSchema>;

export const ScheduledTaskStatusSchema = z.enum([
  "idle",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);
export type ScheduledTaskStatus = z.infer<typeof ScheduledTaskStatusSchema>;

export const ScheduledTaskPushStatusSchema = z.enum([
  "idle",
  "pending",
  "accepted",
  "failed",
  "needs-interaction",
  "skipped",
]);
export type ScheduledTaskPushStatus = z.infer<typeof ScheduledTaskPushStatusSchema>;

export interface ScheduledTask {
  id: string;
  name: string;
  projectId: string;
  providerId: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  timeOfDay: string | null;
  weekdays: number[];
  runAt: string | null;
  enabled: boolean;
  pushEnabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: ScheduledTaskStatus;
  lastError: string | null;
  lastSessionId: string | null;
  lastPushStatus: ScheduledTaskPushStatus;
  lastPushAt: number | null;
  lastPushError: string | null;
  createdAt: number;
  updatedAt: number;
}

const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "timeOfDay must be HH:mm");

export const ScheduledTaskCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    projectId: z.string().min(1),
    providerId: z.string().min(1),
    prompt: z.string().trim().min(1).max(200_000),
    scheduleKind: ScheduleKindSchema,
    timeOfDay: TimeOfDaySchema.nullish(),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    runAt: z.string().datetime({ offset: true }).nullish(),
    enabled: z.boolean().default(true),
    pushEnabled: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.scheduleKind === "one-time" && !value.runAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runAt"], message: "runAt is required" });
    }
    if (value.scheduleKind !== "one-time" && !value.timeOfDay) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["timeOfDay"], message: "timeOfDay is required" });
    }
    if (value.scheduleKind === "weekly" && value.weekdays.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["weekdays"], message: "select at least one weekday" });
    }
  });
export type ScheduledTaskCreateInput = z.infer<typeof ScheduledTaskCreateSchema>;

export const ScheduledTaskUpdateSchema = ScheduledTaskCreateSchema.and(z.object({ id: z.string().min(1) }));
export type ScheduledTaskUpdateInput = z.infer<typeof ScheduledTaskUpdateSchema>;

export const ScheduledTaskIdSchema = z.object({ id: z.string().min(1) });
export const ScheduledTaskSetEnabledSchema = z.object({ id: z.string().min(1), enabled: z.boolean() });
