/**
 * Anthropic `/v1/messages` body → IR. Pure; no repair happens here (that is
 * `irNormalize.ts`), only a faithful, spelling-independent reading:
 *
 * - `content` as a string and as a one-text-block array parse identically;
 * - a `system`-role entry inside `messages[]` parses as a `user` message. The
 *   Claude binary appends one every turn: a block array (with `cache_control`)
 *   on the turn it is new, a plain string once replayed. Mapping it to `user`
 *   in both spellings is what keeps the replayed prefix byte-stable;
 * - `thinking` blocks are dropped (no OpenAI representation);
 * - the `DeferredToolPlaceholder` marker is not a tool.
 */
import { strip1MSuffix } from "@main/providers/claude-sdk/customEnv.js";
import {
  MARKER_TOOLS,
  translateReasoningEffort,
  type IRContent,
  type IRMessage,
  type IRPart,
  type IRRequest,
  type IRToolChoice,
} from "./ir.js";
import type { AnthropicContentBlock, AnthropicRequest, AnthropicToolChoice } from "./types.js";

function textOf(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  let out = "";
  for (const b of content) if (b.type === "text") out += b.text;
  return out;
}

/** A tool_result `content` field → IR content. Tolerates every spelling the
 *  binary and the SDK are known to produce (string, block array, bare object). */
function parseResultContent(content: unknown): IRContent[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (Array.isArray(content)) {
    const out: IRContent[] = [];
    for (const part of content as Array<{ type?: string; text?: unknown; source?: { type?: string; media_type?: string; data?: string } }>) {
      if (part?.type === "text" && typeof part.text === "string") out.push({ kind: "text", text: part.text });
      else if (part?.type === "image" && part.source?.type === "base64" && part.source.media_type && part.source.data) {
        out.push({ kind: "image", mediaType: part.source.media_type, data: part.source.data });
      }
    }
    return out;
  }
  if (content === undefined || content === null) return [];
  try { return [{ kind: "text", text: JSON.stringify(content) }]; }
  catch { return [{ kind: "text", text: String(content) }]; }
}

function parseMessage(msg: AnthropicRequest["messages"][number]): IRMessage {
  if (msg.role === "system") return { role: "user", parts: [{ kind: "text", text: textOf(msg.content) }] };
  const role = msg.role;
  if (typeof msg.content === "string") return { role, parts: [{ kind: "text", text: msg.content }] };
  const parts: IRPart[] = [];
  for (const block of msg.content) {
    if (block.type === "text") parts.push({ kind: "text", text: block.text });
    else if (block.type === "image") {
      if (block.source?.type === "base64") parts.push({ kind: "image", mediaType: block.source.media_type, data: block.source.data });
    } else if (block.type === "tool_use") {
      parts.push({ kind: "call", id: block.id, name: block.name, args: JSON.stringify(block.input ?? {}) });
    } else if (block.type === "tool_result") {
      parts.push({ kind: "result", id: block.tool_use_id, content: parseResultContent(block.content), isError: block.is_error === true });
    }
    // thinking blocks: dropped.
  }
  return { role, parts };
}

function parseToolChoice(tc: AnthropicToolChoice): IRToolChoice {
  return tc.type === "tool" ? { type: "tool", name: tc.name } : { type: tc.type };
}

export function parseAnthropic(req: AnthropicRequest): IRRequest {
  const ir: IRRequest = {
    model: strip1MSuffix(req.model),
    system: req.system === undefined ? "" : textOf(req.system),
    messages: req.messages.map(parseMessage),
    tools: (req.tools ?? [])
      .filter((t) => !MARKER_TOOLS.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, schema: t.input_schema ?? {} })),
  };
  if (req.tool_choice) ir.toolChoice = parseToolChoice(req.tool_choice);
  if (req.max_tokens !== undefined) ir.maxTokens = req.max_tokens;
  if (req.temperature !== undefined) ir.temperature = req.temperature;
  if (req.top_p !== undefined) ir.topP = req.top_p;
  if (req.stop_sequences && req.stop_sequences.length > 0) ir.stop = req.stop_sequences;
  if (req.stream !== undefined) ir.stream = req.stream;
  const effort = translateReasoningEffort(req);
  if (effort !== undefined) ir.effort = effort;
  return ir;
}
