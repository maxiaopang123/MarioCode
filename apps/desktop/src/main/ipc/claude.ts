import type { IpcMain } from "electron";
import { CONTEXT_POLICY_SETTING_KEY, ContextPolicySchema } from "@contracts/contextPolicy";
import {
  IPC,
  StartSessionSchema,
  ListSideChatsSchema,
  SendTurnSchema,
  InterruptSchema,
  ApproveSchema,
  RespondQuestionSchema,
  RespondPlanApprovalSchema,
  RewindTurnSchema,
  UpdateSessionSettingsSchema,
  SessionMessagesSchema,
  SaveMessagesSchema,
  UpsertMessagesSchema,
  TruncateAndInsertMessagesSchema,
  GetSettingSchema,
  SetSettingSchema,
  GetManySettingsSchema,
  UI_LOCALE_SETTING_KEY,
} from "@contracts/ipc";
import type {
  SaveMessagesInput,
  UpsertMessagesInput,
  TruncateAndInsertMessagesInput,
} from "@contracts/ipc";
import type { UserInputAnswers } from "@contracts/provider";
import { SessionRepo, ProjectRepo, MessageRepo, SettingRepo } from "@main/store/repositories.js";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { providerRegistry } from "@main/providers/registry.js";
import { refreshTrayMenu } from "@main/tray.js";
import { log } from "@main/lib/logger.js";
import { broadcastSessionChanged } from "@main/lib/sessionSync.js";
import { createOrReuseSession } from "@main/lib/sessionStart.js";
import { generateSessionTitle } from "@main/ipc/titleGen.js";
import { executeSessionTurn } from "@main/lib/sessionTurn.js";

