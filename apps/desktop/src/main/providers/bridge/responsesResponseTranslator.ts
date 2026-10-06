import type { AnthropicSseEvent, ResponsesSseChunk } from "./types.js";
import { AnthropicStreamWriter, type BufferedToolCall } from "./anthropicStreamWriter.js";

/** Responses → Anthropic SSE. Aliases share a buffer, never an already closed block. */
export class ResponsesToAnthropicSse {
  private writer = new AnthropicStreamWriter();
  private tools: BufferedToolCall[] = [];
  private aliases = new Map<string | number, BufferedToolCall>();
  private capturedFinishReason: string | null = null;
  private failed = false;

  private find(chunk: ResponsesSseChunk): BufferedToolCall | undefined {
    return (chunk.output_index !== undefined ? this.aliases.get(chunk.output_index) : undefined)
      ?? (chunk.call_id ? this.aliases.get(chunk.call_id) : undefined)
      ?? (chunk.item?.call_id ? this.aliases.get(chunk.item.call_id) : undefined)
      ?? (chunk.item_id ? this.aliases.get(chunk.item_id) : undefined)
      ?? (chunk.item?.id ? this.aliases.get(chunk.item.id) : undefined);
  }
  feed(chunk: ResponsesSseChunk, eventName?: string): AnthropicSseEvent[] {
    if (this.failed) return [];
    const type = eventName ?? chunk.type ?? chunk.event;
    const error = chunk.error?.message ?? chunk.response?.error?.message;
    if (error || ["error", "response.error", "response.failed"].includes(type ?? "") || ["failed", "cancelled"].includes(chunk.response?.status ?? "")) {
      this.failed = true; this.capturedFinishReason = "failed";
      return this.writer.fail(error ?? `Upstream response ${chunk.response?.status ?? "failed"}`);
    }
    const events = this.writer.start(chunk.response?.model);
    const usage = chunk.usage ?? chunk.response?.usage;
    if (usage) {
      const cached = usage.input_tokens_details?.cached_tokens ?? usage.input_token_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
      this.writer.usage = { input_tokens: Math.max(0, (usage.input_tokens ?? 0) - cached), output_tokens: usage.output_tokens ?? 0, cache_creation_input_tokens: 0, cache_read_input_tokens: cached };
    }
    if (["response.output_item.added", "response.output_item.done"].includes(type ?? "") && chunk.item?.type === "function_call") {
      const item = chunk.item;
      let tool = this.find(chunk);
      if (!tool) { tool = { id: item.call_id ?? item.id ?? "", name: item.name ?? "", arguments: "" }; this.tools.push(tool); }
      if (item.call_id) tool.id = item.call_id;
      if (item.name) tool.name = item.name;
      if (chunk.output_index !== undefined) this.aliases.set(chunk.output_index, tool);
      if (item.id) this.aliases.set(item.id, tool);
      if (item.call_id) this.aliases.set(item.call_id, tool);
      if (item.arguments) tool.arguments = item.arguments;
    }
    if (["response.function_call_arguments.delta", "response.function_call.arguments.delta"].includes(type ?? "")) {
      const tool = this.find(chunk);
      if (!tool) throw new Error("Upstream tool arguments have no matching function call");
      if (typeof chunk.delta === "string") tool.arguments += chunk.delta;
    }
    if (type === "response.function_call_arguments.done") {
      const tool = this.find(chunk);
      const args = chunk.arguments ?? chunk.delta ?? chunk.item?.arguments;
      if (!tool) throw new Error("Upstream completed arguments have no matching function call");
      // The terminal payload is authoritative, including any tail missing from deltas.
      if (typeof args === "string") tool.arguments = args;
    }
    if (typeof chunk.delta === "string" && type?.includes("reasoning")) events.push(...this.writer.thinking(chunk.delta));
    else if (typeof chunk.delta === "string" && ["response.text.delta", "response.output_text.delta"].includes(type ?? "")) events.push(...this.writer.text(chunk.delta));
    if (["response.completed", "response.done", "response.incomplete"].includes(type ?? "")) {
      this.capturedFinishReason = chunk.response?.status ?? (type === "response.incomplete" ? "incomplete" : "completed");
    }
    return events;
  }
  finish(stopReason?: string | null): AnthropicSseEvent[] {
    if (this.failed) return [];
    if (!["completed", "incomplete"].includes(this.capturedFinishReason ?? "")) return this.writer.fail("Upstream Responses stream ended before a terminal event");
    if (this.tools.length && this.capturedFinishReason !== "completed") return this.writer.fail("Upstream Responses tool call was interrupted");
    return this.writer.finish(stopReason ?? (this.capturedFinishReason === "incomplete" ? "max_tokens" : this.tools.length ? "tool_use" : "end_turn"), this.tools);
  }
  get finishReason(): string | null { return this.capturedFinishReason; }
  get toolBlockCount(): number { return this.tools.length; }
}
