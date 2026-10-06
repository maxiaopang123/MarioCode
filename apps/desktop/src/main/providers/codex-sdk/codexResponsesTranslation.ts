import { randomUUID } from "node:crypto";

export type WireObject = Record<string, unknown>;
export type CodexUpstreamProtocol = "chat-completions" | "anthropic";
export function object(value: unknown): WireObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as WireObject;
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }

export interface TranslatedCodexRequest {
  body: WireObject;
  customTools: Set<string>;
}

function parts(value: unknown, anthropic: boolean): WireObject[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return array(value).map((raw) => {
    const part = object(raw);
    if (["input_text", "output_text", "text"].includes(string(part.type))) return { type: "text", text: string(part.text) };
    if (part.type === "input_image") {
      const url = string(part.image_url);
      if (!url) throw new Error("Image input requires image_url; file_id is not supported by the Codex bridge");
      if (!anthropic) return { type: "image_url", image_url: { url, ...(part.detail ? { detail: part.detail } : {}) } };
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      return { type: "image", source: match ? { type: "base64", media_type: match[1], data: match[2] } : { type: "url", url } };
    }
    throw new Error(`Unsupported Responses content part: ${string(part.type)}`);
  });
}

export function translateCodexRequest(raw: unknown, protocol: CodexUpstreamProtocol, model: string, maxTokens?: number): TranslatedCodexRequest {
  const request = object(raw);
  if (request.previous_response_id) throw new Error("previous_response_id is not supported by the stateless Codex bridge; send full input history");
  const anthropic = protocol === "anthropic";
  const customTools = new Set<string>();
  const definitions = array(request.tools).map((rawTool) => {
    const tool = object(rawTool);
    if (tool.type !== "function" && tool.type !== "custom") throw new Error(`Unsupported Codex tool type: ${string(tool.type)} (tools are never silently dropped)`);
    const name = string(tool.name);
    if (!name) throw new Error("Tool definition has no name");
    let parameters = tool.parameters ?? { type: "object", properties: {} };
    let description = string(tool.description);
    if (tool.type === "custom") {
      customTools.add(name);
      const format = tool.format ? object(tool.format) : {};
      if (format.type && format.type !== "text" && format.type !== "grammar") throw new Error(`Unsupported custom tool format: ${string(format.type)}`);
      description += "\nThis is a freeform tool. Put its complete raw input in the input string, without JSON encoding inside that string.";
      if (format.type === "grammar") description += `\nThe input must follow this ${string(format.syntax)} grammar:\n${string(format.definition)}`;
      parameters = { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false };
    }
    return anthropic ? { name, description, input_schema: parameters } : { type: "function", function: { name, description, parameters, ...(tool.strict !== undefined ? { strict: tool.strict } : {}) } };
  });
  const messages: WireObject[] = [];
  const system: WireObject[] = [];
  const push = (role: string, content: WireObject[]) => {
    if (anthropic && (role === "system" || role === "developer")) { system.push(...content); return; }
    if (anthropic && messages.at(-1)?.role === role) {
      const previous = messages.at(-1)!;
      previous.content = [...array(previous.content), ...content];
    } else messages.push({ role: role === "developer" && !anthropic ? "system" : role, content });
  };
  if (request.instructions) push("system", parts(request.instructions, anthropic));
  const input = typeof request.input === "string" ? [{ role: "user", content: request.input }] : array(request.input);
  for (const rawItem of input) {
    const item = object(rawItem);
    const type = item.type ?? "message";
    if (type === "message") {
      const role = string(item.role);
      if (!["system", "developer", "user", "assistant"].includes(role)) throw new Error(`Unsupported message role: ${role}`);
      push(role, parts(item.content, anthropic));
    } else if (type === "function_call" || type === "custom_tool_call") {
      const name = string(item.name);
      const args = type === "custom_tool_call" ? JSON.stringify({ input: string(item.input) }) : string(item.arguments);
      if (anthropic) push("assistant", [{ type: "tool_use", id: item.call_id, name, input: JSON.parse(args || "{}") as unknown }]);
      else {
        const call = { id: item.call_id, type: "function", function: { name, arguments: args } };
        const previous = messages.at(-1);
        if (previous?.role === "assistant") previous.tool_calls = [...array(previous.tool_calls), call];
        else messages.push({ role: "assistant", content: null, tool_calls: [call] });
      }
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      if (anthropic) push("user", [{ type: "tool_result", tool_use_id: item.call_id, content: parts(item.output, true) }]);
      else {
        const content = typeof item.output === "string" ? item.output : parts(item.output, false);
        messages.push({ role: "tool", tool_call_id: item.call_id, content });
      }
    } else if (type === "reasoning") {
      // Responses reasoning is opaque and cannot be replayed on another protocol.
      continue;
    } else throw new Error(`Unsupported Responses input item: ${string(type)}`);
  }
  const choice = request.tool_choice;
  let toolChoice: unknown;
  if (typeof choice === "string") toolChoice = anthropic ? { type: choice === "required" ? "any" : choice } : choice;
  else if (choice) {
    const named = object(choice);
    if (named.type !== "function" && named.type !== "custom") throw new Error(`Unsupported tool_choice: ${string(named.type)}`);
    toolChoice = anthropic ? { type: "tool", name: named.name } : { type: "function", function: { name: named.name } };
  }
  if (anthropic && toolChoice && request.parallel_tool_calls === false) object(toolChoice).disable_parallel_tool_use = true;
  const requestedLimit = typeof request.max_output_tokens === "number" ? request.max_output_tokens : undefined;
  const limit = requestedLimit && maxTokens ? Math.min(requestedLimit, maxTokens) : requestedLimit ?? maxTokens;
  const body: WireObject = { model, messages, stream: true };
  if (anthropic) { body.max_tokens = limit ?? 8192; if (system.length) body.system = system; }
  else {
    body.stream_options = { include_usage: true };
    if (limit) body.max_tokens = limit;
    if (request.parallel_tool_calls !== undefined) body.parallel_tool_calls = request.parallel_tool_calls;
  }
  if (definitions.length) body.tools = definitions;
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  for (const key of ["temperature", "top_p"]) if (request[key] !== undefined) body[key] = request[key];
  return { body, customTools };
}

