/** Dispose a provider handle that arrived after its SessionRuntime was removed. */
export function keepLateHandleOnlyIfCurrent<T extends object>(
  current: T | undefined,
  expected: T,
  handle: { interrupt: () => void; done: Promise<void> },
  rejectPending: () => void,
): boolean {
  if (current === expected) return true;
  // Install the rejection sink before interrupt: some providers reject done
  // synchronously from interrupt(), and it must never become unhandled.
  void handle.done.catch(() => undefined);
  try { handle.interrupt(); } catch { /* best-effort late-handle cleanup */ }
  rejectPending();
  return false;
}

export function isCurrentProviderContext<T extends object>(
  current: T | undefined,
  expected: T,
): boolean {
  return current === expected;
}

export function runIfCurrentProviderContext<T extends object, R>(
  current: T | undefined,
  expected: T,
  active: () => R,
  stale: () => R,
): R {
  return isCurrentProviderContext(current, expected) ? active() : stale();
}