export function registerClaudeHandlers(ipcMain: IpcMain): void {
  // ── health check: is the default provider's binary functional? ──
  ipcMain.handle("claude:healthCheck", async () => {
    const provider = providerRegistry.default;
    if (provider.healthCheck) {
      const result = await provider.healthCheck();
      return {
        installed: result.ok,
        source: result.ok ? `Agent SDK v${result.version ?? "?"}` : null,
        command: result.error ?? null,
      };
    }
    return { installed: true, source: "Agent SDK", command: null };
  });

  ipcMain.handle(IPC.CLAUDE_START_SESSION, (_evt, raw) => {
    const input = StartSessionSchema.parse(raw);
    // Reuses the project's still-fresh "New session" row when one exists —
    // only creates a new row otherwise (see createOrReuseSession).
    const { session } = createOrReuseSession(input, "desktop");
    return { session };
  });

  // Hydrate the right-panel ask tab's list view: a main session's side
  // chats, newest first. Read-only, no schema beyond the parent id.
  ipcMain.handle(IPC.CLAUDE_LIST_SIDE_CHATS, (_evt, raw) => {
    const input = ListSideChatsSchema.parse(raw);
    return { sessions: SessionRepo.listSideByParent(input.parentSessionId) };
  });

  ipcMain.handle(IPC.CLAUDE_SEND_TURN, async (_evt, raw) => {
    const input = SendTurnSchema.parse(raw);
    const { session, isFirstMessage } = await executeSessionTurn(input);
    if (isFirstMessage) {
      void generateSessionTitle(session, input.prompt).catch((err) =>
        log.warn(`title generation failed for ${input.sessionId}: ${(err as Error).message}`),
      );
    }
    return { session };
  });

  ipcMain.handle(IPC.CLAUDE_INTERRUPT, async (_evt, raw) => {
    const input = InterruptSchema.parse(raw);
    runtimeManager.interrupt(input.sessionId);
    SessionRepo.updateStatus(input.sessionId, "interrupted");
  });

  ipcMain.handle(IPC.CLAUDE_APPROVE, async (_evt, raw) => {
    const input = ApproveSchema.parse(raw);
    const resolved = runtimeManager.resolveApproval(
      input.requestId,
      input.granted,
      input.granted ? undefined : "Denied by user",
      input.always,
    );
    if (!resolved) {
      log.warn(`approval: no pending request for id ${input.requestId}`);
    }
  });

  // ── AskUserQuestion answer: resolve the provider's pending user-input
  //    Deferred. The provider's canUseTool await resumes and the turn
  //    continues in the SAME query() — this is what makes the conversation
  //    proceed after the user submits answers.
  //    For `sentinel_`-prefixed ids (fallback path when the native tool is
  //    unavailable), there's no Deferred to resolve — the turn already ended
  //    when the model finished emitting. We compose the answers into a prompt
  //    and start a new turn, prepended with a hint so the model recognizes it
  //    as the answer to its prior question.
  ipcMain.handle(IPC.CLAUDE_RESPOND_QUESTION, async (_evt, raw) => {
    const input = RespondQuestionSchema.parse(raw);

    // Dismissed: the user closed the question card. Sentinel requests have no
    // Deferred (the turn already ended) — nothing to resume; still broadcast
    // the cross-client close so other clients drop their copy of the card.
    if (input.dismissed) {
      if (input.requestId.startsWith("sentinel_")) {
        runtimeManager.notifyRequestResolved(input.sessionId, input.requestId, "question");
        return;
      }
      const resolved = runtimeManager.dismissUserInput(input.requestId);
      if (!resolved) {
        log.warn(`respondQuestion(dismiss): no pending request for id ${input.requestId}`);
      }
      return;
    }

    if (input.requestId.startsWith("sentinel_")) {
      // No Deferred exists — tell every other client to close their copy of
      // the question card (this answer was accepted from one client only).
      runtimeManager.notifyRequestResolved(input.sessionId, input.requestId, "question");
      const session = SessionRepo.get(input.sessionId);
      if (!session) {
        log.warn(`respondQuestion(sentinel): session not found ${input.sessionId}`);
        return;
      }
      const project = ProjectRepo.get(session.projectId);
      if (!project) {
        log.warn(`respondQuestion(sentinel): project not found for session ${input.sessionId}`);
        return;
      }
      const prompt = composeSentinelAnswerPrompt(input.answers);
      SessionRepo.updateStatus(session.id, "running");
      runtimeManager.bindSession(session);
      // Worktree sessions are always materialized by the time a sentinel
      // follow-up exists (the first turn created it) — route the cwd the
      // same way sendTurn does so the answer lands in the right checkout.
      await runtimeManager.sendTurn(session, {
        prompt,
        cwd: session.worktreePath ?? project.path,
      });
      return;
    }

    const resolved = runtimeManager.resolveUserInput(input.requestId, input.answers);
    if (!resolved) {
      log.warn(`respondQuestion: no pending request for id ${input.requestId}`);
    }
  });

  // ── ExitPlanMode plan-approval decision: resolve the provider's pending
  //    plan-approval Deferred. The provider's canUseTool await resumes and
  //    returns allow (exit plan mode) or deny (stay in plan mode) to the SDK,
  //    continuing the SAME query() turn.
  ipcMain.handle(IPC.CLAUDE_RESPOND_PLAN_APPROVAL, async (_evt, raw) => {
    const input = RespondPlanApprovalSchema.parse(raw);
    const resolved = runtimeManager.resolvePlanApproval(input.requestId, {
      approved: input.approved,
      editedPlan: input.editedPlan,
      reason: input.reason,
      feedback: input.feedback,
    });
    if (!resolved) {
      log.warn(`respondPlanApproval: no pending request for id ${input.requestId}`);
    }
  });

  // ── Rewind a turn: restore the given files to their pre-turn state.
  //    The renderer passes the explicit entries (the card's own frozen
  //    list), so this works for the latest turn, any historical turn,
  //    and a session reopened after restart alike. Returns the list of
  //    paths that were actually restored so the renderer can show a
  //    "N 个文件已恢复" breadcrumb. ──
  ipcMain.handle(IPC.CLAUDE_REWIND_TURN, async (_evt, raw) => {
    const input = RewindTurnSchema.parse(raw);
    const restored = await runtimeManager.rewindTurn(
      input.sessionId,
      input.files,
      input.targetFiles,
    );
    return { restored };
  });

  // ── Provider listing ──
  ipcMain.handle(IPC.PROVIDER_LIST, () => {
    const providers = providerRegistry.list().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      capabilities: p.capabilities,
    }));
    return { providers };
  });

  // ── P2: message persistence ──
  ipcMain.handle(IPC.SESSION_SAVE_MESSAGES, (_evt, raw) => {
    const input = SaveMessagesSchema.parse(raw) as SaveMessagesInput;
    MessageRepo.replaceAll(input.sessionId, input.messages);
  });

  ipcMain.handle(IPC.SESSION_UPSERT_MESSAGES, (_evt, raw) => {
    const input = UpsertMessagesSchema.parse(raw) as UpsertMessagesInput;
    MessageRepo.upsertMany(input.messages);
  });

  ipcMain.handle(IPC.SESSION_TRUNCATE_AND_INSERT_MESSAGES, (_evt, raw) => {
    const input = TruncateAndInsertMessagesSchema.parse(raw) as TruncateAndInsertMessagesInput;
    MessageRepo.truncateFromAndInsert(
      input.sessionId,
      { createdAt: input.cursorCreatedAt, id: input.cursorId },
      input.messages,
    );
  });

  ipcMain.handle(IPC.SESSION_MESSAGES, (_evt, raw) => {
    const input = SessionMessagesSchema.parse(raw);
    const res = MessageRepo.listBySession(input.sessionId, {
      limit: input.limit,
      beforeCreatedAt: input.beforeCreatedAt,
      beforeId: input.beforeId,
    });
    return { messages: res.messages, hasMore: res.hasMore };
  });

  // ── Settings ──
  ipcMain.handle(IPC.SETTING_GET, (_evt, raw) => {
    const input = GetSettingSchema.parse(raw);
    return { value: SettingRepo.get(input.key) };
  });

  ipcMain.handle(IPC.SETTING_SET, (_evt, raw) => {
    const input = SetSettingSchema.parse(raw);
    if (input.key === CONTEXT_POLICY_SETTING_KEY) ContextPolicySchema.parse(JSON.parse(input.value));
    SettingRepo.set(input.key, input.value);
    // Tray menu labels follow the UI language (no-op without a tray).
    if (input.key === UI_LOCALE_SETTING_KEY) refreshTrayMenu();
  });

  ipcMain.handle(IPC.SETTING_GET_MANY, (_evt, raw) => {
    const input = GetManySettingsSchema.parse(raw);
    return SettingRepo.getMany(input.keys);
  });

  // ── Per-session settings (model / effort / permissionMode / customModelId) ──
  // Persist to DB AND, when permissionMode is present, sync the live value
  // into the ApprovalBridge so a mid-turn mode flip takes effect for the
  // next tool call (canUseTool reads the bridge's current value).
  ipcMain.handle(IPC.SESSION_UPDATE_SETTINGS, (_evt, raw) => {
    const input = UpdateSessionSettingsSchema.parse(raw);
    // Directory re-aim (new-session panel's directory switcher). Honored
    // ONLY for a thread that hasn't started — no persisted messages, no
    // materialized worktree — and only onto an existing non-archived
    // project. Anything else rejects the WHOLE call so the renderer keeps
    // its caches instead of half-applying a move.
    if (input.projectId !== undefined) {
      const sess = SessionRepo.get(input.sessionId);
      if (!sess) throw new Error(`updateSettings: unknown session ${input.sessionId}`);
      const target = ProjectRepo.get(input.projectId);
      if (!target || target.archived) {
        throw new Error("updateSettings: move target project missing or archived");
      }
      if (sess.worktreePath) {
        throw new Error("updateSettings: session already materialized in a worktree");
      }
      if (MessageRepo.hasAny(input.sessionId)) {
        throw new Error("updateSettings: session already has messages");
      }
      if (sess.projectId !== input.projectId) {
        SessionRepo.updateSettings(input.sessionId, { projectId: input.projectId });
      }
    }
    SessionRepo.updateSettings(input.sessionId, {
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
      customModelId: input.customModelId,
      providerId: input.providerId,
      envMode: input.envMode,
      wtStyle: input.wtStyle,
    });
    if (input.permissionMode) {
      runtimeManager.setPermissionMode(input.sessionId, input.permissionMode);
    }
    // Broadcast the fresh row so every other client (phones) re-syncs its
    // session list AND its composer chips for this thread.
    const updated = SessionRepo.get(input.sessionId);
    if (updated) broadcastSessionChanged(updated);
  });
}

/**
 * Compose the user's answers (from sentinel-fallback AskUserQuestion) into a
 * prompt for the next turn. The sentinel path can't block the SDK turn, so we
 * send answers as a new user message prefixed with a hint so the model knows
 * these are answers to its prior question, not a fresh instruction.
 */
function composeSentinelAnswerPrompt(answers: UserInputAnswers): string {
  const lines: string[] = ["(Answers to your previous question:)"];
  for (const [question, answer] of Object.entries(answers)) {
    if (answer == null) continue;
    const value = Array.isArray(answer) ? answer.join(", ") : answer;
    lines.push(`${question}\n→ ${value}`);
  }
  return lines.join("\n\n");
}
