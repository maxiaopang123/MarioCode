/**
 * IR → upstream request bodies (Chat Completions and Responses).
 *
 * Builders only render; every repair already happened in `normalizeIR`. Key
 * order in the emitted objects is fixed (JSON.stringify follows insertion
 * order), because a reordered key is a different byte string to a prefix cache.
 */
import {
  ERROR_PREFIX,
  dataUrl,
  joinContentText,
  type IRContent,
  type IRMessage,
  type IRRequest,
  type IRToolChoice,
} from "./ir.js";
import type {
  OpenAIContentPart,
  OpenAIMessage,
  OpenAIRequest,
  OpenAITool,
  ResponsesInputContentPart,
  ResponsesInputItem,
  ResponsesOutputTextPart,
  ResponsesRequest,
} from "./types.js";

function withErrorMark(text: string, isError: boolean): string {
  if (!isError) return text;
  return text ? `${ERROR_PREFIX} ${text}` : ERROR_PREFIX;
}

/* ───────────────────────────── Chat Completions ───────────────────────────── */

function chatToolChoice(tc: IRToolChoice): OpenAIRequest["tool_choice"] {
  switch (tc.type) {
    case "auto": return "auto";
    case "any": return "required";
    case "none": return "none";
    case "tool": return { type: "function", function: { name: tc.name } };
  }
}

function chatMessages(message: IRMessage): OpenAIMessage[] {
  if (message.role === "assistant") {
    let text = "";
    const toolCalls: NonNullable<OpenAIMessage["tool_calls"]> = [];
    for (const part of message.parts) {
      if (part.kind === "text") text += part.text;
      else if (part.kind === "call") toolCalls.push({ id: part.id, type: "function", function: { name: part.name, arguments: part.args } });
    }
    const out: OpenAIMessage = { role: "assistant" };
    if (text) out.content = text;
    if (toolCalls.length > 0) out.tool_calls = toolCalls;
    if (out.content === undefined && out.tool_calls === undefined) out.content = "";
    return [out];
  }

  const out: OpenAIMessage[] = [];
  let text = "";
  const images: OpenAIContentPart[] = [];
  for (const part of message.parts) {
    if (part.kind === "result") {
      // A `tool` message carries text only; the result's images follow in ONE
      // user message after every tool message (see below), tagged by call id.
      out.push({ role: "tool", tool_call_id: part.id, content: withErrorMark(joinContentText(part.content), part.isError) });
      for (const c of part.content) {
        if (c.kind === "image") {
          images.push({ type: "text", text: `Image returned by tool call ${part.id}:` }, { type: "image_url", image_url: { url: dataUrl(c) } });
        }
      }
    } else if (part.kind === "text") text += part.text;
    else if (part.kind === "image") images.push({ type: "image_url", image_url: { url: dataUrl(part) } });
  }
  const parts: OpenAIContentPart[] = [];
  if (text) parts.push({ type: "text", text });
  parts.push(...images);
  if (parts.length > 0) out.push({ role: "user", content: images.length === 0 ? text : parts });
  return out;
}

export function buildChat(ir: IRRequest): OpenAIRequest {
  const messages: OpenAIMessage[] = [];
  if (ir.system) messages.push({ role: "system", content: ir.system });
  for (const m of ir.messages) messages.push(...chatMessages(m));

  const out: OpenAIRequest = { model: ir.model, messages, max_tokens: ir.maxTokens as number, stream: ir.stream };
  if (ir.temperature !== undefined) out.temperature = ir.temperature;
  if (ir.topP !== undefined) out.top_p = ir.topP;
  if (ir.stop) out.stop = ir.stop;
  if (ir.tools.length > 0) {
    out.tools = ir.tools.map((t): OpenAITool => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema as OpenAITool["function"]["parameters"] } }));
  }
  if (ir.toolChoice) out.tool_choice = chatToolChoice(ir.toolChoice);
  if (ir.effort !== undefined) out.reasoning_effort = ir.effort;
  return out;
}

/* ──────────────────────────────── Responses ──────────────────────────────── */

function responsesToolChoice(tc: IRToolChoice): ResponsesRequest["tool_choice"] {
  switch (tc.type) {
    case "auto": return "auto";
    case "any": return "required";
    case "none": return "none";
    case "tool": return { type: "function", name: tc.name };
  }
}

function inputPart(c: IRContent): ResponsesInputContentPart {
  return c.kind === "text" ? { type: "input_text", text: c.text } : { type: "input_image", image_url: dataUrl(c) };
}

function responsesItems(message: IRMessage): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];
  if (message.role === "assistant") {
    let texts: ResponsesOutputTextPart[] = [];
    const flush = () => {
      if (texts.length > 0) out.push({ type: "message", role: "assistant", content: texts });
      texts = [];
    };
    for (const part of message.parts) {
      if (part.kind === "text") texts.push({ type: "output_text", text: part.text });
      else if (part.kind === "call") {
        flush();
        out.push({ type: "function_call", call_id: part.id, name: part.name, arguments: part.args });
      }
    }
    flush();
    return out;
  }

  let parts: ResponsesInputContentPart[] = [];
  const flush = () => {
    if (parts.length > 0) out.push({ type: "message", role: "user", content: parts });
    parts = [];
  };
  for (const part of message.parts) {
    if (part.kind === "result") {
      flush();
      const hasImage = part.content.some((c) => c.kind === "image");
      const output: string | ResponsesInputContentPart[] = hasImage
        ? [...(part.isError ? [{ type: "input_text" as const, text: ERROR_PREFIX }] : []), ...part.content.map(inputPart)]
        : withErrorMark(joinContentText(part.content), part.isError);
      out.push({ type: "function_call_output", call_id: part.id, output });
    } else if (part.kind === "text" || part.kind === "image") parts.push(inputPart(part));
  }
  flush();
  return out;
}

export function buildResponses(ir: IRRequest): ResponsesRequest {
  const input: ResponsesInputItem[] = [];
  for (const m of ir.messages) input.push(...responsesItems(m));

  const out: ResponsesRequest = { model: ir.model, input, stream: ir.stream ?? true };
  if (ir.system) out.instructions = ir.system;
  if (ir.maxTokens !== undefined) out.max_output_tokens = ir.maxTokens;
  if (ir.temperature !== undefined) out.temperature = ir.temperature;
  if (ir.topP !== undefined) out.top_p = ir.topP;
  if (ir.tools.length > 0) {
    out.tools = ir.tools.map((t) => ({ type: "function" as const, name: t.name, description: t.description, parameters: t.schema as Record<string, unknown> }));
  }
  if (ir.toolChoice) out.tool_choice = responsesToolChoice(ir.toolChoice);
  if (ir.effort !== undefined) out.reasoning = { effort: ir.effort };
  return out;
}
