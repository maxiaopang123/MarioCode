import type { AnthropicSseEvent, OpenAIChunk } from "./types.js";
import { AnthropicEncoder } from "./anthropicEncoder.js";
import { ChatStreamDecoder } from "./chatStreamDecoder.js";

/** Chat Completions → Anthropic SSE: wire decoder + shared encoder (see `anthropicEncoder.ts`). */
export class OpenAiToAnthropicSse {
  private decoder = new ChatStreamDecoder();
  private encoder = new AnthropicEncoder("Chat Completions");

  feed(chunk: OpenAIChunk): AnthropicSseEvent[] {
    if (this.encoder.hasFailed) return [];
    return this.encoder.push(this.decoder.decode(chunk));
  }
  finish(): AnthropicSseEvent[] { return this.encoder.finish(); }
}
