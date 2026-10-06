/**
 * Request translator: Anthropic `/v1/messages` body → OpenAI Responses API (`/v1/responses`) body.
 *
 * Translates Claude binary's Anthropic requests into the OpenAI Responses API input format:
 * - `system` becomes top-level `instructions` (and/or system input message)
 * - `tool_use` assistant blocks become `{ type: "function_call", call_id, name, arguments }` items
 * - `tool_result` user blocks become `{ type: "function_call_output", call_id, output }` items
 * - user image blocks become `{ type: "input_image", image_url: "data:..." }` parts
 * - `thinking` / `effort` maps to `{ reasoning: { effort: ... } }`
 */
import { strip1MSuffix } from "@main/providers/claude-sdk/customEnv.js";
import { translateReasoningEffort } from "./requestTranslator.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTool,
  AnthropicToolChoice,
  ResponsesInputContentPart,
  ResponsesInputItem,
  ResponsesOutputTextPart,
  ResponsesRequest,
  ResponsesTool,
} from "./types.js";

/** Extract text string from a content value. */
function joinText(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** Format a tool_result content into a plain string for function_call_output. */
function formatToolResultOutput(content: unknown, isError?: boolean): string {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = (content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
  } else if (content !== undefined && content !== null) {
    try {
      text = JSON.stringify(content);
    } catch {
      text = String(content);
    }
  }
  return isError ? `[ERROR] ${text}` : text;
}

/** Translate Anthropic tools into Responses API tools. */
function translateResponsesTools(tools: AnthropicTool[]): ResponsesTool[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: (t.input_schema ?? {}) as Record<string, unknown>,
  }));
}

/** Translate Anthropic tool_choice into Responses API tool_choice. */
function translateResponsesToolChoice(
  tc: AnthropicToolChoice,
): ResponsesRequest["tool_choice"] {
  switch (tc.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", name: tc.name };
    case "none":
      return "none";
  }
}

/** Translate one Anthropic message into zero or more Responses input items. */
function translateResponsesMessage(msg: AnthropicMessage): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];

  if (typeof msg.content === "string") {
    if (msg.role === "assistant") {
      out.push({
        type: "message",
        role: msg.role,
        content: [{ type: "output_text", text: msg.content }],
      });
    } else {
      out.push({
        type: "message",
        role: msg.role,
        content: [{ type: "input_text", text: msg.content }],
      });
    }
    return out;
  }

  if (msg.role === "assistant") {
    const textParts: ResponsesOutputTextPart[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        textParts.push({ type: "output_text", text: block.text });
      } else if (block.type === "tool_use") {
        if (textParts.length > 0) {
          out.push({
            type: "message",
            role: "assistant",
            content: [...textParts],
          });
          textParts.length = 0;
        }
        out.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      }
    }
    if (textParts.length > 0) {
      out.push({
        type: "message",
        role: "assistant",
        content: textParts,
      });
    }
    return out;
  }

  // msg.role === "user"
  const userParts: ResponsesInputContentPart[] = [];
  for (const block of msg.content) {
    if (block.type === "text") {
      userParts.push({ type: "input_text", text: block.text });
    } else if (block.type === "image") {
      const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`;
      userParts.push({ type: "input_image", image_url: dataUrl });
    } else if (block.type === "tool_result") {
      if (userParts.length > 0) {
        out.push({
          type: "message",
          role: "user",
          content: [...userParts],
        });
        userParts.length = 0;
      }
      out.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output: formatToolResultOutput(block.content, block.is_error),
      });
    }
  }

  if (userParts.length > 0) {
    out.push({
      type: "message",
      role: "user",
      content: userParts,
    });
  }

  return out;
}

/** Translate an Anthropic request body into an OpenAI Responses API request body. */
export function anthropicToResponses(req: AnthropicRequest): ResponsesRequest {
  const input: ResponsesInputItem[] = [];

  let instructions: string | undefined;
  if (typeof req.system === "string" && req.system.length > 0) {
    instructions = req.system;
  } else if (Array.isArray(req.system)) {
    const sysText = joinText(req.system);
    if (sysText.length > 0) instructions = sysText;
  }

  for (const msg of req.messages) {
    input.push(...translateResponsesMessage(msg));
  }

  const out: ResponsesRequest = {
    model: strip1MSuffix(req.model),
    input,
    stream: req.stream ?? true,
  };

  if (instructions) out.instructions = instructions;
  if (req.max_tokens !== undefined) out.max_output_tokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.tools && req.tools.length > 0) out.tools = translateResponsesTools(req.tools);
  if (req.tool_choice) out.tool_choice = translateResponsesToolChoice(req.tool_choice);

  const effort = translateReasoningEffort(req);
  if (effort !== undefined) {
    out.reasoning = { effort };
  }

  return out;
}
