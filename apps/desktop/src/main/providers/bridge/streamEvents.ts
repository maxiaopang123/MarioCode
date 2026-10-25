/**
 * Protocol-neutral stream events (the response-side half of the IR).
 *
 * Upstream decoders (`chatStreamDecoder.ts`, `responsesStreamDecoder.ts`) turn
 * one wire's chunks into these events; `anthropicEncoder.ts` turns events into
 * Anthropic SSE. Everything protocol-specific stays in the decoders and every
 * delivery rule (tool buffering, validation, stop mapping) lives once, in the
 * encoder.
 */

/** Why the upstream stopped, already normalised across wires. */
export type StopKind = "end" | "tool" | "length" | "filter";

export type StreamEvent =
  | { k: "start"; model?: string }
  | { k: "text"; text: string }
  | { k: "think"; text: string }
  /** One fragment of a tool call. `key` identifies the call within the stream;
   *  `args` appends unless `replace` is set (a terminal snapshot is
   *  authoritative, including any tail the deltas missed). `fullName` marks a
   *  name that is always sent whole (Responses) rather than possibly split. */
  | { k: "tool"; key: string | number; id?: string; name?: string; fullName?: boolean; args?: string; replace?: boolean }
  /** Anthropic-style numbers: `input` EXCLUDES cache read and write. */
  | { k: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number }
  | { k: "stop"; reason: StopKind }
  | { k: "error"; message: string };

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** First non-zero value wins: gateways spell the same counter several ways. */
export function firstPositive(...values: unknown[]): number {
  for (const v of values) {
    const n = positive(v);
    if (n) return n;
  }
  return 0;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** OpenAI-family usage → Anthropic accounting. `prompt` includes the cached
 *  and cache-written tokens; Anthropic's `input_tokens` does not. */
export function usageEvent(prompt: unknown, output: unknown, cacheRead: number, cacheWrite: number): StreamEvent {
  return {
    k: "usage",
    input: Math.max(positive(prompt) - cacheRead - cacheWrite, 0),
    output: positive(output),
    cacheRead,
    cacheWrite,
  };
}
