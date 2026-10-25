/**
 * Intermediate representation (IR) for the Anthropic ↔ OpenAI bridge.
 *
 * Modelled on magpie's gateway design: every inbound protocol is parsed into
 * one neutral shape, ONE normalisation pass repairs it, and every outbound
 * protocol is rendered from that shape. The point is not elegance, it is prompt
 * caching: an upstream prefix cache only hits when the history re-serialises to
 * the same bytes on every turn, so equivalent spellings of the same history
 * (string vs. block content, `system` vs. `user` role, ...) must collapse to a
 * single IR value before any builder sees them.
 *
 * Only the request side lives here; the response side is the event stream in
 * `streamEvents.ts`.
 */
import type { AnthropicRequest } from "./types.js";

export type IRContent =
  | { kind: "text"; text: string }
  | { kind: "image"; mediaType: string; data: string };

export type IRPart =
  | IRContent
  /** `args` is the JSON-encoded argument object, already serialised once so
   *  every builder emits identical bytes. */
  | { kind: "call"; id: string; name: string; args: string }
  | { kind: "result"; id: string; content: IRContent[]; isError: boolean };

export interface IRMessage {
  role: "user" | "assistant";
  parts: IRPart[];
}

export interface IRTool {
  name: string;
  description?: string;
  schema: unknown;
}

export type IRToolChoice = { type: "auto" | "any" | "none" } | { type: "tool"; name: string };

export type IREffort = "low" | "medium" | "high";

export interface IRRequest {
  model: string;
  /** Concatenated top-level system prompt ("" when absent). */
  system: string;
  messages: IRMessage[];
  tools: IRTool[];
  toolChoice?: IRToolChoice;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream?: boolean;
  effort?: IREffort;
}

/** Translate Anthropic's `thinking` / `effort` config into a reasoning effort. */
export function translateReasoningEffort(req: AnthropicRequest): IREffort | undefined {
  const effort = (req.output_config?.effort ?? req.effort)?.toLowerCase();
  if (effort) {
    if (effort === "low") return "low";
    if (effort === "medium") return "medium";
    if (effort === "high" || effort === "xhigh" || effort === "max") return "high";
  }
  const thinking = req.thinking;
  if (thinking && (thinking.type === "enabled" || (typeof thinking.budget_tokens === "number" && thinking.budget_tokens > 0))) {
    const budget = thinking.budget_tokens;
    if (typeof budget === "number" && budget > 0) {
      if (budget <= 2048) return "low";
      if (budget <= 8192) return "medium";
      return "high";
    }
    return "medium";
  }
  return undefined;
}

/** Tool names that are markers, not tools. `DeferredToolPlaceholder` keeps
 *  Anthropic's deferred tool loading on and changes as ToolSearch loads
 *  definitions; an OpenAI-protocol upstream renders `tools` ahead of the
 *  conversation, so a changing list re-tokenizes the whole prompt. */
export const MARKER_TOOLS: ReadonlySet<string> = new Set(["DeferredToolPlaceholder"]);

/** Constant stand-ins used when the history is structurally incomplete. They
 *  are constants on purpose: a synthetic string that varied between turns would
 *  itself break the prefix cache. */
export const ORPHAN_RESULT_TEXT = "Tool result received.";
export const MISSING_RESULT_TEXT = "[The result of this tool call is unavailable: the turn was interrupted.]";
export const ERROR_PREFIX = "[ERROR]";

/** Join the text of a content list (images skipped). */
export function joinContentText(content: readonly IRContent[]): string {
  let out = "";
  for (const c of content) if (c.kind === "text") out += c.text;
  return out;
}

export function dataUrl(image: { mediaType: string; data: string }): string {
  return `data:${image.mediaType};base64,${image.data}`;
}
