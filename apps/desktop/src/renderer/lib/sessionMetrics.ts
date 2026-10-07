/**
 * Per-session cache-hit rate and output speed (TODO-023) — one definition,
 * used by the session float panel, the reply byline chips and the composer's
 * metrics group, so the three can never disagree.
 *
 * CACHE HIT RATE = cacheRead / (input + cacheRead + cacheCreation), i.e. the
 * share of the INPUT side that came from the prompt cache. `TurnUsageRecord`
 * carries no plain `inputTokens`, so the denominator is derived:
 *   input + cacheRead + cacheCreation = totalProcessedTokens - outputTokens
 * The session average is TOKEN-WEIGHTED (sum of reads / sum of input sides),
 * not the mean of per-turn percentages — a 2-token turn must not count as
 * much as a 50k-token one.
 *
 * OUTPUT SPEED = outputTokens / generation time, where generation time comes
 * from persisted main-process delta timing and excludes tool
 * execution and waits. The session average is likewise token-weighted: total
 * output tokens over total generation time.
 *
 * Every function returns null when the inputs can't support an honest number
 * (no turns yet, a turn that never streamed, a provider that reports no cache
 * fields). Callers render "—" for null rather than 0.
 */
import type { TurnUsageRecord } from "@contracts/runtime";

/** Convert session-cumulative counters (Pi) to per-turn values before feeding
 *  the metrics below. Generation times pair by endedAt; occupancy and subagent
 *  tokens aren't cumulative.
 *  The first record uses a zero baseline, as in main/lib/usageStats.ts. */
export function normalizeSessionUsageHistory(
  history: readonly TurnUsageRecord[],
  cumulative: boolean,
): readonly TurnUsageRecord[] {
  if (!cumulative || history.length === 0) return history;
  const previousByRecord = new Map<TurnUsageRecord, TurnUsageRecord>();
  let previous: TurnUsageRecord | undefined;
  for (const record of [...history].sort((a, b) => a.endedAt - b.endedAt)) {
    if (previous) previousByRecord.set(record, previous);
    previous = record;
  }
  return history.map((record) => {
    const prev = previousByRecord.get(record);
    return {
      ...record,
      totalProcessedTokens: Math.max(0, record.totalProcessedTokens - (prev?.totalProcessedTokens ?? 0)),
      outputTokens: Math.max(0, record.outputTokens - (prev?.outputTokens ?? 0)),
      cacheReadTokens: Math.max(0, record.cacheReadTokens - (prev?.cacheReadTokens ?? 0)),
      cacheCreationTokens: Math.max(0, record.cacheCreationTokens - (prev?.cacheCreationTokens ?? 0)),
      costUsd: record.costUsd === undefined
        ? undefined
        : Math.max(0, record.costUsd - (prev?.costUsd ?? 0)),
    };
  });
}

/** One turn's measured generation time (renderer-side, see genTimer.ts).
 *  Appended once per turn, in the same order as the usage history. */
export interface TurnGenRecord {
  /** Wall clock when the turn finished — pairs this with a usage record. */
  endedAt: number;
  /** Milliseconds the model spent streaming, tools excluded. */
  genMs: number;
}

/** Input-side tokens of one turn (the cache-rate denominator). */
function inputSide(r: TurnUsageRecord): number {
  return Math.max(0, r.totalProcessedTokens - r.outputTokens);
}

/** Cache hit rate of one turn as a fraction [0,1], or null when the turn
 *  processed no input tokens (nothing to have cached). */
export function turnCacheRate(r: TurnUsageRecord | undefined): number | null {
  if (!r || r.cacheUsageKnown === false) return null;
  const denom = inputSide(r);
  if (denom <= 0) return null;
  return Math.min(1, r.cacheReadTokens / denom);
}

/** Token-weighted cache hit rate across the session, or null when no turn
 *  processed input tokens. */
export function sessionCacheRate(history: readonly TurnUsageRecord[]): number | null {
  let reads = 0;
  let denom = 0;
  for (const r of history) {
    if (r.cacheUsageKnown === false) continue;
    denom += inputSide(r);
    reads += r.cacheReadTokens;
  }
  if (denom <= 0) return null;
  return Math.min(1, reads / denom);
}

/** Output tokens per second for one turn, or null when either side is
 *  missing (a turn that streamed in a single chunk reports genMs 0). */
export function turnSpeed(outputTokens: number | undefined, genMs: number | undefined): number | null {
  if (!outputTokens || !genMs || genMs <= 0) return null;
  return (outputTokens / genMs) * 1000;
}

/** Token-weighted average speed: total output tokens over total generation
 *  time. Turns with no measured generation time are excluded from BOTH sums,
 *  so they neither inflate nor deflate the average. */
