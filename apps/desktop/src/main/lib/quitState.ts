/**
 * App-wide "a real quit is in progress" flag.
 *
 * Set by `before-quit` (tray ▸ Quit, updater quitAndInstall, OS session end)
 * and read by the close-to-tray handler (tray.ts) — a close while quitting
 * must go through, any other close only hides the window — and by
 * `second-instance` (a launch that lands mid-quit relaunches). Electron-free
 * so both sides can import it without a cycle.
 */
let quitting = false;

export function markQuitting(): void {
  quitting = true;
}

export function isQuitting(): boolean {
  return quitting;
}
