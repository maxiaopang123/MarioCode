import type { AnthropicSseEvent, ResponsesSseChunk } from "./types.js";
import { AnthropicEncoder } from "./anthropicEncoder.js";
import { ResponsesStreamDecoder } from "./responsesStreamDecoder.js";

/** Responses → Anthropic SSE: wire decoder + shared encoder (see `anthropicEncoder.ts`). */
export class ResponsesToAnthropicSse {
  private decoder = new ResponsesStreamDecoder();
  private encoder = new AnthropicEncoder("Responses");

  feed(chunk: ResponsesSseChunk, eventName?: string): AnthropicSseEvent[] {
    if (this.encoder.hasFailed) return [];
    return this.encoder.push(this.decoder.decode(chunk, eventName));
  }
  finish(): AnthropicSseEvent[] { return this.encoder.finish(); }
}
