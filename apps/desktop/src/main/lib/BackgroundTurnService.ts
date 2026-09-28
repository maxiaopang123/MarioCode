import type { RuntimeEvent } from "@contracts/runtime";
import type { MessageRecord, Session } from "@contracts/session";
import type { SendTurnInput } from "@contracts/ipc";
import { runtimeManager } from "@main/claude/RuntimeManager.js";
import { MessageRepo, SessionRepo } from "@main/store/repositories.js";
import { executeSessionTurn } from "@main/lib/sessionTurn.js";
import { awaitProviderSettlement } from "@main/scheduler/settlement.js";
import { uid } from "@main/utils.js";
import { markBackgroundTurnEnd, markBackgroundTurnStart } from "./backgroundTurnTracker.js";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CANCEL_GRACE_MS = 10_000;
const INTERACTION_ERROR = "后台会话需要人工确认，已安全停止；请在 MarioCode 中打开会话后继续。";
const FORCED_CLEANUP_ERROR = "后台会话未能在取消后及时退出，已强制清理。";

export interface BackgroundTurnInput {
  session: Session;
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type BackgroundTurnResult =
  | { ok: true; assistantText: string }
  | { ok: false; error: string };

interface TerminalObservation {
  promise: Promise<{ error: string | null }>;
  cancellation: Promise<string>;
  assistantText: () => string;
  assistantMessageId: () => string | null;
  providerSettled: (error: string | null) => void;
  dispose: () => void;
}

/**
 * Executes one renderer-independent turn. Interactive requests are never
 * approved: they trigger cancellation and reject the pending approval bridge.
 */
export class BackgroundTurnService {
  async run(input: BackgroundTurnInput): Promise<BackgroundTurnResult> {
    if (input.signal?.aborted) return { ok: false, error: "后台会话已取消。" };
    // Marks the session unattended for the built-in tools' approval policy
    // (see main/tools/unattended.ts) for exactly the lifetime of this turn.
    const id = input.session.id;
    markBackgroundTurnStart(id);
    try {
      return await this.runInner(input);
    } finally {
      markBackgroundTurnEnd(id);
    }
  }

  private async runInner(input: BackgroundTurnInput): Promise<BackgroundTurnResult> {
    const user = this.persistUserMessage(input.session.id, input.prompt);
    const terminal = this.observe(input.session.id, input.signal);
    try {
      const turn: SendTurnInput = {
        sessionId: input.session.id,
        prompt: input.prompt,
        userMessage: { id: user.id, createdAt: user.createdAt, blocks: user.content as unknown[] },
      };
      await executeSessionTurn(turn);
      const completion = runtimeManager.turnCompletion(input.session.id);
      if (!completion) {
        runtimeManager.dispose(input.session.id);
        return { ok: false, error: FORCED_CLEANUP_ERROR };
      }
      const settlement = await awaitProviderSettlement(
        completion,
        terminal.cancellation,
        input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        DEFAULT_CANCEL_GRACE_MS,
        () => runtimeManager.cancelTurn(input.session.id),
        () => runtimeManager.dispose(input.session.id),
      );
      if (input.signal?.aborted) return { ok: false, error: "后台会话已取消。" };
      terminal.providerSettled(settlement.cancellationReason ?? settlement.completionError);
      const observed = await terminal.promise;
      if (input.signal?.aborted) return { ok: false, error: "后台会话已取消。" };
      const error = settlement.forced
        ? FORCED_CLEANUP_ERROR
        : settlement.cancellationReason ?? settlement.completionError ?? observed.error;
      if (error) {
        SessionRepo.updateStatus(input.session.id, "errored");
        return { ok: false, error };
      }
      const assistantText = terminal.assistantText();
      if (!assistantText) {
        SessionRepo.updateStatus(input.session.id, "errored");
        return { ok: false, error: "Agent 未返回可发送的文本回复。" };
      }
      const assistantMessageId = terminal.assistantMessageId();
      if (!assistantMessageId) {
        SessionRepo.updateStatus(input.session.id, "errored");
        return { ok: false, error: "Agent 回复缺少消息标识，已停止持久化。" };
      }
      this.persistAssistantMessage(input.session.id, assistantMessageId, assistantText);
      SessionRepo.updateStatus(input.session.id, "done");
      return { ok: true, assistantText };
    } catch (error) {
      runtimeManager.cancelTurn(input.session.id);
      if (input.signal?.aborted) return { ok: false, error: "后台会话已取消。" };
      SessionRepo.updateStatus(input.session.id, "errored");
      return { ok: false, error: error instanceof Error ? error.message : "后台会话执行失败。" };
    } finally {
      terminal.dispose();
    }
  }

  private observe(sessionId: string, signal?: AbortSignal): TerminalObservation {
    let finish!: (value: { error: string | null }) => void;
    let cancel!: (reason: string) => void;
    let terminal = false;
    let lastError: string | null = null;
    let latestMessageId: string | null = null;
    const texts = new Map<string, string>();
    const promise = new Promise<{ error: string | null }>((resolve) => { finish = resolve; });
    const cancellation = new Promise<string>((resolve) => { cancel = resolve; });
    const unsubscribe = runtimeManager.addObserver((event: RuntimeEvent) => {
      if (event.sessionId !== sessionId || terminal) return;
      if (event.type === "text.delta") {
        latestMessageId = event.messageId;
        texts.set(event.messageId, `${texts.get(event.messageId) ?? ""}${event.text}`);
      } else if (event.type === "error") {
        lastError = event.message;
      } else if (
        event.type === "approval.request" ||
        event.type === "question.ask" ||
        event.type === "plan.approval_request"
      ) {
        lastError = INTERACTION_ERROR;
        cancel(INTERACTION_ERROR);
      } else if (event.type === "turn.done") {
        terminal = true;
        finish({ error: lastError ?? (event.reason === "error" || event.reason === "interrupted" ? `turn ended: ${event.reason}` : null) });
      }
    });
    const abort = () => cancel("后台会话已取消。");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    return {
      promise,
      cancellation,
      assistantText: () => latestMessageId ? (texts.get(latestMessageId) ?? "").trim() : "",
      assistantMessageId: () => latestMessageId,
      providerSettled: (error) => {
        if (terminal) return;
        terminal = true;
        finish({ error: lastError ?? error });
      },
      dispose: () => {
        terminal = true;
        unsubscribe();
        signal?.removeEventListener("abort", abort);
      },
    };
  }

  private persistUserMessage(sessionId: string, text: string): MessageRecord {
    const record: MessageRecord = {
      id: uid("u_"),
      sessionId,
      role: "user",
      content: [{ type: "text", text }],
      createdAt: Date.now(),
    };
    MessageRepo.upsertMany([record]);
    return record;
  }

  private persistAssistantMessage(sessionId: string, messageId: string, text: string): void {
    MessageRepo.upsertMany([{
      id: messageId,
      sessionId,
      role: "assistant",
      content: [{ type: "text", text }],
      createdAt: Date.now(),
    }]);
  }
}

export const backgroundTurnService = new BackgroundTurnService();
