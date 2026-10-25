import { anthropicToOpenAI } from "@main/providers/bridge/requestTranslator.js";
import { anthropicToResponses } from "@main/providers/bridge/responsesRequestTranslator.js";
import { MISSING_RESULT_TEXT, ORPHAN_RESULT_TEXT } from "@main/providers/bridge/ir.js";
import { OpenAiToAnthropicSse } from "@main/providers/bridge/responseTranslator.js";
import { ResponsesToAnthropicSse } from "@main/providers/bridge/responsesResponseTranslator.js";
import type { AnthropicMessage, AnthropicRequest, AnthropicSseEvent, OpenAIChunk } from "@main/providers/bridge/types.js";

type Check = (name: string, condition: boolean) => void;
const req = (messages: AnthropicMessage[], extra: Partial<AnthropicRequest> = {}): AnthropicRequest => ({ model: "m", max_tokens: 100, messages, ...extra });
const json = (value: unknown): string => JSON.stringify(value);

export function runIrRegressions(check: Check): void {
  // ── cache stability: equivalent spellings collapse to identical bytes ──────
  const reminder = "<system-reminder>env</system-reminder>";
  const spellings: AnthropicMessage[][] = [
    [{ role: "user", content: "hi" }, { role: "system", content: [{ type: "text", text: reminder }] }],
    [{ role: "user", content: "hi" }, { role: "system", content: reminder }],
  ];
  check("system message: block and string spellings give identical Chat bytes", json(anthropicToOpenAI(req(spellings[0]!))) === json(anthropicToOpenAI(req(spellings[1]!))));
  check("system message: block and string spellings give identical Responses bytes", json(anthropicToResponses(req(spellings[0]!))) === json(anthropicToResponses(req(spellings[1]!))));
  check("system message goes out as a user turn on both wires", anthropicToOpenAI(req(spellings[1]!)).messages.at(-1)?.role === "user" && json(anthropicToResponses(req(spellings[1]!)).input.at(-1)).includes('"role":"user"'));
  check("string content and one-text-block content give identical bytes", json(anthropicToOpenAI(req([{ role: "user", content: "x" }]))) === json(anthropicToOpenAI(req([{ role: "user", content: [{ type: "text", text: "x" }] }]))));

  const turn1: AnthropicMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "Read", input: { p: 1 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
  ];
  const turn2: AnthropicMessage[] = [...turn1, { role: "assistant", content: "fine" }, { role: "user", content: "next" }];
  const a = anthropicToOpenAI(req(turn1)).messages, b = anthropicToOpenAI(req(turn2)).messages;
  check("Chat history is append-only across turns", json(b.slice(0, a.length)) === json(a));
  const ra = anthropicToResponses(req(turn1)).input, rb = anthropicToResponses(req(turn2)).input;
  check("Responses history is append-only across turns", json(rb.slice(0, ra.length)) === json(ra));

  // ── tool pairing ──────────────────────────────────────────────────────────
  const calls: AnthropicMessage = { role: "assistant", content: [{ type: "tool_use", id: "a", name: "R", input: {} }, { type: "tool_use", id: "b", name: "R", input: {} }] };
  const unordered = anthropicToOpenAI(req([calls, { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "B" }, { type: "tool_result", tool_use_id: "a", content: "A" }] }])).messages;
  check("Chat results are ordered like their calls", unordered[1]?.tool_call_id === "a" && unordered[2]?.tool_call_id === "b");
  const dup = anthropicToOpenAI(req([calls, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "first" }, { type: "tool_result", tool_use_id: "a", content: "second" }, { type: "tool_result", tool_use_id: "b", content: "B" }] }])).messages;
  check("duplicate result: the first one wins", dup.filter((m) => m.role === "tool").length === 2 && dup[1]?.content === "first");
  const unanswered = anthropicToOpenAI(req([calls, { role: "user", content: "never mind" }])).messages;
  check("unanswered calls get the constant synthetic result", unanswered.filter((m) => m.role === "tool").length === 2 && unanswered[1]?.content === MISSING_RESULT_TEXT && unanswered.at(-1)?.content === "never mind");
  const orphan = anthropicToOpenAI(req([{ role: "user", content: [{ type: "tool_result", tool_use_id: "zzz", content: "x" }] }])).messages;
  check("orphan result degrades to plain user text", orphan.length === 1 && orphan[0]?.role === "user" && orphan[0]?.content === ORPHAN_RESULT_TEXT);
  const respUnanswered = anthropicToResponses(req([calls, { role: "user", content: "never mind" }])).input;
  check("Responses unanswered calls get the same synthetic result", respUnanswered.filter((i) => i.type === "function_call_output").length === 2 && json(respUnanswered).includes(MISSING_RESULT_TEXT));

  // ── empty / silent messages ───────────────────────────────────────────────
  const silent = anthropicToOpenAI(req([{ role: "user", content: "a" }, { role: "assistant", content: [{ type: "thinking", thinking: "hm", signature: "s" }] }, { role: "user", content: "b" }])).messages;
  check("an assistant with only thinking is dropped, not sent empty", silent.every((m) => m.role !== "assistant"));
  check("adjacent same-role turns survive the drop", silent.length === 2);

  // ── tools ─────────────────────────────────────────────────────────────────
  const tools = [{ name: "DeferredToolPlaceholder", input_schema: { type: "object" as const } }, { name: "Read", description: "r", input_schema: { type: "object" as const } }];
  check("DeferredToolPlaceholder is not sent to either OpenAI wire", anthropicToOpenAI(req([], { tools })).tools?.length === 1 && anthropicToResponses(req([], { tools })).tools?.length === 1);
  check("a request with only the marker sends no tools field", anthropicToOpenAI(req([], { tools: [tools[0]!] })).tools === undefined);
  check("tool_choice and stop_sequences map across", anthropicToOpenAI(req([], { tool_choice: { type: "any" }, stop_sequences: ["x"] })).tool_choice === "required" && anthropicToOpenAI(req([], { stop_sequences: ["x"] })).stop?.[0] === "x");

  runIrResponseRegressions(check);
}

