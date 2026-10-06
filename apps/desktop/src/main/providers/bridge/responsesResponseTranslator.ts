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
  /** Map: output_index / call_id / item id → Anthropic block index. */
  private toolIndexMap = new Map<string | number, number>();
  /** Tool blocks that already received their argument JSON (streamed deltas
   *  or a complete payload). Guards against re-sending full arguments from
   *  `function_call_arguments.done` / `output_item.done`. */
  private toolArgumentsFed = new Set<number>();
  private hadToolUse = false;
  private capturedFinishReason: string | null = null;
  /** Terminal upstream failure, emitted as an Anthropic error event. */
  private capturedError: string | null = null;
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
    if (this.capturedError) return events;
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

    // Capture usage if present on chunk or response object. Standard Responses
    // field is `input_tokens_details` (with the "s"); keep the single-word
    // spelling as a gateway-compatibility fallback.
    const u = chunk.usage ?? chunk.response?.usage;
    if (u) {
      const cached =
        u.input_tokens_details?.cached_tokens ??
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

    // 6. Upstream error events (top-level `error` frame) — surface as a proper
    // error stop, not a normal end. `response.failed` additionally carries the
    // message on `response.error`.
    const errMsg = chunk.error?.message ?? chunk.response?.error?.message;
    if (errMsg || eventType === "response.failed" || eventType === "error" || eventType === "response.error" || chunk.response?.status === "failed" || chunk.response?.status === "cancelled") {
      this.capturedError = errMsg ?? `Upstream response ${chunk.response?.status ?? "failed"}`;
      this.capturedFinishReason = "failed";
      this.closeOpenBlock(events);
      events.push({ type: "error", error: { type: "api_error", message: this.capturedError } });
      return events;
    }

    // 1. New function call item added. Tool blocks are created ONLY on
    // `response.output_item.added` (the single event that carries the item's
    // name/call_id). `output_item.done` and generic no-event-type payloads
    // must never re-create an existing call — that would produce duplicate
    // tool_use blocks for the same upstream function call.
    if (eventType === "response.output_item.added" && chunk.item && chunk.item.type === "function_call") {
      const item = chunk.item as { id?: string; call_id?: string; name?: string; arguments?: string };
      const callId = item.call_id ?? item.id ?? `call_${this.nextIndex}`;
      if (this.toolIndexMap.has(callId)) {
        /* already created by a prior added event — ignore duplicate */
      } else {
        const name = item.name ?? "";
        const blockIdx = this.openToolBlock(events, callId, name);
        this.toolIndexMap.set(callId, blockIdx);
        if (chunk.output_index !== undefined) this.toolIndexMap.set(chunk.output_index, blockIdx);
        if (item.id) this.toolIndexMap.set(item.id, blockIdx);
        // added events may already carry the complete arguments (some
        // gateways buffer the call before streaming deltas)
        if (typeof item.arguments === "string" && item.arguments.length > 0) {
          events.push({
            type: "content_block_delta",
            index: blockIdx,
            delta: { type: "input_json_delta", partial_json: item.arguments },
          });
          this.toolArgumentsFed.add(blockIdx);
        }
      }
    }

    // 1b. `response.output_item.done` carries the terminal item payload. A
    // function_call here must NEVER re-create the block (the `added` event
    // already did) — that would duplicate the same tool_use. Only complete an
    // existing call, and bridge the (rare) gateway that skips
    // `function_call_arguments.done` by feeding the final arguments once.
    if (eventType === "response.output_item.done" && chunk.item && chunk.item.type === "function_call") {
      const item = chunk.item as { id?: string; call_id?: string; name?: string; arguments?: string };
      const callId = item.call_id ?? item.id;
      const existing = callId !== undefined ? this.toolIndexMap.get(callId) : undefined;
      if (existing === undefined) {
        // Abnormal stream (no prior added event) — create so the call is not lost.
        const fallbackId = callId ?? `call_${this.nextIndex}`;
        if (!this.toolIndexMap.has(fallbackId)) {
          const blockIdx = this.openToolBlock(events, fallbackId, item.name ?? "");
          this.toolIndexMap.set(fallbackId, blockIdx);
          if (chunk.output_index !== undefined) this.toolIndexMap.set(chunk.output_index, blockIdx);
          if (item.id) this.toolIndexMap.set(item.id, blockIdx);
          if (item.arguments) {
            events.push({ type: "content_block_delta", index: blockIdx, delta: { type: "input_json_delta", partial_json: item.arguments } });
            this.toolArgumentsFed.add(blockIdx);
          }
        }
      } else if (!this.toolArgumentsFed.has(existing) && typeof item.arguments === "string" && item.arguments.length > 0) {
        events.push({
          type: "content_block_delta",
          index: existing,
          delta: { type: "input_json_delta", partial_json: item.arguments },
        });
        this.toolArgumentsFed.add(existing);
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

    // 4. Function call arguments: streaming deltas and the terminal
    // `function_call_arguments.done` payload (the exact `arguments` the item's
    // `output_item.done` will later repeat — fed once).
    if (
      eventType === "response.function_call_arguments.delta" ||
      eventType === "response.function_call.arguments.delta"
    ) {
      const delta = chunk.delta;
      if (typeof delta === "string" && delta.length > 0) {
        const key =
          (chunk.output_index !== undefined ? this.toolIndexMap.get(chunk.output_index) : undefined) ??
          (chunk.call_id ? this.toolIndexMap.get(chunk.call_id) : undefined) ??
          (chunk.item_id ? this.toolIndexMap.get(chunk.item_id) : undefined) ??
          (this.openBlockKind === "tool_use" ? this.openBlockIndex : NO_BLOCK);

        if (key !== undefined && key !== NO_BLOCK) {
          events.push({
            type: "content_block_delta",
            index: key,
            delta: { type: "input_json_delta", partial_json: delta },
          });
          this.toolArgumentsFed.add(key);
        }
      }
    }
    if (eventType === "response.function_call_arguments.done") {
      const args = chunk.arguments ?? chunk.delta ?? chunk.item?.arguments;
      if (typeof args === "string" && args.length > 0) {
        const key =
          (chunk.output_index !== undefined ? this.toolIndexMap.get(chunk.output_index) : undefined) ??
          (chunk.item?.call_id ? this.toolIndexMap.get(chunk.item.call_id) : undefined) ??
          (chunk.item_id ? this.toolIndexMap.get(chunk.item_id) : undefined) ??
          (this.openBlockKind === "tool_use" ? this.openBlockIndex : NO_BLOCK);
        if (key !== undefined && key !== NO_BLOCK && !this.toolArgumentsFed.has(key)) {
          events.push({
            type: "content_block_delta",
            index: key,
            delta: { type: "input_json_delta", partial_json: args },
          });
          this.toolArgumentsFed.add(key);
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

    return events;
  }

  private mapStopReason(captured: string | null): string {
    if (captured?.startsWith("error:")) return "stop_sequence";
    if (this.hadToolUse && captured !== "failed") return "tool_use";
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
    if (this.capturedError) return events;
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
