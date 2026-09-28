/**
 * mario_schedule_list / create / update / delete — the agent's handle on
 * SchedulerService (Settings → 定时任务 manages the same rows). Arguments are
 * validated with ScheduledTaskCreateSchema (scheduleToolArgs.ts) before the
 * service is called; the service's own reference / schedule checks still
 * run and their errors come back as refusals.
 *
 * Mutations refuse inside an unattended run (scheduled task / ClawBot turn):
 * an unattended agent must not reprogram the scheduler. builtinToolNeedsApproval
 * lets those calls through without an approval request precisely so this
 * refusal reaches the model instead of cancelling the run.
 *
 * SchedulerService and the provider registry are imported lazily: they pull
 * in RuntimeManager → provider registry → providers, and the providers import
 * this module (via builtinTools.ts) — a static import would close that cycle.
 */
import type { ScheduledTask } from "@contracts/scheduledTask";
import { ProjectRepo, SessionRepo } from "@main/store/repositories.js";
import type { BuiltinToolResult } from "./builtinToolSpecs.js";
import {
  buildScheduleCreateInput,
  changedDefinitionKeys,
  formatLocalIso,
  formatLocalMinute,
  formatScheduleText,
  mergeScheduleUpdate,
  shortText,
} from "./scheduleToolArgs.js";
import { isUnattendedSession } from "./unattended.js";

export const UNATTENDED_SCHEDULE_REFUSAL = "无人值守运行中不能创建或修改定时任务,请在 MarioCode 里操作";

const UNATTENDED_NOTE =
  "注意:任务会在无人值守下以普通权限运行,遇到任何需要审批 / 提问的操作会自动停止;可以在 设置 → 定时任务 里查看、修改或立即运行。";

function text(t: string): BuiltinToolResult {
  return { content: [{ type: "text", text: t }] };
}
function refusal(t: string): BuiltinToolResult {
  return { content: [{ type: "text", text: `❌ ${t}` }] };
}

async function scheduler() {
  return (await import("@main/scheduler/SchedulerService.js")).schedulerService;
}

async function providerName(id: string): Promise<string> {
  try {
    const { providerRegistry } = await import("@main/providers/registry.js");
    return providerRegistry.get(id)?.displayName ?? id;
  } catch {
    return id;
  }
}

function projectName(id: string): string {
  return ProjectRepo.get(id)?.name ?? `(未知项目 ${id})`;
}

const STATUS_TEXT: Record<ScheduledTask["lastStatus"], string> = {
  idle: "未运行过",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  skipped: "跳过",
};

async function describeTask(task: ScheduledTask): Promise<string> {
  const lines = [
    `- ${task.name}(id: ${task.id})`,
    `  项目:${projectName(task.projectId)}(${task.projectId}) · 引擎:${await providerName(task.providerId)}(${task.providerId})`,
    `  时间:${formatScheduleText(task)} · ${task.enabled ? "已启用" : "已暂停"} · 微信推送:${task.pushEnabled ? "开" : "关"}`,
    `  下次执行:${task.nextRunAt ? formatLocalMinute(task.nextRunAt) : "无"}`,
  ];
  if (task.lastRunAt) {
    const err = task.lastStatus === "failed" && task.lastError ? `(${shortText(task.lastError)})` : "";
    lines.push(`  上次:${formatLocalMinute(task.lastRunAt)} ${STATUS_TEXT[task.lastStatus]}${err}`);
  }
  return lines.join("\n");
}

function nowLine(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `当前本地时间:${formatLocalIso(Date.now())}${tz ? `(${tz})` : ""}`;
}

async function list(args: Record<string, unknown>): Promise<BuiltinToolResult> {
  const projectId = typeof args.projectId === "string" && args.projectId.trim() ? args.projectId.trim() : null;
  const tasks = (await scheduler()).list().filter((t) => !projectId || t.projectId === projectId);
  const head = [nowLine()];
  if (tasks.length === 0) {
    head.push(projectId ? `项目 ${projectName(projectId)} 没有定时任务。` : "还没有定时任务。");
    return text(head.join("\n"));
  }
  head.push(`共 ${tasks.length} 个定时任务:`);
  const body = await Promise.all(tasks.map(describeTask));
  return text([...head, ...body].join("\n"));
}

async function create(args: Record<string, unknown>, sessionId: string | undefined): Promise<BuiltinToolResult> {
  const session = sessionId ? SessionRepo.get(sessionId) : undefined;
  const parsed = buildScheduleCreateInput(args, { projectId: session?.projectId, providerId: session?.providerId });
  if (!parsed.ok) return refusal(`参数不合法:${parsed.error}`);
  const task = (await scheduler()).create(parsed.input);
  return text(["已创建定时任务:", await describeTask(task), UNATTENDED_NOTE].join("\n"));
}

async function update(args: Record<string, unknown>): Promise<BuiltinToolResult> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return refusal("缺少 id(先用 mario_schedule_list 查)");
  const svc = await scheduler();
  const existing = svc.list().find((t) => t.id === id);
  if (!existing) return refusal(`找不到定时任务:${id}`);
  const changed = changedDefinitionKeys(existing, args);
  if (changed.length === 0) return text(["没有需要修改的字段,任务保持不变:", await describeTask(existing)].join("\n"));
  let task: ScheduledTask;
  if (changed.length === 1 && changed[0] === "enabled" && typeof args.enabled === "boolean") {
    task = svc.setEnabled(id, args.enabled);
  } else {
    const merged = mergeScheduleUpdate(existing, args);
    if (!merged.ok) return refusal(`参数不合法:${merged.error}`);
    task = svc.update(id, merged.input);
  }
  return text([`已修改定时任务(${changed.join("、")}):`, await describeTask(task)].join("\n"));
}

async function remove(args: Record<string, unknown>): Promise<BuiltinToolResult> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return refusal("缺少 id(先用 mario_schedule_list 查)");
  const svc = await scheduler();
  const existing = svc.list().find((t) => t.id === id);
  if (!existing) return refusal(`找不到定时任务:${id}`);
  svc.delete(id);
  return text(`已删除定时任务:${existing.name}(id: ${id})`);
}

export type ScheduleToolAction = "list" | "create" | "update" | "delete";

export async function runScheduleTool(
  action: ScheduleToolAction,
  args: Record<string, unknown>,
  sessionId: string | undefined,
): Promise<BuiltinToolResult> {
  if (action !== "list" && isUnattendedSession(sessionId)) return refusal(UNATTENDED_SCHEDULE_REFUSAL);
  try {
    switch (action) {
      case "list":
        return await list(args);
      case "create":
        return await create(args, sessionId);
      case "update":
        return await update(args);
      case "delete":
        return await remove(args);
    }
  } catch (err) {
    return refusal(err instanceof Error ? err.message : String(err));
  }
}
