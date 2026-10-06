/** Incremental SSE framing shared by both protocol bridges. */
export class SseDecoder {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(private readonly onFrame: (data: string, event?: string) => void) {}

  push(bytes: Uint8Array): void {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    this.drain();
  }

  finish(): void {
    this.buffer += this.decoder.decode();
    this.drain();
    if (this.buffer.trim()) this.frame(this.buffer);
    this.buffer = "";
  }

  private drain(): void {
    let separator: RegExpExecArray | null;
    while ((separator = /\r?\n\r?\n/.exec(this.buffer))) {
      this.frame(this.buffer.slice(0, separator.index));
      this.buffer = this.buffer.slice(separator.index + separator[0].length);
    }
    if (this.buffer.length > 8 * 1024 * 1024) throw new Error("Upstream SSE frame exceeds 8 MB");
  }

  private frame(value: string): void {
    if (value.length > 8 * 1024 * 1024) throw new Error("Upstream SSE frame exceeds 8 MB");
    const lines = value.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    if (data) this.onFrame(data, event);
  }
}
