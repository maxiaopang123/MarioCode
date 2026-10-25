/**
 * Request translator: Anthropic `/v1/messages` body → OpenAI `/v1/chat/completions` body.
 *
 * A thin entry point over the IR pipeline (see `ir.ts`):
 *
 *   parseAnthropic  →  normalizeIR  →  buildChat
 *
 * All shape differences between the two wires live in those three modules:
 * system prompt placement, `system`-role entries inside `messages[]` (sent as
 * `user` so a replayed history stays byte-identical), tool_use/tool_result
 * pairing, images inside tool results, the `[1m]` model suffix, the
 * `DeferredToolPlaceholder` marker, and thinking/effort → `reasoning_effort`.
 */
import { buildChat } from "./irBuild.js";
import { normalizeIR } from "./irNormalize.js";
import { parseAnthropic } from "./irParse.js";
import type { AnthropicRequest, OpenAIRequest } from "./types.js";

export { translateReasoningEffort } from "./ir.js";

/** Translate an Anthropic request body into an OpenAI request body. Pure. */
export function anthropicToOpenAI(req: AnthropicRequest): OpenAIRequest {
  return buildChat(normalizeIR(parseAnthropic(req)));
}
