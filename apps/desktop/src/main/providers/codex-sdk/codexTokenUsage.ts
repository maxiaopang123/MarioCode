/**
 * Codex usage → provider-neutral ContextSnapshot.
 *
 * The app-server's ThreadTokenUsage carries camelCase TokenUsageBreakdown
 * (`{inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens,
 * totalTokens}`) plus `modelContextWindow` — the model's real context window
 * when known (falls back to a model-family heuristic here).
 */
import type { ContextSnapshot } from "@contracts/runtime";

/** Raw usage counters as reported by app-server (TokenUsageBreakdown). */
export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens?: number;
}

/** Build the display-ready snapshot, or undefined when nothing has been
 *  reported yet (skip-emit semantics mirror the Pi adapter). */
export function buildCodexTokenSnapshot(
  usage: CodexUsage | null,
  modelContextWindow?: number,
  processedUsage: CodexUsage | null = usage,
): ContextSnapshot | undefined {
  if (!usage) return undefined;
  const inputTokens = Math.max(0, usage.inputTokens ?? 0);
  const outputTokens = Math.max(0, usage.outputTokens ?? 0);
  const processed = processedUsage ?? usage;
  const cacheRead = Math.min(Math.max(0, processed.inputTokens), Math.max(0, processed.cachedInputTokens ?? 0));
  // Codex counts reasoning output inside output_tokens; occupancy = the
  // final request's input (what the model had in context).
  // Codex inputTokens already includes cached input; never add it twice.
  const totalProcessed = Math.max(0, processed.inputTokens) + Math.max(0, processed.outputTokens);
  if (totalProcessed === 0) return undefined;

  const maxTokens = modelContextWindow && modelContextWindow > 0 ? modelContextWindow : 272_000;
  const usedTokens = Math.min(inputTokens, maxTokens);
  const pct = Math.min(100, Math.max(0, Math.round((usedTokens / maxTokens) * 100)));
  const warnings: ContextSnapshot["warnings"] = [];
  let warning: ContextSnapshot["warning"] = "ok";
  if (pct >= 90) {
    warning = "critical";
    warnings.push("near-window");
  } else if (pct >= 70) {
    warning = "near-window";
    warnings.push("near-window");
  }

  return {
    usedTokens,
    totalProcessedTokens: totalProcessed,
    maxTokens,
    outputTokens: Math.max(0, processed.outputTokens),
    cacheReadTokens: processed.cachedInputTokens === undefined ? undefined : cacheRead,
    cacheCreationTokens: processed.cacheWriteInputTokens,
    pct,
    warning,
    warnings,
  };
}

/** Thread totals provide monotonic deltas after the first response in a turn.
 *  Duplicate notifications add nothing; latest input still owns occupancy. */
export class CodexTurnUsage {
  private previous: CodexUsage | undefined;
  private sum: CodexUsage | null = null;
  observe(last: CodexUsage, total?: CodexUsage): void {
    if (!this.sum || !total || !this.previous) this.sum = { ...last };
    else {
      for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningOutputTokens"] as const) {
        const value = total[key];
        if (value !== undefined) this.sum[key] = (this.sum[key] ?? 0) + Math.max(0, value - (this.previous[key] ?? 0));
      }
    }
    this.previous = total;
  }
  get value(): CodexUsage | null { return this.sum; }
}
