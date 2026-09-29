/**
 * Per-turn GENERATION TIME — the wall clock the model spent actually
 * streaming tokens, excluding tool execution, approval waits and network
 * stalls. Feeds the "输出速度 tok/s" numbers (TODO-023).
 *
 * Why the renderer measures it: the number the user cares about is
 * "how fast did text appear", and the renderer is where text appears. The
 * providers report only turn duration (`TurnUsageRecord.durationMs`), which
 * includes every tool call and every approval dialog — dividing output tokens
 * by that yields a figure several times too low and swings wildly with how
 * many tools a turn used.
 *
 * How a "run" is measured: the first text/thinking delta opens a run; each
 * further delta extends it. A run closes when
 *   - a tool call starts (`noteToolUse`) — the model stops emitting while the
 *     tool runs, and that gap is not generation, or
 *   - the gap since the previous delta exceeds {@link IDLE_BREAK_MS} — covers
 *     stalls with no tool event to mark them (approval prompts, gateway
 *     hiccups, a subagent taking over).
 * A turn's generation time is the sum of its runs. Single-delta runs
 * contribute 0ms, so a turn whose whole reply arrived in one chunk reports no
 * speed rather than a fabricated one.
 *
 * Module-level state on purpose: deltas arrive dozens of times per second and
 * must not trigger a store write (and therefore a render) each time. Only
 * `finishTurn` hands a number to the store, once per turn.
 */

/** A delta gap longer than this ends the current run (see above). */
const IDLE_BREAK_MS = 2_000;

interface Run {
  /** Accumulated ms of closed runs this turn. */
  acc: number;
  /** Start of the open run, or null when no run is open. */
  start: number | null;
  /** Timestamp of the most recent delta in the open run. */
  last: number;
}

const runs = new Map<string, Run>();

function get(sessionId: string): Run {
  let run = runs.get(sessionId);
  if (!run) {
    run = { acc: 0, start: null, last: 0 };
    runs.set(sessionId, run);
  }
  return run;
}

/** Close the open run, folding its span into the accumulator. */
function close(run: Run, at: number): void {
  if (run.start != null) run.acc += Math.max(0, at - run.start);
  run.start = null;
}

/** One text/thinking delta arrived for this session. */
export function noteDelta(sessionId: string, now = Date.now()): void {
  const run = get(sessionId);
  if (run.start == null) {
    run.start = now;
  } else if (now - run.last > IDLE_BREAK_MS) {
    // The stream stalled with nothing to mark it — bank the run that ended at
    // `last` and start a new one here.
    close(run, run.last);
    run.start = now;
  }
  run.last = now;
}

/** A tool call started: the model pauses, so the current run ends here. */
export function noteToolUse(sessionId: string, now = Date.now()): void {
  const run = runs.get(sessionId);
  if (!run) return;
  close(run, Math.min(now, run.last + IDLE_BREAK_MS));
}

/** Turn finished: returns its generation time in ms and resets the session's
 *  accumulator. 0 means "no measurable generation" (see the single-delta note
 *  above) — callers should treat it as unknown, not as instant. */
export function finishTurn(sessionId: string, now = Date.now()): number {
  const run = runs.get(sessionId);
  if (!run) return 0;
  close(run, Math.min(now, run.last + IDLE_BREAK_MS));
  const total = run.acc;
  runs.delete(sessionId);
  return total;
}

/** Generation time so far in the RUNNING turn (live speed readouts). */
export function currentGenMs(sessionId: string, now = Date.now()): number {
  const run = runs.get(sessionId);
  if (!run) return 0;
  const open = run.start != null ? Math.max(0, Math.min(now, run.last + IDLE_BREAK_MS) - run.start) : 0;
  return run.acc + open;
}

/** Forget a session (closed tab / deleted session / pruned history). */
export function dropGenTimer(sessionId: string): void {
  runs.delete(sessionId);
}
