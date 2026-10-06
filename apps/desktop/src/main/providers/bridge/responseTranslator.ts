import type { AnthropicSseEvent, OpenAIChunk } from "./types.js";
import { AnthropicStreamWriter, type BufferedToolCall } from "./anthropicStreamWriter.js";

/** Chat Completions → Anthropic SSE, with independent buffers for parallel calls. */
export class OpenAiToAnthropicSse {
  private writer = new AnthropicStreamWriter();
  private tools = new Map<number, BufferedToolCall>();
  private capturedFinishReason: string | null = null;
  private failed = false;

  feed(chunk: OpenAIChunk): AnthropicSseEvent[] {
    if (this.failed) return [];
    if (chunk.error || chunk.type === "error") {
      this.failed = true;
      return this.writer.fail(chunk.error?.message ?? "Upstream Chat Completions stream failed");
    }
    const events = this.writer.start(chunk.model);
    if (chunk.usage) {
      const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens ?? 0;
      this.writer.usage = { input_tokens: Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached), output_tokens: chunk.usage.completion_tokens ?? 0, cache_creation_input_tokens: 0, cache_read_input_tokens: cached };
    }
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) this.capturedFinishReason = choice.finish_reason;
    const delta = choice?.delta;
    const reasoning = delta?.reasoning ?? delta?.reasoning_content;
    if (reasoning) events.push(...this.writer.thinking(reasoning));
    if (delta?.content) events.push(...this.writer.text(delta.content));
    for (const tc of delta?.tool_calls ?? []) {
      let tool = this.tools.get(tc.index);
      if (!tool) { tool = { id: "", name: "", arguments: "" }; this.tools.set(tc.index, tool); }
      if (tc.id) tool.id = tc.id;
      if (tc.function?.name) tool.name += tc.function.name;
      if (tc.function?.arguments) tool.arguments += tc.function.arguments;
    }
    return events;
  }
  finish(stopReason?: string | null): AnthropicSseEvent[] {
    if (this.failed) return [];
    const reason = stopReason ?? this.capturedFinishReason;
    if (!reason) return this.writer.fail("Upstream Chat Completions stream ended before finish_reason");
    if (!["stop", "tool_calls", "function_call", "length", "content_filter"].includes(reason)) return this.writer.fail(`Unknown upstream finish_reason: ${reason}`);
    if (["tool_calls", "function_call"].includes(reason) && !this.tools.size) return this.writer.fail("Upstream reported tool calls without any tool-call fragments");
    if (this.tools.size && !["tool_calls", "function_call", "stop"].includes(reason)) return this.writer.fail(`Upstream tool call was interrupted (${reason})`);
    return this.writer.finish(this.tools.size ? "tool_use" : mapStopReason(reason), [...this.tools.values()]);
  }
  get finishReason(): string | null { return this.capturedFinishReason; }
  get toolBlockCount(): number { return this.tools.size; }
  reset(): void { this.writer = new AnthropicStreamWriter(); this.tools.clear(); this.capturedFinishReason = null; this.failed = false; }
}

export function mapStopReason(reason: string | null | undefined): string {
  switch (reason) {
    case "tool_calls": case "function_call": return "tool_use";
    case "length": return "max_tokens";
    case "content_filter": return "refusal";
    default: return "end_turn";
  }
}
