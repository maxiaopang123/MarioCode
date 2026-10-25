/**
 * Neutral {@link StreamEvent}s → Anthropic SSE. Every delivery rule lives here,
 * once, for both upstream wires:
 *
 * - text and thinking stream live;
 * - tool calls are buffered to the end of the stream, validated, and only then
 *   published (the engine may execute on `content_block_stop`);
 * - the stop reason is derived from the whole stream, not from one label;
 * - a stream that ends without a terminal marker, or a tool call cut off by a
 *   token limit, is an error — never a silent success.
 */
import { AnthropicStreamWriter, type BufferedToolCall } from "./anthropicStreamWriter.js";
import type { StopKind, StreamEvent } from "./streamEvents.js";
import type { AnthropicSseEvent } from "./types.js";

export type UpstreamLabel = "Chat Completions" | "Responses";

const STOP_REASON: Record<StopKind, string> = { end: "end_turn", length: "max_tokens", filter: "refusal", tool: "tool_use" };

export class AnthropicEncoder {
  private writer = new AnthropicStreamWriter();
  private tools = new Map<string | number, BufferedToolCall>();
  private stop: StopKind | null = null;
  private failed = false;
  private readonly idSeed = Math.random().toString(36).slice(2, 10);

  constructor(private readonly label: UpstreamLabel) {}

  get hasFailed(): boolean { return this.failed; }

  push(events: readonly StreamEvent[]): AnthropicSseEvent[] {
    const out: AnthropicSseEvent[] = [];
    for (const ev of events) {
      if (this.failed) break;
      switch (ev.k) {
        case "start": out.push(...this.writer.start(ev.model)); break;
        case "text": out.push(...this.writer.text(ev.text)); break;
        case "think": out.push(...this.writer.thinking(ev.text)); break;
        case "usage":
          this.writer.usage = { input_tokens: ev.input, output_tokens: ev.output, cache_creation_input_tokens: ev.cacheWrite, cache_read_input_tokens: ev.cacheRead };
          break;
        case "stop": this.stop = ev.reason; break;
        case "tool": this.tool(ev); break;
        case "error":
          this.failed = true;
          out.push(...this.writer.fail(ev.message));
          break;
      }
    }
    return out;
  }

  private tool(ev: Extract<StreamEvent, { k: "tool" }>): void {
    let tool = this.tools.get(ev.key);
    if (!tool) { tool = { id: "", name: "", arguments: "" }; this.tools.set(ev.key, tool); }
    // A fragment that repeats the call's own id AND carries a name is a start
    // fragment being resent whole (some gateways do), not the next piece of a
    // split name.
    const resend = ev.id !== undefined && ev.id === tool.id && tool.name !== "";
    if (ev.id) tool.id = ev.id;
    if (ev.name) tool.name = ev.fullName || resend ? ev.name : tool.name + ev.name;
    if (ev.args) tool.arguments = ev.replace ? ev.args : tool.arguments + ev.args;
  }

  finish(): AnthropicSseEvent[] {
    if (this.failed) return [];
    if (!this.stop) {
      return this.writer.fail(this.label === "Responses"
        ? "Upstream Responses stream ended before a terminal event"
        : "Upstream Chat Completions stream ended before finish_reason");
    }
    const tools = [...this.tools.values()];
    if (this.stop === "tool" && tools.length === 0) return this.writer.fail("Upstream reported tool calls without any tool-call fragments");
    if (tools.length > 0 && (this.stop === "length" || this.stop === "filter")) return this.writer.fail(`Upstream tool call was interrupted (${this.stop})`);
    // A call the upstream never gave an id gets one. It is replayed back to us
    // verbatim in later turns, so any unique value is stable enough.
    tools.forEach((t, i) => { if (!t.id) t.id = `call_${this.idSeed}_${i}`; });
    return this.writer.finish(tools.length > 0 ? "tool_use" : STOP_REASON[this.stop], tools);
  }
}
