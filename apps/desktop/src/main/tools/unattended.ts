/**
 * "Is nobody watching this turn?" — the input to builtinToolNeedsApproval.
 *
 * A session is unattended while it runs one of the two renderer-independent
 * turn kinds, where any approval / question request cancels the run instead
 * of reaching a human:
 *  - a scheduled-task run: the task row says last_status='running' and
 *    last_session_id = this session (SchedulerService.markRunning writes both
 *    before the turn starts, and markFinished clears the status after);
 *  - a ClawBot DM turn: BackgroundTurnService marks the session in the
 *    import-free backgroundTurnTracker for exactly the turn's lifetime.
 *
 * Both signals are scoped to the live run, not to the session forever: when
 * the user later opens a "[定时] …" or ClawBot session in MarioCode and chats
 * there, that turn is interactive again (normal approvals apply). A static
 * "session belongs to the ClawBot project / conversation" check would have
 * misclassified those desktop turns.
 */
import { ScheduledTaskRepo } from "@main/store/repositories.js";
import { isBackgroundTurnRunning } from "@main/lib/backgroundTurnTracker.js";
import { log } from "@main/lib/logger.js";

export function isUnattendedSession(sessionId: string | undefined | null): boolean {
  if (!sessionId) return false;
  if (isBackgroundTurnRunning(sessionId)) return true;
  try {
    return ScheduledTaskRepo.hasRunningSession(sessionId);
  } catch (err) {
    // DB unavailable: treat as attended — the approval flow then asks (or,
    // in an unattended run, cancels), which fails safe.
    log.warn(`isUnattendedSession: scheduled-task lookup failed: ${(err as Error).message}`);
    return false;
  }
}
