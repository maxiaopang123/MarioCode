/**
 * 「等你处理」— sessions that are blocked on the user (界面焕新 v3).
 *
 * One definition shared by the session column's reminder bar, the project
 * rail's count badges, the status bar and the Ctrl+J jump command, so every
 * surface agrees on the number. A session needs you when it has a pending
 * tool approval, a pending plan approval, an unanswered AskUserQuestion, or
 * its last turn ended in an error (the user decided errors count too: the
 * fix is "send 继续", which is also a human action).
 *
 * Order: approvals first (they block a live turn), then plan approvals,
 * questions, errors — within a kind, insertion order, which approximates
 * "waiting longest". Archived sessions are excluded.
 */
import { useMemo } from "react";
import type { SessionState } from "@renderer/stores/sessionStore.js";
import { useSessionStore } from "@renderer/stores/sessionStore.js";

export type AttentionKind = "approval" | "plan" | "question" | "error";

export interface AttentionItem {
  sessionId: string;
  kind: AttentionKind;
}

type AttentionSlices = Pick<
  SessionState,
  | "pendingApprovals"
  | "pendingPlanApprovalBySession"
  | "pendingQuestionBySession"
  | "turnErrorBySession"
  | "archivedSessionsByProject"
>;

export function computeAttention(s: AttentionSlices): AttentionItem[] {
  // Archived sessions never wait on the user: archiving clears their signals
  // (clearArchivedSessionSignals in the store), and this guard keeps a late
  // write from bringing one back into the count.
  const archived = new Set<string>();
  for (const list of Object.values(s.archivedSessionsByProject)) {
    for (const sess of list) archived.add(sess.id);
  }
  const seen = new Set<string>();
  const out: AttentionItem[] = [];
  const push = (sessionId: string, kind: AttentionKind) => {
    if (seen.has(sessionId) || archived.has(sessionId)) return;
    seen.add(sessionId);
    out.push({ sessionId, kind });
  };
  for (const a of s.pendingApprovals) push(a.sessionId, "approval");
  for (const id of Object.keys(s.pendingPlanApprovalBySession)) push(id, "plan");
  for (const id of Object.keys(s.pendingQuestionBySession)) push(id, "question");
  for (const [id, failed] of Object.entries(s.turnErrorBySession)) if (failed) push(id, "error");
  return out;
}

/** Reactive attention list. Subscribes to the four source slices (each a
 *  stable store reference) and derives the list in a memo, so the selector
 *  never returns a fresh array per render. */
export function useAttention(): AttentionItem[] {
  const pendingApprovals = useSessionStore((s) => s.pendingApprovals);
  const pendingPlanApprovalBySession = useSessionStore((s) => s.pendingPlanApprovalBySession);
  const pendingQuestionBySession = useSessionStore((s) => s.pendingQuestionBySession);
  const turnErrorBySession = useSessionStore((s) => s.turnErrorBySession);
  const archivedSessionsByProject = useSessionStore((s) => s.archivedSessionsByProject);
  return useMemo(
    () =>
      computeAttention({
        pendingApprovals,
        pendingPlanApprovalBySession,
        pendingQuestionBySession,
        turnErrorBySession,
        archivedSessionsByProject,
      }),
    [
      pendingApprovals,
      pendingPlanApprovalBySession,
      pendingQuestionBySession,
      turnErrorBySession,
      archivedSessionsByProject,
    ],
  );
}

/** The session Ctrl+J should jump to: the item after the active one (so
 *  repeated presses cycle through everything that waits), else the first. */
export function nextAttentionSessionId(s: SessionState): string | null {
  const items = computeAttention(s);
  if (items.length === 0) return null;
  const idx = items.findIndex((x) => x.sessionId === s.activeSessionId);
  return items[(idx + 1) % items.length].sessionId;
}

/** Jump to the next session that waits on the user. No-op when none. */
export function jumpToNextAttention(): void {
  const s = useSessionStore.getState();
  const id = nextAttentionSessionId(s);
  if (id) void s.openTab(id);
}
