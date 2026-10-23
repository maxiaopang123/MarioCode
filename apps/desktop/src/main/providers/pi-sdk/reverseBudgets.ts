/**
 * Deadlines for the Pi host's REVERSE channel (pi-host → main process).
 *
 * The Pi engine runs in its own Node process; every tool call, every approval
 * prompt and every "ask the user a question" round-trip comes back over one
 * request/response channel (`piHost.ts` `reverse()`). That channel used to give
 * every method the same flat 5 minutes, which conflated two completely
 * different clocks:
 *
 *   • machine work — a tool running (bash, build, MCP call). Bounded by how
 *     long the work legitimately takes.
 *   • human work — an approval card or a question sitting on screen. Bounded
 *     by nothing. A user who steps away for six minutes is not an error.
 *
 * A single 5-minute budget for both meant the smaller of two unrelated limits
 * won: `McpToolSession` allows a tool up to 600s (`tool_timeout_sec`, capped at
 * 600_000) but the reverse channel killed the call at 300s first, so that
 * configuration was silently unreachable — and a slow build died outright.
 *
 * Policy:
 *   human   → no timer. The entry is still rejected on turn interrupt / host
 *             close (`piHost.ts` clears every pending reverse for the turn), and
 *             the turn itself is capped at 24h by the main process, so a leaked
 *             promise cannot outlive the turn.
 *   tool    → 30 min. Well above the largest legitimate tool budget (MCP's
 *             600s cap) so it only fires on a real hang, never on slow work.
 *   state   → 60s. `permissionState` is a synchronous lookup in the main
 *             process; if it takes a minute, the host is wedged.
 *
 * Exhaustive by construction: the Record is keyed by the method union, so
 * adding a reverse method without deciding its budget is a type error.
 */
import type { PiHostReverseMethod } from "./piHostProtocol.js";

/** No timer at all — the human's pace. See the module comment. */
export const REVERSE_HUMAN_TIMEOUT_MS = 0;
/** Ceiling for a single tool execution round-trip. */
export const REVERSE_TOOL_TIMEOUT_MS = 30 * 60_000;
/** Ceiling for an instantaneous main-process state lookup. */
export const REVERSE_STATE_TIMEOUT_MS = 60_000;

const BUDGETS: Record<PiHostReverseMethod, number> = {
  requestApproval: REVERSE_HUMAN_TIMEOUT_MS,
  requestUserInput: REVERSE_HUMAN_TIMEOUT_MS,
  requestPlanApproval: REVERSE_HUMAN_TIMEOUT_MS,
  permissionState: REVERSE_STATE_TIMEOUT_MS,
  browser: REVERSE_TOOL_TIMEOUT_MS,
  builtinTool: REVERSE_TOOL_TIMEOUT_MS,
  mcpTool: REVERSE_TOOL_TIMEOUT_MS,
};

/** Milliseconds to wait for `method`, or 0 for "wait indefinitely". */
export function reverseTimeoutMs(method: PiHostReverseMethod): number {
  return BUDGETS[method];
}