export function sessionSpeed(
  history: readonly TurnUsageRecord[],
  gens: readonly TurnGenRecord[],
): number | null {
  let tokens = 0;
  let ms = 0;
  const measured = new Map(gens.map(g => [g.endedAt, g.genMs]));
  for (const r of history) {
    const duration = r.generationMs ?? measured.get(r.endedAt);
    if (!duration || duration <= 0 || r.outputTokens <= 0) continue;
    tokens += r.outputTokens;
    ms += duration;
  }
  if (ms <= 0) return null;
  return (tokens / ms) * 1000;
}

/** Cache rate of the turn that ended at `endedAt`, or null when the history
 *  has no record for it yet (the turn-end snapshot lands a beat after
 *  turn.done).
 *
 *  `cumulative` mirrors turnTokens.ts: some providers (Pi) store
 *  session-RUNNING counters in every record, so this turn's figures are the
 *  delta against the previous record — the same rule the token receipt uses.
 *  Getting this wrong would make every Pi turn report the session-average
 *  rate instead of its own. */
export function turnCacheRateAt(
  history: readonly TurnUsageRecord[] | undefined,
  endedAt: number | undefined,
  cumulative: boolean,
): number | null {
  if (!history || endedAt === undefined) return null;
  const target = history.find((r) => r.endedAt === endedAt);
  if (!target || target.cacheUsageKnown === false) return null;
  if (!cumulative) return turnCacheRate(target);
  let prev: TurnUsageRecord | undefined;
  for (const r of history) {
    if (r.endedAt >= endedAt) continue;
    if (!prev || r.endedAt > prev.endedAt) prev = r;
  }
  if (!prev) return turnCacheRate(target);
  const denom = Math.max(0, inputSide(target) - inputSide(prev));
  const reads = Math.max(0, target.cacheReadTokens - prev.cacheReadTokens);
  if (denom <= 0) return null;
  return Math.min(1, reads / denom);
}

/** Output tokens of one turn (delta-aware, same rule as above). */
export function turnOutputTokens(
  history: readonly TurnUsageRecord[] | undefined,
  endedAt: number | undefined,
  cumulative: boolean,
): number | null {
  if (!history || endedAt === undefined) return null;
  const target = history.find((r) => r.endedAt === endedAt);
  if (!target) return null;
  if (!cumulative) return target.outputTokens;
  let prev: TurnUsageRecord | undefined;
  for (const r of history) {
    if (r.endedAt >= endedAt) continue;
    if (!prev || r.endedAt > prev.endedAt) prev = r;
  }
  return Math.max(0, target.outputTokens - (prev?.outputTokens ?? 0));
}

/** Persisted generation time for this turn, with a renderer fallback matched
 *  by the same main-process endedAt. Never borrow another turn's duration. */
export function genMsForTurn(
  history: readonly TurnUsageRecord[] | undefined,
  gens: readonly TurnGenRecord[] | undefined,
  endedAt: number | undefined,
): number | null {
  if (!history || endedAt === undefined) return null;
  const record = history.find(r => r.endedAt === endedAt);
  const ms = record?.generationMs ?? gens?.find(g => g.endedAt === endedAt)?.genMs;
  return ms && ms > 0 ? ms : null;
}

/** Per-turn cache rates for the sparkline, oldest first. Turns with no input
 *  side are dropped (they would render as a misleading 0% bar). */
export function cacheSparkline(
  history: readonly TurnUsageRecord[],
  limit = 12,
): { rate: number; endedAt: number }[] {
  const out: { rate: number; endedAt: number }[] = [];
  for (const r of history) {
    const rate = turnCacheRate(r);
    if (rate != null) out.push({ rate, endedAt: r.endedAt });
  }
  return out.slice(-limit);
}

/** 0.93 → "93%". */
export function fmtPct(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

/** 57.4 → "57". Speeds are whole tokens/s; sub-1 shows one decimal so a very
 *  slow endpoint doesn't read as "0". */
export function fmtSpeed(value: number | null): string {
  if (value == null) return "—";
  return value < 1 ? value.toFixed(1) : String(Math.round(value));
}

/** 182345 → "182k"; 1_240_000 → "1.2M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Sum of every turn's processed tokens — the float's "本会话 tokens". */
export function sessionTokens(history: readonly TurnUsageRecord[]): number {
  let total = 0;
  for (const r of history) total += r.totalProcessedTokens + (r.subagentTokens ?? 0);
  return total;
}

/** Sum of per-turn cost, or null when no turn reported one. */
export function sessionCost(history: readonly TurnUsageRecord[]): number | null {
  let total = 0;
  let seen = false;
  for (const r of history) {
    if (typeof r.costUsd === "number") {
      total += r.costUsd;
      seen = true;
    }
  }
  return seen ? total : null;
}
