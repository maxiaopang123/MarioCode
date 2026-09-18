import type { RuntimeEvent } from "@contracts/runtime";
import type { ScheduledTask, ScheduledTaskCreateInput } from "@contracts/scheduledTask";
import { ProjectRepo, ScheduledTaskRepo, SessionRepo } from "@main/store/repositories.js";
import { providerRegistry } from "@main/providers/registry.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { createOrReuseSession } from "@main/lib/sessionStart.js";
import { executeSessionTurn } from "@main/lib/sessionTurn.js";
import { uid } from "@main/utils.js";
import { log } from "@main/lib/logger.js";
import { calculateNextRunAt, validateSchedule } from "./scheduleMath.js";
import { awaitProviderSettlement, resolveScheduledRunResult } from "./settlement.js";
import { buildScheduledPushText, createAssistantTextAccumulator, deliverScheduledPush } from "./pushMessage.js";

const TICK_MS = 30_000;
const TERMINAL_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const CANCEL_GRACE_MS = 15_000;
const FORCED_CLEANUP_ERROR = "Agent 取消后未在 15 秒内退出，任务已强制清理并自动禁用；请人工检查后再重新启用";

function validateReferences(input: Pick<ScheduledTaskCreateInput, "projectId" | "providerId">): void {
  const project = ProjectRepo.get(input.projectId);
  if (!project) throw new Error(`project not found: ${input.projectId}`);
  if (project.archived) throw new Error("cannot schedule work in an archived project");
  if (!providerRegistry.get(input.providerId)) throw new Error(`provider not found: ${input.providerId}`);
}

