/**
 * Request translator: Anthropic `/v1/messages` body → OpenAI Responses API (`/v1/responses`) body.
 *
 * Same IR pipeline as the Chat translator (`parseAnthropic → normalizeIR →
 * buildResponses`), so the two OpenAI wires can no longer drift apart on the
 * cache-sensitive rules. The Responses-specific rendering — top-level
 * `instructions`, `function_call` / `function_call_output` items, typed
 * `input_image` tool output — lives in `buildResponses`.
 */
import { buildResponses } from "./irBuild.js";
import { normalizeIR } from "./irNormalize.js";
import { parseAnthropic } from "./irParse.js";
import type { AnthropicRequest, ResponsesRequest } from "./types.js";

/** Translate an Anthropic request body into an OpenAI Responses API request body. */
export function anthropicToResponses(req: AnthropicRequest): ResponsesRequest {
  return buildResponses(normalizeIR(parseAnthropic(req)));
}
