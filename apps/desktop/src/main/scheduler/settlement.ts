export interface SettlementResult {
  forced: boolean;
  completionError: string | null;
  cancellationReason: string | null;
}

export interface ScheduledRunResult {
  ok: boolean;
  error: string | null;
}

/** Provider settlement is authoritative over an earlier optimistic
 * turn.done event. In particular a hard-deadline cancellation must never be
 * recorded as succeeded merely because turn.done arrived first. */
export function resolveScheduledRunResult(
  terminal: ScheduledRunResult,
  settlement: SettlementResult,
  forcedCleanupError: string,
): ScheduledRunResult {
  if (settlement.forced) return { ok: false, error: forcedCleanupError };
  if (settlement.cancellationReason) return { ok: false, error: settlement.cancellationReason };
  if (settlement.completionError) return { ok: false, error: settlement.completionError };
  return terminal;
}

/** Wait for normal provider settlement, but once cancellation is requested
 * only grant a finite cleanup window before the caller force-disposes it. */
export async function awaitProviderSettlement(
  completion: Promise<void>,
  externalCancellation: Promise<string>,
  normalTimeoutMs: number,
  graceMs: number,
  onCancel: (reason: string) => void,
  onForce: () => void,
): Promise<SettlementResult> {
  const settled = completion.then(
    () => ({ kind: "settled" as const, error: null }),
    (error) => ({ kind: "settled" as const, error: (error as Error).message }),
  );
  let normalTimer: NodeJS.Timeout | null = null;
  const normalDeadline = new Promise<{ kind: "cancelled"; reason: string }>((resolve) => {
    normalTimer = setTimeout(
      () => resolve({ kind: "cancelled", reason: "scheduled task timed out" }),
      normalTimeoutMs,
    );
    normalTimer.unref();
  });
  const first = await Promise.race([
    settled,
    externalCancellation.then((reason) => ({ kind: "cancelled" as const, reason })),
    normalDeadline,
  ]);
  if (first.kind === "settled") {
    if (normalTimer) clearTimeout(normalTimer);
    return { forced: false, completionError: first.error, cancellationReason: null };
  }
  if (normalTimer) clearTimeout(normalTimer);
  onCancel(first.reason);

  let timer: NodeJS.Timeout | null = null;
  const grace = new Promise<{ kind: "grace" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "grace" }), graceMs);
    timer.unref();
  });
  const afterCancel = await Promise.race([settled, grace]);
  if (timer) clearTimeout(timer);
  if (afterCancel.kind === "settled") {
    return { forced: false, completionError: afterCancel.error, cancellationReason: first.reason };
  }
  onForce();
  return { forced: true, completionError: null, cancellationReason: first.reason };
}