class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private running = new Set<string>();

  start(): void {
    if (this.timer) return;
    const recovered = ScheduledTaskRepo.recoverInterrupted();
    if (recovered > 0) log.warn(`scheduler recovered ${recovered} interrupted task(s) from the previous run`);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(): ScheduledTask[] {
    return ScheduledTaskRepo.list();
  }

  create(input: ScheduledTaskCreateInput): ScheduledTask {
    validateReferences(input);
    validateSchedule(input);
    const now = Date.now();
    const task: ScheduledTask = {
      id: uid("task_"),
      ...input,
      timeOfDay: input.timeOfDay ?? null,
      runAt: input.runAt ?? null,
      nextRunAt: input.enabled ? calculateNextRunAt(input, now) : null,
      lastRunAt: null,
      lastStatus: "idle",
      lastError: null,
      lastSessionId: null,
      lastPushStatus: "idle",
      lastPushAt: null,
      lastPushError: null,
      createdAt: now,
      updatedAt: now,
    };
    ScheduledTaskRepo.create(task);
    return task;
  }

  update(id: string, input: ScheduledTaskCreateInput): ScheduledTask {
    const existing = ScheduledTaskRepo.get(id);
    if (!existing) throw new Error(`scheduled task not found: ${id}`);
    if (this.running.has(id)) throw new Error("cannot update a running scheduled task");
    validateReferences(input);
    validateSchedule(input);
    ScheduledTaskRepo.updateDefinition(id, input, input.enabled ? calculateNextRunAt(input, Date.now()) : null);
    return ScheduledTaskRepo.get(id)!;
  }

  delete(id: string): void {
    if (!ScheduledTaskRepo.get(id)) throw new Error(`scheduled task not found: ${id}`);
    if (this.running.has(id)) throw new Error("cannot delete a running scheduled task");
    ScheduledTaskRepo.delete(id);
  }

  setEnabled(id: string, enabled: boolean): ScheduledTask {
    const task = ScheduledTaskRepo.get(id);
    if (!task) throw new Error(`scheduled task not found: ${id}`);
    if (!enabled && this.running.has(id)) throw new Error("cannot disable a running scheduled task");
    validateSchedule({ scheduleKind: task.scheduleKind, runAt: task.runAt, enabled });
    const next = enabled ? calculateNextRunAt(task, Date.now()) : null;
    ScheduledTaskRepo.setEnabled(id, enabled, next);
    return ScheduledTaskRepo.get(id)!;
  }

  async runNow(id: string): Promise<ScheduledTask> {
    const task = ScheduledTaskRepo.get(id);
    if (!task) throw new Error(`scheduled task not found: ${id}`);
    await this.run(task, false);
    return ScheduledTaskRepo.get(id)!;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // A persisted overdue next_run_at becomes one catch-up run. `run`
      // immediately advances recurring schedules past now, so it cannot replay
      // every missed occurrence after a long sleep.
      for (const task of ScheduledTaskRepo.listDue(Date.now())) {
        if (!this.running.has(task.id)) void this.run(task, true);
      }
    } catch (error) {
      log.error(`scheduler tick failed: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async run(task: ScheduledTask, scheduled: boolean): Promise<void> {
    if (this.running.has(task.id)) {
      if (!scheduled) throw new Error("scheduled task is already running");
      return;
    }
    this.running.add(task.id);
    this.markPushStarted(task);
    let sessionId: string | null = null;
    let scheduleAdvanced = false;
    let assistantText = "";
    let agentResult: { ok: boolean; error: string | null } = {
      ok: false,
      error: "Agent 任务未完成",
    };
    try {
      validateReferences(task);
      const oneTime = task.scheduleKind === "one-time";
      const nextRunAt = scheduled && !oneTime ? calculateNextRunAt(task, Date.now()) : task.nextRunAt;
      const enabled = scheduled && oneTime ? false : task.enabled;
      const { session } = createOrReuseSession({
        projectId: task.projectId,
        title: `[定时] ${task.name}`,
        providerId: task.providerId,
        effort: "default",
        // Keep unattended execution on the ordinary approval path. Any
        // approval/question event below interrupts the run instead of waiting
        // forever or silently granting access.
        permissionMode: "default",
        kind: "chat",
        envMode: "local",
      }, "desktop");
      sessionId = session.id;
      ScheduledTaskRepo.markRunning(task.id, Date.now(), session.id, nextRunAt, enabled);
      scheduleAdvanced = true;
      const terminal = this.waitForTerminal(session.id);
      try {
        await executeSessionTurn({ sessionId: session.id, prompt: task.prompt, providerId: task.providerId });
      } catch (error) {
        terminal.cancel();
        throw error;
      }
      const completion = runtimeManager.turnCompletion(session.id);
      let forcedDispose = false;
      let result: { ok: boolean; error: string | null };
      if (completion) {
        const settlement = await awaitProviderSettlement(
          completion,
          terminal.cancellation,
          TERMINAL_TIMEOUT_MS,
          CANCEL_GRACE_MS,
          () => runtimeManager.cancelTurn(session.id),
          () => runtimeManager.dispose(session.id),
        );
        forcedDispose = settlement.forced;
        terminal.providerSettled(settlement.cancellationReason ?? settlement.completionError);
        result = resolveScheduledRunResult(await terminal.promise, settlement, FORCED_CLEANUP_ERROR);
        assistantText = terminal.assistantText();
      } else {
        // A successfully dispatched turn must expose a provider handle. Treat
        // absence as an unsafe runtime state rather than waiting indefinitely.
        runtimeManager.dispose(session.id);
        terminal.cancel();
        forcedDispose = true;
        result = { ok: false, error: FORCED_CLEANUP_ERROR };
      }
      if (forcedDispose) {
        ScheduledTaskRepo.setEnabled(task.id, false, null);
      }
      SessionRepo.updateStatus(session.id, result.ok ? "done" : "errored");
      ScheduledTaskRepo.markFinished(task.id, result.ok ? "succeeded" : "failed", result.error);
      agentResult = result;
    } catch (error) {
      agentResult = { ok: false, error: (error as Error).message };
      if (sessionId) SessionRepo.updateStatus(sessionId, "errored");
      if (scheduled && !scheduleAdvanced) {
        const enabled = task.scheduleKind !== "one-time" && task.enabled;
        const next = enabled ? calculateNextRunAt(task, Date.now()) : null;
        ScheduledTaskRepo.setEnabled(task.id, enabled, next);
      }
      ScheduledTaskRepo.markFinished(task.id, "failed", (error as Error).message);
      log.error(`scheduled task ${task.id} failed: ${(error as Error).message}`);
    } finally {
      // Notification delivery is deliberately outside the Agent try/catch.
      // It is best-effort and can never reclassify an Agent run.
      try {
        await this.pushCompletion(task, agentResult, assistantText);
      } finally {
        this.running.delete(task.id);
      }
    }
  }

  private waitForTerminal(sessionId: string): {
    promise: Promise<{ ok: boolean; error: string | null }>;
    cancellation: Promise<string>;
    providerSettled: (error: string | null) => void;
    assistantText: () => string;
    cancel: () => void;
  } {
    let cancel = () => {};
    let providerSettled = (_error: string | null) => {};
    let requestCancellation!: (reason: string) => void;
    const cancellation = new Promise<string>((resolve) => { requestCancellation = resolve; });
    const assistant = createAssistantTextAccumulator();
    const promise = new Promise<{ ok: boolean; error: string | null }>((resolve) => {
      let lastError: string | null = null;
      let forcedError: string | null = null;
      let settled = false;
      const finish = (result: { ok: boolean; error: string | null }) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve(result);
      };
      const unsubscribe = runtimeManager.addObserver((event: RuntimeEvent) => {
        if (event.sessionId !== sessionId) return;
        assistant.accept(event);
        if (event.type === "error") lastError = event.message;
        if (event.type === "approval.request" || event.type === "question.ask" || event.type === "plan.approval_request") {
          forcedError = "任务需要人工确认，已停止无人值守执行";
          requestCancellation(forcedError);
        } else if (event.type === "turn.done") {
          const ok = !forcedError && event.reason !== "error" && event.reason !== "interrupted" && !lastError;
          finish({ ok, error: ok ? null : (forcedError ?? lastError ?? `turn ended: ${event.reason}`) });
        }
      });
      providerSettled = (error) => {
        // Normally turn.done already settled the observer before handle.done.
        // This fallback covers providers that reject/resolve their handle
        // without emitting a terminal event.
        if (!settled) finish({ ok: !forcedError && !error && !lastError, error: forcedError ?? error ?? lastError });
      };
      cancel = () => {
        if (settled) return;
        settled = true;
        unsubscribe();
      };
    });
    return {
      promise,
      cancellation,
      providerSettled: (error) => providerSettled(error),
      assistantText: assistant.read,
      cancel: () => cancel(),
    };
  }

  private async pushCompletion(
    task: ScheduledTask,
    result: { ok: boolean; error: string | null },
    assistantText: string,
  ): Promise<void> {
    if (!task.pushEnabled) return;
    const text = buildScheduledPushText(task.name, {
      ...result,
      assistantText,
      completedAt: Date.now(),
    });
    try {
      // Imported lazily so scheduler startup remains independent from the
      // optional notification channel's initialization lifecycle.
      const { clawBotService } = await import("@main/clawbot/ClawBotService.js");
      const push = await deliverScheduledPush(
        (message) => clawBotService.sendText(message),
        (outcome) => ScheduledTaskRepo.markPushFinished(task.id, outcome.status, outcome.error),
        text,
        (error) => log.error(`scheduled task ${task.id} could not persist notification outcome: ${error.message}`),
      );
      if (push.status === "failed") {
        log.error(`scheduled task ${task.id} notification failed: ${push.error ?? "unknown error"}`);
      }
    } catch (error) {
      // Includes lazy-import and other unexpected integration failures. Even
      // recording this failure is best-effort; neither operation may escape.
      const message = (error as Error).message;
      try {
        ScheduledTaskRepo.markPushFinished(task.id, "failed", message);
      } catch (persistError) {
        log.error(`scheduled task ${task.id} could not persist notification failure: ${(persistError as Error).message}`);
      }
      log.error(`scheduled task ${task.id} notification failed: ${message}`);
    }
  }

  private markPushStarted(task: ScheduledTask): void {
    try {
      if (task.pushEnabled) ScheduledTaskRepo.markPushPending(task.id);
      else ScheduledTaskRepo.markPushFinished(task.id, "skipped", null);
    } catch (error) {
      log.error(`scheduled task ${task.id} could not persist notification start: ${(error as Error).message}`);
    }
  }
}

export const schedulerService = new SchedulerService();
