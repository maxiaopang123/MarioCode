/**
 * OpenAI Responses SSE event → neutral {@link StreamEvent}s.
 *
 * A function call is addressed by up to four different ids across its events
 * (`output_index`, `item.id`, `call_id`, `item_id`); the alias table folds
 * them onto one stable key so the encoder sees ONE call, never two.
 */
import { firstPositive, usageEvent, type StreamEvent } from "./streamEvents.js";
import type { ResponsesSseChunk } from "./types.js";

export class ResponsesStreamDecoder {
  private aliases = new Map<string | number, number>();
  private nextKey = 0;

  private find(chunk: ResponsesSseChunk): number | undefined {
    return (chunk.output_index !== undefined ? this.aliases.get(chunk.output_index) : undefined)
      ?? (chunk.call_id ? this.aliases.get(chunk.call_id) : undefined)
      ?? (chunk.item?.call_id ? this.aliases.get(chunk.item.call_id) : undefined)
      ?? (chunk.item_id ? this.aliases.get(chunk.item_id) : undefined)
      ?? (chunk.item?.id ? this.aliases.get(chunk.item.id) : undefined);
  }

  decode(chunk: ResponsesSseChunk, eventName?: string): StreamEvent[] {
    const type = eventName ?? chunk.type ?? chunk.event ?? "";
    const error = chunk.error?.message ?? chunk.response?.error?.message;
    if (error || ["error", "response.error", "response.failed"].includes(type) || ["failed", "cancelled"].includes(chunk.response?.status ?? "")) {
      return [{ k: "error", message: error ?? `Upstream response ${chunk.response?.status ?? "failed"}` }];
    }
    const events: StreamEvent[] = [{ k: "start", model: chunk.response?.model }];

    const usage = chunk.usage ?? chunk.response?.usage;
    if (usage) {
      const cached = firstPositive(usage.input_tokens_details?.cached_tokens, usage.input_token_details?.cached_tokens, usage.prompt_tokens_details?.cached_tokens);
      events.push(usageEvent(usage.input_tokens, usage.output_tokens, cached, 0));
    }

    if ((type === "response.output_item.added" || type === "response.output_item.done") && chunk.item?.type === "function_call") {
      const item = chunk.item;
      let key = this.find(chunk);
      const isNew = key === undefined;
      if (key === undefined) key = this.nextKey++;
      if (chunk.output_index !== undefined) this.aliases.set(chunk.output_index, key);
      if (item.id) this.aliases.set(item.id, key);
      if (item.call_id) this.aliases.set(item.call_id, key);
      events.push({
        k: "tool", key, fullName: true,
        id: item.call_id ?? (isNew ? item.id : undefined),
        name: item.name,
        ...(item.arguments ? { args: item.arguments, replace: true } : {}),
      });
    }
    if (type === "response.function_call_arguments.delta" || type === "response.function_call.arguments.delta") {
      const key = this.find(chunk);
      if (key === undefined) throw new Error("Upstream tool arguments have no matching function call");
      if (typeof chunk.delta === "string") events.push({ k: "tool", key, args: chunk.delta });
    }
    if (type === "response.function_call_arguments.done") {
      const key = this.find(chunk);
      const args = chunk.arguments ?? chunk.delta ?? chunk.item?.arguments;
      if (key === undefined) throw new Error("Upstream completed arguments have no matching function call");
      // The terminal payload is authoritative, including any tail the deltas missed.
      if (typeof args === "string") events.push({ k: "tool", key, args, replace: true });
    }

    if (typeof chunk.delta === "string") {
      if (type.includes("reasoning")) events.push({ k: "think", text: chunk.delta });
      else if (type === "response.text.delta" || type === "response.output_text.delta") events.push({ k: "text", text: chunk.delta });
    }

    if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
      const status = chunk.response?.status ?? (type === "response.incomplete" ? "incomplete" : "completed");
      if (status === "completed") events.push({ k: "stop", reason: "end" });
      else if (status === "incomplete") events.push({ k: "stop", reason: "length" });
    }
    return events;
  }
}