type Out = AnthropicSseEvent[];
const toolStarts = (events: Out) => events.filter((e): e is Extract<AnthropicSseEvent, { type: "content_block_start" }> => e.type === "content_block_start" && e.content_block.type === "tool_use");
const delta = (events: Out) => events.find((e): e is Extract<AnthropicSseEvent, { type: "message_delta" }> => e.type === "message_delta");
const chat = (...chunks: unknown[]): Out => {
  const t = new OpenAiToAnthropicSse();
  const out: Out = [];
  for (const c of chunks) out.push(...t.feed(c as OpenAIChunk));
  return [...out, ...t.finish()];
};

function runIrResponseRegressions(check: Check): void {
  // ── stop reasons ──────────────────────────────────────────────────────────
  const unknownStop = chat({ choices: [{ delta: { content: "hi" }, finish_reason: "eos" }] });
  check("Chat: an unknown finish_reason is a normal end, not a failed turn", delta(unknownStop)?.delta.stop_reason === "end_turn" && !unknownStop.some((e) => e.type === "error"));
  check("Chat: length maps to max_tokens", delta(chat({ choices: [{ delta: { content: "hi" }, finish_reason: "length" }] }))?.delta.stop_reason === "max_tokens");
  check("Chat: content_filter maps to refusal", delta(chat({ choices: [{ delta: { content: "" }, finish_reason: "content_filter" }] }))?.delta.stop_reason === "refusal");
  check("Chat: a stream with no finish_reason is an error", chat({ choices: [{ delta: { content: "hi" } }] }).some((e) => e.type === "error"));

  // ── tool assembly ─────────────────────────────────────────────────────────
  const split = chat(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Re", arguments: "{" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "ad", arguments: "}" } }] }, finish_reason: "tool_calls" }] },
  );
  check("Chat: a tool name split across chunks is joined", toolStarts(split)[0]?.content_block.type === "tool_use" && (toolStarts(split)[0]!.content_block as { name: string }).name === "Read");
  const resent = chat(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: "{" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: "}" } }] }, finish_reason: "tool_calls" }] },
  );
  check("Chat: a start fragment resent whole does not double the name", (toolStarts(resent)[0]!.content_block as { name: string }).name === "Read");
  const noId = chat({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "Read", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
  const noIdStart = toolStarts(noId)[0]?.content_block as { id: string } | undefined;
  check("Chat: a tool call without an id is given one instead of failing", !!noIdStart?.id && !noId.some((e) => e.type === "error"));
  check("Chat: tool_calls without any fragments is an error", chat({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }).some((e) => e.type === "error"));
  check("Chat: tools stay hidden when the stream is cut by max tokens", chat({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "W", arguments: "{}" } }] }, finish_reason: "length" }] }).every((e) => e.type !== "content_block_start" || e.content_block.type !== "tool_use"));

  // ── usage / cache accounting ──────────────────────────────────────────────
  const usage = (u: Record<string, unknown>) => delta(chat({ choices: [{ delta: { content: "x" }, finish_reason: "stop" }], usage: u }))!.usage;
  const nested = usage({ prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 900 } });
  check("usage: nested cached_tokens becomes cache_read and is excluded from input", nested.cache_read_input_tokens === 900 && nested.input_tokens === 100);
  check("usage: DeepSeek prompt_cache_hit_tokens is honoured", usage({ prompt_tokens: 1000, completion_tokens: 5, prompt_cache_hit_tokens: 800 }).cache_read_input_tokens === 800);
  check("usage: flat top-level cached_tokens is honoured", usage({ prompt_tokens: 1000, completion_tokens: 5, cached_tokens: 700 }).cache_read_input_tokens === 700);
  const written = usage({ prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 } });
  check("usage: cache_write_tokens is reported and excluded from input", written.cache_creation_input_tokens === 300 && written.input_tokens === 100);

  // ── Responses shares the same encoder rules ───────────────────────────────
  const r = new ResponsesToAnthropicSse();
  const rOut: Out = [];
  rOut.push(...r.feed({ item: { type: "function_call", id: "fc", call_id: "c1", name: "Read" }, output_index: 0 }, "response.output_item.added"));
  rOut.push(...r.feed({ item_id: "fc", delta: '{"a":1}' }, "response.function_call_arguments.delta"));
  rOut.push(...r.feed({ response: { status: "completed" } }, "response.completed"));
  rOut.push(...r.finish());
  check("Responses: a full-name tool call publishes once with intact name", toolStarts(rOut).length === 1 && (toolStarts(rOut)[0]!.content_block as { name: string }).name === "Read" && delta(rOut)?.delta.stop_reason === "tool_use");
  const rt = new ResponsesToAnthropicSse();
  rt.feed({ delta: "partial" }, "response.output_text.delta");
  check("Responses: ending without a terminal event is an error", rt.finish().some((e) => e.type === "error"));
}