interface OutputState { index: number; item: WireObject; args: string; added: boolean; }

/** Incremental upstream decoder. A terminal marker is mandatory, including on clean EOF. */
export class CodexResponsesStream {
  private readonly id = `resp_${randomUUID().replaceAll("-", "")}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private sequence = 0;
  private readonly outputs: OutputState[] = [];
  private readonly calls = new Map<number, OutputState>();
  private textState?: OutputState;
  private terminal = false;
  private finishReason = "";
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedTokens = 0;
  constructor(private readonly protocol: CodexUpstreamProtocol, private readonly model: string, private readonly customTools: Set<string>, private readonly emit: (event: WireObject) => void) {}
  private event(type: string, fields: WireObject = {}): void { this.emit({ type, sequence_number: this.sequence++, ...fields }); }
  private response(status: string): WireObject {
    return { id: this.id, object: "response", created_at: this.created, status, model: this.model, output: this.outputs.filter((s) => s.added).map((s) => s.item), usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens, total_tokens: this.inputTokens + this.outputTokens, input_tokens_details: { cached_tokens: this.cachedTokens }, output_tokens_details: { reasoning_tokens: 0 } } };
  }
  start(): void { this.event("response.created", { response: this.response("in_progress") }); this.event("response.in_progress", { response: this.response("in_progress") }); }
  private add(state: OutputState): void {
    if (state.added) return;
    state.added = true;
    const item = structuredClone(state.item);
    if (item.type === "function_call") item.arguments = "";
    if (item.type === "custom_tool_call") item.input = "";
    this.event("response.output_item.added", { output_index: state.index, item });
  }
  private text(delta: string): void {
    if (!delta) return;
    if (!this.textState) {
      const state: OutputState = { index: this.outputs.length, item: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", status: "in_progress", content: [{ type: "output_text", text: "", annotations: [] }] }, args: "", added: false };
      this.textState = state; this.outputs.push(state); this.add(state);
      this.event("response.content_part.added", { item_id: state.item.id, output_index: state.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    }
    const state = this.textState;
    state.args += delta;
    object(array(state.item.content)[0]).text = state.args;
    this.event("response.output_text.delta", { item_id: state.item.id, output_index: state.index, content_index: 0, delta });
  }
  private tool(index: number, id: string, name: string, delta: string): void {
    let state = this.calls.get(index);
    if (!state) {
      state = { index: this.outputs.length, item: { id: `fc_${randomUUID()}`, type: "function_call", call_id: id, name, arguments: "", status: "in_progress" }, args: "", added: false };
      this.calls.set(index, state); this.outputs.push(state);
    }
    if (id) state.item.call_id = id;
    if (name) state.item.name = string(state.item.name) + (state.item.name === name ? "" : name);
    state.args += delta;
    const custom = this.customTools.has(string(state.item.name));
    if (custom) {
      state.item.type = "custom_tool_call"; delete state.item.arguments; state.item.input = "";
      // JSON string escapes can straddle SSE chunks; decode only when complete.
      return;
    }
    state.item.arguments = state.args;
    if (state.item.call_id && state.item.name) {
      const wasAdded = state.added;
      this.add(state);
      const fragment = wasAdded ? delta : state.args;
      if (fragment) this.event("response.function_call_arguments.delta", { item_id: state.item.id, output_index: state.index, delta: fragment });
    }
  }
  feed(data: string, eventName?: string): void {
    if (data === "[DONE]") { if (!this.finishReason) throw new Error("Chat SSE ended without finish_reason"); this.terminal = true; return; }
    const chunk = object(JSON.parse(data) as unknown);
    if (chunk.error || eventName === "error" || chunk.type === "error") throw new Error(`Upstream stream error: ${JSON.stringify(chunk.error ?? chunk)}`);
    if (this.protocol === "chat-completions") {
      if (chunk.usage) {
        const usage = object(chunk.usage);
        this.inputTokens = Number(usage.prompt_tokens ?? 0); this.outputTokens = Number(usage.completion_tokens ?? 0);
        this.cachedTokens = Number(usage.prompt_tokens_details ? object(usage.prompt_tokens_details).cached_tokens ?? 0 : usage.prompt_cache_hit_tokens ?? 0);
      }
      for (const rawChoice of array(chunk.choices)) {
        const choice = object(rawChoice);
        if (choice.index !== undefined && choice.index !== 0) continue;
        const delta = choice.delta ? object(choice.delta) : {};
        this.text(string(delta.content));
        for (const rawTool of array(delta.tool_calls)) {
          const call = object(rawTool); const fn = call.function ? object(call.function) : {};
          this.tool(Number(call.index ?? 0), string(call.id), string(fn.name), string(fn.arguments));
        }
        if (choice.finish_reason) this.finishReason = string(choice.finish_reason);
      }
    } else {
      const type = string(chunk.type) || eventName;
      if (type === "message_start") {
        const message = object(chunk.message); const usage = object(message.usage ?? {});
        this.cachedTokens = Number(usage.cache_read_input_tokens ?? 0);
        this.inputTokens = Number(usage.input_tokens ?? 0) + this.cachedTokens + Number(usage.cache_creation_input_tokens ?? 0);
      } else if (type === "content_block_start") {
        const block = object(chunk.content_block);
        if (block.type === "text") this.text(string(block.text));
        else if (block.type === "tool_use") this.tool(Number(chunk.index), string(block.id), string(block.name), Object.keys(object(block.input ?? {})).length ? JSON.stringify(block.input) : "");
      } else if (type === "content_block_delta") {
        const delta = object(chunk.delta);
        if (delta.type === "text_delta") this.text(string(delta.text));
        else if (delta.type === "input_json_delta") this.tool(Number(chunk.index), "", "", string(delta.partial_json));
      } else if (type === "message_delta") {
        this.finishReason = string(object(chunk.delta).stop_reason);
        if (chunk.usage) this.outputTokens = Number(object(chunk.usage).output_tokens ?? 0);
      } else if (type === "message_stop") { if (!this.finishReason) throw new Error("Messages SSE ended without stop_reason"); this.terminal = true; }
    }
  }
  finish(): void {
    if (!this.terminal) throw new Error("Upstream stream disconnected before its terminal marker");
    if (["length", "max_tokens", "content_filter", "refusal"].includes(this.finishReason)) throw new Error(`Upstream response is incomplete: ${this.finishReason}`);
    if (["tool_calls", "tool_use"].includes(this.finishReason) && !this.calls.size) throw new Error("Upstream announced tool calls but emitted no tools");
    for (const state of this.outputs) {
      if (state === this.textState) {
        const fields = { item_id: state.item.id, output_index: state.index, content_index: 0 };
        this.event("response.output_text.done", { ...fields, text: state.args });
        this.event("response.content_part.done", { ...fields, part: array(state.item.content)[0] });
      } else {
        if (!state.item.name || !state.item.call_id) throw new Error("Incomplete upstream tool identity");
        if (this.customTools.has(string(state.item.name))) {
          const parsed = object(JSON.parse(state.args || "{}") as unknown);
          if (typeof parsed.input !== "string") throw new Error(`Custom tool ${string(state.item.name)} requires an input string`);
          state.item.input = parsed.input;
          this.add(state);
          this.event("response.custom_tool_call_input.delta", { item_id: state.item.id, output_index: state.index, delta: parsed.input });
          this.event("response.custom_tool_call_input.done", { item_id: state.item.id, output_index: state.index, input: parsed.input });
        } else {
          JSON.parse(state.args || "{}");
          state.item.arguments = state.args || "{}";
          this.add(state);
          if (!state.args) this.event("response.function_call_arguments.delta", { item_id: state.item.id, output_index: state.index, delta: "{}" });
          this.event("response.function_call_arguments.done", { item_id: state.item.id, output_index: state.index, arguments: state.item.arguments });
        }
      }
      state.item.status = "completed";
      this.event("response.output_item.done", { output_index: state.index, item: state.item });
    }
    this.event("response.completed", { response: this.response("completed") });
  }
  fail(error: unknown): void {
    const detail = { code: "codex_bridge_error", message: error instanceof Error ? error.message : String(error) };
    this.event("response.failed", { response: { ...this.response("failed"), error: detail } });
  }
}
