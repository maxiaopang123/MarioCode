import { anthropicToOpenAI } from "@main/providers/bridge/requestTranslator.js";
import { anthropicToResponses } from "@main/providers/bridge/responsesRequestTranslator.js";
import { OpenAiToAnthropicSse } from "@main/providers/bridge/responseTranslator.js";
import { ResponsesToAnthropicSse } from "@main/providers/bridge/responsesResponseTranslator.js";
import { startBridge } from "@main/providers/bridge/bridgeServer.js";
import { SseDecoder } from "@main/providers/bridge/sseDecoder.js";
import type { AnthropicRequest, AnthropicSseEvent } from "@main/providers/bridge/types.js";
import { CodexResponsesStream, translateCodexRequest, object, type WireObject } from "@main/providers/codex-sdk/codexResponsesTranslation.js";

type Check = (name: string, condition: boolean) => void;
function blocks(events: AnthropicSseEvent[]): { valid: boolean; args: string[] } {
  const open = new Set<number>();
  const args = new Map<number, string>();
  let valid = true;
  for (const event of events) {
    if (event.type === "content_block_start") { if (open.has(event.index)) valid = false; open.add(event.index); }
    if (event.type === "content_block_delta") {
      if (!open.has(event.index)) valid = false;
      if (event.delta.type === "input_json_delta") args.set(event.index, (args.get(event.index) ?? "") + event.delta.partial_json);
    }
    if (event.type === "content_block_stop") { if (!open.delete(event.index)) valid = false; }
  }
  return { valid: valid && !open.size, args: [...args.values()] };
}

