/** Observe delivered text/thinking deltas with a monotonic clock. Never count
 *  time after the last delta, tool execution, approval waits or idle gaps. */
export class GenerationTiming {
  private first: number | undefined;
  private start: number | undefined;
  private last = 0;
  private total = 0;
  private finished = false;
  constructor(private readonly startedAt = performance.now()) {}
  delta(now = performance.now()): void {
    if (this.finished) return;
    this.first ??= now;
    if (this.start !== undefined && now - this.last > 2000) this.pause();
    this.start ??= now;
    this.last = now;
  }
  pause(): void {
    if (this.start !== undefined) this.total += Math.max(0, this.last - this.start);
    this.start = undefined;
  }
  finish(): { generationMs?: number; firstTokenMs?: number } {
    this.pause(); this.finished = true;
    return {
      generationMs: this.total > 0 ? Math.round(this.total) : undefined,
      firstTokenMs: this.first === undefined ? undefined : Math.max(0, Math.round(this.first - this.startedAt)),
    };
  }
}
