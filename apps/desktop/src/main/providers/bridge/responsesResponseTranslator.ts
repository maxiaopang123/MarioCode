/**
 * Response translator: OpenAI Responses API streaming SSE chunks → Anthropic SSE event stream.
 *
 * Translates OpenAI Responses API streaming events into Anthropic's block-structured stream:
 * - `response.created` / initial chunk → `message_start`
 * - `response.reasoning_text.delta` / reasoning deltas → `thinking` content block
 * - `response.text.delta` → `text` content block (via ThinkTagSplitter)
 * - `response.output_item.added` / `function_call` → `tool_use` content block
 * - `response.function_call_arguments.delta` → `input_json_delta`
 * - `response.completed` / `response.done` → `message_delta` + `message_stop`
 *
 * Also calculates and converts prompt caching tokens from Responses API's usage details
 * into Anthropic's `cache_read_input_tokens`.
 */
import type { AnthropicSseEvent, AnthropicUsage, ResponsesSseChunk } from "./types.js";
import { ThinkTagSplitter, type ThinkSegment } from "@main/lib/thinkTagSplitter.js";

const NO_BLOCK = -1;

function genMessageId(): string {
  return `msg_bridge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class ResponsesToAnthropicSse {
  private messageId = genMessageId();
  private model = "bridge";
  private started = false;
  private openBlockIndex = NO_BLOCK;
  private openBlockKind: "text" | "tool_use" | "thinking" | undefined;
  private thinkSplitter = new ThinkTagSplitter();
  private nextIndex = 0;
  /** Map: output_index / call_id → Anthropic block index. */
  private toolIndexMap = new Map<string | number, number>();
  private hadToolUse = false;
  private capturedFinishReason: string | null = null;
  private usage: AnthropicUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  private closeOpenBlock(events: AnthropicSseEvent[]): void {
    if (this.openBlockIndex !== NO_BLOCK) {
      events.push({ type: "content_block_stop", index: this.openBlockIndex });
      this.openBlockIndex = NO_BLOCK;
      this.openBlockKind = undefined;
    }
  }

  private openTextBlock(events: AnthropicSseEvent[]): number {
    this.closeOpenBlock(events);
    const index = this.nextIndex++;
    this.openBlockIndex = index;
    this.openBlockKind = "text";
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    return index;
  }

  private openToolBlock(events: AnthropicSseEvent[], id: string, name: string): number {
    this.closeOpenBlock(events);
    this.hadToolUse = true;
    const index = this.nextIndex++;
    this.openBlockIndex = index;
    this.openBlockKind = "tool_use";
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    });
    return index;
  }

  private openThinkingBlock(events: AnthropicSseEvent[]): number {
    this.closeOpenBlock(events);
    const index = this.nextIndex++;
    this.openBlockIndex = index;
    this.openBlockKind = "thinking";
    events.push({
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    return index;
  }

  private emitTextLike(events: AnthropicSseEvent[], seg: ThinkSegment): void {
    if (seg.kind === "text") {
      const index =
        this.openBlockKind === "text" ? this.openBlockIndex : this.openTextBlock(events);
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: seg.text },
      });
    } else {
      const index =
        this.openBlockKind === "thinking" ? this.openBlockIndex : this.openThinkingBlock(events);
      events.push({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: seg.text },
      });
    }
  }

  /** Process one Responses SSE chunk/event → zero or more Anthropic events. */
  feed(chunk: ResponsesSseChunk, eventName?: string): AnthropicSseEvent[] {
    const events: AnthropicSseEvent[] = [];
    const eventType = eventName ?? chunk.type ?? chunk.event;

    // First chunk emits message_start envelope
    if (!this.started) {
      if (chunk.response?.model) this.model = chunk.response.model;
      events.push({
        type: "message_start",
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { ...this.usage },
        },
      });
      this.started = true;
    }

    // Capture usage if present on chunk or response object
    const u = chunk.usage ?? chunk.response?.usage;
    if (u) {
      const cached =
        u.input_token_details?.cached_tokens ??
        u.prompt_tokens_details?.cached_tokens ??
        0;
      this.usage = {
        input_tokens: Math.max(0, (u.input_tokens ?? 0) - cached),
        output_tokens: u.output_tokens ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cached,
      };
    }

    // 6. Upstream error events — surface as a proper error stop, not end_turn.
    if (chunk.error) {
      const msg = chunk.error.message ?? "upstream error";
      this.capturedFinishReason = `error:${msg}`;
      // Close any open block, then open a fresh text block for the error.
      this.closeOpenBlock(events);
      const errorBlockIndex = this.openTextBlock(events);
      events.push({
        type: "content_block_delta",
        index: errorBlockIndex,
        delta: { type: "text_delta", text: `[Upstream Error] ${msg}` },
      });
    }

    // 1. New function call item added (deduplicated by call_id)
    if (
      eventType === "response.output_item.added" ||
      (chunk.item && (chunk.item.type === "function_call" || chunk.item.call_id))
    ) {
      const item = chunk.item;
      if (item && (item.type === "function_call" || item.call_id)) {
        const callId = item.call_id ?? item.id ?? `call_${this.nextIndex}`;
        // Dedup: if this call_id was already mapped to a block, skip re-creating it.
        const existing = this.toolIndexMap.get(callId);
        if (existing !== undefined) {
          // Already created — nothing to do.
        } else {
          const name = item.name ?? "";
          const blockIdx = this.openToolBlock(events, callId, name);
          this.toolIndexMap.set(callId, blockIdx);
          if (chunk.output_index !== undefined) {
            this.toolIndexMap.set(chunk.output_index, blockIdx);
          }
          if (item.id) {
            this.toolIndexMap.set(item.id, blockIdx);
          }
          // If arguments are already supplied in the item
          if (typeof item.arguments === "string" && item.arguments.length > 0) {
            events.push({
              type: "content_block_delta",
              index: blockIdx,
              delta: { type: "input_json_delta", partial_json: item.arguments },
            });
          }
        }
      }
    }

    // 2. Reasoning deltas
    if (
      eventType === "response.reasoning_text.delta" ||
      eventType === "response.reasoning.delta" ||
      (typeof chunk.delta === "string" && eventType?.includes("reasoning"))
    ) {
      const reasoning = chunk.delta;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        this.emitTextLike(events, { kind: "thinking", text: reasoning });
      }
    }

    // 3. Text content deltas
    if (
      eventType === "response.text.delta" ||
      eventType === "response.output_text.delta" ||
      (typeof chunk.delta === "string" && !eventType?.includes("reasoning") && !eventType?.includes("arguments"))
    ) {
      const text = chunk.delta;
      if (typeof text === "string" && text.length > 0) {
        for (const seg of this.thinkSplitter.push(text)) {
          this.emitTextLike(events, seg);
        }
      }
    }

    // 4. Function call arguments delta
    if (
      eventType === "response.function_call_arguments.delta" ||
      eventType === "response.function_call.arguments.delta"
    ) {
      const delta = chunk.delta;
      if (typeof delta === "string" && delta.length > 0) {
        const key =
          (chunk.output_index !== undefined ? this.toolIndexMap.get(chunk.output_index) : undefined) ??
          (chunk.call_id ? this.toolIndexMap.get(chunk.call_id) : undefined) ??
          this.openBlockIndex;

        if (key !== undefined && key !== NO_BLOCK) {
          events.push({
            type: "content_block_delta",
            index: key,
            delta: { type: "input_json_delta", partial_json: delta },
          });
        }
      }
    }

    // 5. Response completed/done status
    if (
      eventType === "response.completed" ||
      eventType === "response.done" ||
      chunk.response?.status
    ) {
      const status = chunk.response?.status;
      if (status) {
        this.capturedFinishReason = status;
      }
    }

    // 6. Upstream error events — surface as a proper error stop, not end_turn.
    if (chunk.error) {
      const msg = chunk.error.message ?? "upstream error";
      this.capturedFinishReason = `error:${msg}`;
      // Close any open block, then open a fresh text block for the error.
      this.closeOpenBlock(events);
      const errorBlockIndex = this.openTextBlock(events);
      events.push({
        type: "content_block_delta",
        index: errorBlockIndex,
        delta: { type: "text_delta", text: `[Upstream Error] ${msg}` },
      });
    }

    return events;
  }

  private mapStopReason(captured: string | null): string {
    if (captured?.startsWith("error:")) return "stop_sequence";
    if (this.hadToolUse) return "tool_use";
    if (!captured) return "end_turn";
    switch (captured) {
      case "completed":
        return "end_turn";
      case "incomplete":
      case "max_output_tokens":
      case "length":
        return "max_tokens";
      case "failed":
      case "cancelled":
        return "stop_sequence";
      default:
        return "end_turn";
    }
  }

  /** Close out the message after the stream ends. */
  finish(stopReason?: string | null): AnthropicSseEvent[] {
    const events: AnthropicSseEvent[] = [];
    if (!this.started) {
      events.push({
        type: "message_start",
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          content: [],
          model: this.model,
          stop_reason: null,
          stop_sequence: null,
          usage: { ...this.usage },
        },
      });
      this.started = true;
    }

    for (const seg of this.thinkSplitter.flush()) {
      this.emitTextLike(events, seg);
    }
    this.closeOpenBlock(events);

    const effectiveStopReason = stopReason ?? this.mapStopReason(this.capturedFinishReason);

    events.push({
      type: "message_delta",
      delta: {
        stop_reason: effectiveStopReason,
        stop_sequence: null,
      },
      usage: { ...this.usage },
    });
    events.push({ type: "message_stop" });

    return events;
  }

  get finishReason(): string | null {
    return this.capturedFinishReason;
  }

  get toolBlockCount(): number {
    return this.toolIndexMap.size;
  }
}
