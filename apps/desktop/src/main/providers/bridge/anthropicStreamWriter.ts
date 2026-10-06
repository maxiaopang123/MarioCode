import type { AnthropicSseEvent, AnthropicUsage } from "./types.js";
import { ThinkTagSplitter, type ThinkSegment } from "@main/lib/thinkTagSplitter.js";

export interface BufferedToolCall { id: string; name: string; arguments: string }

/** Text stays live; tool calls are published only after the complete stream is validated. */
export class AnthropicStreamWriter {
  private started = false;
  private ended = false;
  private nextIndex = 0;
  private open: { index: number; kind: "text" | "thinking" } | undefined;
  private splitter = new ThinkTagSplitter();
  private readonly id = `msg_bridge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  start(model = "bridge"): AnthropicSseEvent[] {
    if (this.started || this.ended) return [];
    this.started = true;
    return [{ type: "message_start", message: { id: this.id, type: "message", role: "assistant", content: [], model, stop_reason: null, stop_sequence: null, usage: { ...this.usage } } }];
  }
  private close(events: AnthropicSseEvent[]): void {
    if (this.open) events.push({ type: "content_block_stop", index: this.open.index });
    this.open = undefined;
  }
  private segment(seg: ThinkSegment): AnthropicSseEvent[] {
    if (this.ended) return [];
    const events: AnthropicSseEvent[] = [];
    if (this.open?.kind !== seg.kind) {
      this.close(events);
      this.open = { index: this.nextIndex++, kind: seg.kind };
      events.push({ type: "content_block_start", index: this.open.index, content_block: seg.kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "", signature: "" } });
    }
    events.push({ type: "content_block_delta", index: this.open.index, delta: seg.kind === "text" ? { type: "text_delta", text: seg.text } : { type: "thinking_delta", thinking: seg.text } });
    return events;
  }
  text(text: string): AnthropicSseEvent[] { return this.splitter.push(text).flatMap((seg) => this.segment(seg)); }
  thinking(text: string): AnthropicSseEvent[] { return this.segment({ kind: "thinking", text }); }
  fail(message: string): AnthropicSseEvent[] {
    if (this.ended) return [];
    this.ended = true;
    const events: AnthropicSseEvent[] = [];
    this.close(events);
    events.push({ type: "error", error: { type: "api_error", message } });
    return events;
  }
  finish(stopReason: string, tools: BufferedToolCall[]): AnthropicSseEvent[] {
    if (this.ended) return [];
    // Validate ALL calls before exposing any to the engine (which may execute on block_stop).
    for (const tool of tools) {
      try {
        const args: unknown = JSON.parse(tool.arguments || "{}");
        if (!args || typeof args !== "object" || Array.isArray(args) || !tool.name || !tool.id) throw new Error("Invalid tool call");
      } catch { return this.fail(`Upstream returned invalid arguments for tool ${tool.name || tool.id}`); }
    }
    const events = this.start();
    for (const seg of this.splitter.flush()) events.push(...this.segment(seg));
    this.close(events);
    for (const tool of tools) {
      const index = this.nextIndex++;
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: tool.arguments || "{}" } });
      events.push({ type: "content_block_stop", index });
    }
    events.push({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { ...this.usage } }, { type: "message_stop" });
    this.ended = true;
    return events;
  }
}
