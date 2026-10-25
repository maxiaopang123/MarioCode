/**
 * Chat Completions SSE chunk → neutral {@link StreamEvent}s. Knows the wire,
 * decides nothing about delivery (that is `anthropicEncoder.ts`).
 */
import { firstPositive, usageEvent, type StopKind, type StreamEvent } from "./streamEvents.js";
import type { OpenAIChunk } from "./types.js";

/** Unknown reasons fall back to a normal end rather than failing the turn:
 *  gateways invent finish_reasons ("eos", "end_turn", ...) and a clean stream
 *  with text must not be thrown away over a label. */
function stopKind(reason: string): StopKind {
  switch (reason) {
    case "tool_calls": case "function_call": return "tool";
    case "length": return "length";
    case "content_filter": return "filter";
    default: return "end";
  }
}

export class ChatStreamDecoder {
  private lastToolKey: string | number | undefined;

  decode(chunk: OpenAIChunk, eventName?: string): StreamEvent[] {
    if (chunk.error || chunk.type === "error" || eventName === "error") {
      return [{ k: "error", message: chunk.error?.message ?? "Upstream Chat Completions stream failed" }];
    }
    const events: StreamEvent[] = [{ k: "start", model: chunk.model }];

    const usage = chunk.usage;
    if (usage) {
      const cacheRead = firstPositive(usage.prompt_tokens_details?.cached_tokens, usage.prompt_cache_hit_tokens, usage.cached_tokens, usage.cache_read_input_tokens);
      const cacheWrite = firstPositive(usage.prompt_tokens_details?.cache_write_tokens, usage.cache_creation_input_tokens);
      events.push(usageEvent(usage.prompt_tokens, usage.completion_tokens, cacheRead, cacheWrite));
    }

    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    const reasoning = delta?.reasoning ?? delta?.reasoning_content;
    if (reasoning) events.push({ k: "think", text: reasoning });
    if (delta?.content) events.push({ k: "text", text: delta.content });
    for (const tc of delta?.tool_calls ?? []) {
      // `index` is what ties fragments together; a gateway that omits it is
      // treated as: a new id starts a call, no id continues the last one.
      let key: string | number | undefined = tc.index;
      if (key === undefined) key = tc.id ? `id:${tc.id}` : (this.lastToolKey ?? 0);
      this.lastToolKey = key;
      events.push({ k: "tool", key, id: tc.id, name: tc.function?.name, args: tc.function?.arguments });
    }
    if (choice?.finish_reason) events.push({ k: "stop", reason: stopKind(choice.finish_reason) });
    return events;
  }
}