export async function runBridgeRegressions(check: Check): Promise<void> {
  const imageRequest: AnthropicRequest = { model: "fixture", max_tokens: 8192, output_config: { effort: "high" }, thinking: { type: "adaptive" }, messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "a", name: "screenshot", input: {} }, { type: "tool_use", id: "b", name: "read", input: {} }] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "Screenshot" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } }] },
      { type: "tool_result", tool_use_id: "b", content: "Read done" },
    ] },
  ] };
  const chat = anthropicToOpenAI(imageRequest);
  check("Claude Chat preserves tool image after all parallel results", chat.messages[1]?.role === "tool" && chat.messages[2]?.role === "tool" && chat.messages[3]?.role === "user" && JSON.stringify(chat.messages[3]).includes("data:image/png;base64,YQ==") && JSON.stringify(chat.messages[3]).includes("tool call a"));
  const responses = anthropicToResponses(imageRequest);
  const imageOutput = responses.input.find((item) => item.type === "function_call_output" && item.call_id === "a");
  check("Claude Responses preserves typed tool image output", JSON.stringify(imageOutput).includes('"type":"input_image"') && JSON.stringify(imageOutput).includes("YQ=="));
  check("Claude real output_config effort reaches both OpenAI protocols", chat.reasoning_effort === "high" && responses.reasoning?.effort === "high");

  for (const protocol of ["chat-completions", "anthropic"] as const) {
    const request = { reasoning: { effort: "xhigh" }, tools: [{ type: "function", name: "ping" }], input: [
      { type: "additional_tools", role: "developer", tools: [
        { type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec", format: { type: "text" } }] },
        { type: "namespace", name: "one", tools: [{ type: "function", name: "ping" }] },
        { type: "namespace", name: "two", tools: [{ type: "function", name: "ping" }] },
      ] },
      { role: "user", content: "hi" },
      { type: "custom_tool_call", namespace: "functions", name: "exec", call_id: "c", input: "text(1)" },
      { type: "custom_tool_call_output", call_id: "c", output: [{ type: "input_text", text: "ok" }, { type: "input_image", image_url: "data:image/png;base64,YQ==" }] },
    ], tool_choice: { type: "function", namespace: "one", name: "ping" } };
    const translated = translateCodexRequest(request, protocol, "m", 9000);
    const names = [...translated.toolNames.keys()];
    check(`Codex ${protocol} merges additional_tools without namespace collisions`, new Set(names).size === 4 && names.every((name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name)));
    check(`Codex ${protocol} preserves real reasoning effort`, protocol === "chat-completions" ? translated.body.reasoning_effort === "high" : object(translated.body.thinking).budget_tokens === 8192);
    const exec = names.find((name) => translated.toolNames.get(name)?.name === "exec")!;
    const chosen = names.find((name) => translated.toolNames.get(name)?.namespace === "one")!;
    check(`Codex ${protocol} maps namespace in history and tool_choice`, JSON.stringify(translated.body.messages).includes(exec) && JSON.stringify(translated.body.tool_choice).includes(chosen));
    const messages = translated.body.messages as WireObject[];
    check(`Codex ${protocol} preserves tool images in valid message roles`, JSON.stringify(messages).includes("YQ==") && (protocol === "anthropic" || (messages.at(-2)?.role === "tool" && typeof messages.at(-2)?.content === "string" && messages.at(-1)?.role === "user")));
    const events: WireObject[] = [];
    const stream = new CodexResponsesStream(protocol, "m", translated.customTools, (event) => events.push(structuredClone(event)), translated.toolNames);
    stream.start();
    if (protocol === "chat-completions") {
      stream.feed(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: exec, arguments: '{"input":"text(2)"}' } }, { index: 1, id: "p", function: { name: chosen, arguments: "{}" } }] }, finish_reason: "tool_calls" }] }));
      stream.feed("[DONE]");
    } else {
      for (const [index, id, name, args] of [[0, "c", exec, '{"input":"text(2)"}'], [1, "p", chosen, "{}"]] as const) {
        stream.feed(JSON.stringify({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }));
        stream.feed(JSON.stringify({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: args } }));
      }
      stream.feed(JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } }));
      stream.feed(JSON.stringify({ type: "message_stop" }));
    }
    stream.finish();
    const output = object(events.at(-1)!.response).output as WireObject[];
    check(`Codex ${protocol} restores custom and function namespaces on response`, output.some((item) => item.type === "custom_tool_call" && item.namespace === "functions" && item.name === "exec" && item.input === "text(2)") && output.some((item) => item.type === "function_call" && item.namespace === "one" && item.name === "ping"));
    const replay = translateCodexRequest({ ...request, input: [...request.input, ...output] }, protocol, "m", 9000);
    check(`Codex ${protocol} replays restored namespace calls`, JSON.stringify(replay.body.messages).includes('text(2)') && JSON.stringify(replay.body.messages).includes(exec));
  }

  for (const protocol of ["chat-completions", "responses"] as const) {
    const translator = protocol === "responses" ? new ResponsesToAnthropicSse() : new OpenAiToAnthropicSse();
    const events: AnthropicSseEvent[] = [];
    if (translator instanceof OpenAiToAnthropicSse) {
      events.push(...translator.feed({ choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "a", function: { name: "Read", arguments: '{"file_path":' } },
        { index: 1, id: "b", function: { name: "Read", arguments: '{"file_path":' } },
      ] } }] }));
      events.push(...translator.feed({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }, { index: 1, function: { arguments: '"b.txt"}' } }] }, finish_reason: "tool_calls" }] }));
    } else {
      for (const [index, id] of [[0, "a"], [1, "b"]] as const) events.push(...translator.feed({ output_index: index, item: { type: "function_call", id, call_id: id, name: "Read" } }, "response.output_item.added"));
      for (const id of ["a", "b"]) events.push(...translator.feed({ item_id: id, delta: '{"file_path":' }, "response.function_call_arguments.delta"));
      // Full done snapshots must repair missing tail deltas and remain deduplicated.
      for (const id of ["a", "b"]) events.push(...translator.feed({ item_id: id, arguments: `{"file_path":"${id}.txt"}` }, "response.function_call_arguments.done"));
      events.push(...translator.feed({ response: { status: "completed" } }, "response.completed"));
    }
    check(`Claude ${protocol} exposes no tools before full-stream validation`, !events.some((event) => event.type === "content_block_start" && event.content_block.type === "tool_use"));
    events.push(...translator.finish());
    const result = blocks(events);
    check(`Claude ${protocol} parallel tools have valid block order and complete JSON`, result.valid && result.args.length === 2 && result.args[0] === '{"file_path":"a.txt"}' && result.args[1] === '{"file_path":"b.txt"}');

    for (const fault of ["invalid JSON", "missing terminal", "token limit"]) {
      const broken = protocol === "responses" ? new ResponsesToAnthropicSse() : new OpenAiToAnthropicSse();
      const args = fault === "invalid JSON" ? '{"path":' : "{}";
      if (broken instanceof OpenAiToAnthropicSse) broken.feed({ choices: [{ delta: { tool_calls: [{ index: 0, id: "bad", function: { name: "Write", arguments: args } }] }, finish_reason: fault === "missing terminal" ? null : fault === "token limit" ? "length" : "tool_calls" }] });
      else {
        broken.feed({ item: { type: "function_call", call_id: "bad", name: "Write", arguments: args } }, "response.output_item.added");
        if (fault !== "missing terminal") broken.feed({ response: { status: fault === "token limit" ? "incomplete" : "completed" } }, fault === "token limit" ? "response.incomplete" : "response.completed");
      }
      const finish = broken.finish();
      check(`Claude ${protocol} never publishes tools on ${fault}`, finish.some((event) => event.type === "error") && !finish.some((event) => event.type === "message_stop" || event.type === "content_block_start" && event.content_block.type === "tool_use"));
    }

    const frames = protocol === "responses" ? [
      { type: "response.created", response: { status: "in_progress" } },
      { type: "response.output_text.delta", delta: "你好" },
      { type: "response.completed", response: { status: "completed" } },
    ] : [{ choices: [{ delta: { content: "你好" }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];
    const post = async (wire: string | ReadableStream<Uint8Array>) => {
      const bridge = await startBridge({ baseUrl: "https://example.invalid", authToken: "fixture", authMode: "api_key", protocol }, async () => new Response(wire, { headers: { "content-type": "text/event-stream" } }));
      try { return await (await fetch(`${bridge.localUrl}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "m", max_tokens: 8192, messages: [] }) })).text(); }
      finally { bridge.close(); }
    };
    for (const newline of ["\n", "\r\n"]) {
      const wire = frames.map((frame) => `data: ${JSON.stringify(frame)}${newline}${newline}`).join("");
      const result = await post(wire);
      check(`Claude ${protocol} HTTP stream handles ${newline === "\n" ? "LF" : "CRLF"}`, result.includes("你好") && result.includes("message_stop") && !result.includes('event: error'));
    }
    for (const [label, wire] of [
      ["clean premature EOF", frames.slice(0, -1).map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")],
      ["malformed JSON", "data: {invalid}\n\n"],
      ["upstream error", 'event: error\ndata: {"error":{"message":"fixture failure"}}\n\n'],
    ]) {
      const result = await post(wire!);
      check(`Claude ${protocol} reports ${label} without success`, result.includes("event: error") && !result.includes("message_stop"));
    }
    let reads = 0;
    const broken = new ReadableStream<Uint8Array>({ pull(controller) { if (reads++) controller.error(new Error("fixture disconnect")); else controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frames[0])}\n\n`)); } });
    const failed = await post(broken);
    check(`Claude ${protocol} reports reader failure without success`, failed.includes("event: error") && !failed.includes("message_stop"));
  }
  const decoded: string[] = [];
  const decoder = new SseDecoder((data) => decoded.push(data));
  for (const byte of new TextEncoder().encode('data: {"text":"你好"}\r\n\r\ndata: tail')) decoder.push(new Uint8Array([byte]));
  decoder.finish();
  check("SSE decoder handles split CRLF, UTF-8 and final frame without separator", decoded[0] === '{"text":"你好"}' && decoded[1] === "tail");
  let aborted = false;
  const bridge = await startBridge({ baseUrl: "https://example.invalid", authToken: "fixture", authMode: "api_key", protocol: "chat-completions", timeoutMs: 20 }, async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const abort = () => { aborted = true; reject(new Error("fixture timeout")); };
    if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
  }));
  try {
    const response = await fetch(`${bridge.localUrl}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "m", max_tokens: 100, messages: [] }) });
    check("Claude bridge timeout aborts upstream and returns failure", response.status === 502 && aborted);
    await response.text();
  } finally { bridge.close(); }
}
