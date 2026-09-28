/**
 * Sessions with an unattended background turn in flight (BackgroundTurnService
 * — the ClawBot DM runner). Deliberately import-free: the built-in tools'
 * unattended check reads it from provider code, and importing
 * BackgroundTurnService there would close a module cycle through
 * RuntimeManager → provider registry → providers.
 *
 * Counted rather than a Set so a late `finally` can never clear a newer run's
 * mark.
 */
const active = new Map<string, number>();

export function markBackgroundTurnStart(sessionId: string): void {
  active.set(sessionId, (active.get(sessionId) ?? 0) + 1);
}

export function markBackgroundTurnEnd(sessionId: string): void {
  const left = (active.get(sessionId) ?? 1) - 1;
  if (left > 0) active.set(sessionId, left);
  else active.delete(sessionId);
}

export function isBackgroundTurnRunning(sessionId: string): boolean {
  return (active.get(sessionId) ?? 0) > 0;
}
