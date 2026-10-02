import { createServer } from "node:http";

/** Offline upstream for exercising the real SDK / binary wire protocols. */
export async function startSharedProviderFixture() {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url, authorization: req.headers.authorization, apiKey: req.headers["x-api-key"], body });
    if (req.url.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "http-discovered-model", name: "HTTP Discovered Model" }] }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const send = (value, event) => res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(value)}\n\n`);
    const text = `fixture-ok:${body.model}`;
    if (req.url.endsWith("/chat/completions")) {
      const chunk = { id: "chat-fixture", object: "chat.completion.chunk", created: 1, model: body.model };
      send({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
      send({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      res.end("data: [DONE]\n\n");
    } else if (req.url.endsWith("/messages")) {
      const events = [
        { type: "message_start", message: { id: "msg-fixture", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];
      for (const event of events) send(event, event.type);
      res.end();
    } else if (req.url.endsWith("/responses")) {
      const item = { id: "msg-fixture", type: "message", role: "assistant", status: "in_progress", content: [] };
      const response = { id: "resp-fixture", object: "response", created_at: 1, model: body.model, status: "in_progress", output: [] };
      const part = { type: "output_text", text: "", annotations: [] };
      const doneItem = { ...item, status: "completed", content: [{ ...part, text }] };
      const events = [
        { type: "response.created", response },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.content_part.added", output_index: 0, item_id: item.id, content_index: 0, part },
        { type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: text },
        { type: "response.output_text.done", output_index: 0, item_id: item.id, content_index: 0, text },
        { type: "response.content_part.done", output_index: 0, item_id: item.id, content_index: 0, part: { ...part, text } },
        { type: "response.output_item.done", output_index: 0, item: doneItem },
        { type: "response.completed", response: { ...response, status: "completed", output: [doneItem], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
      ];
      for (const [sequence_number, event] of events.entries()) send({ ...event, sequence_number }, event.type);
      res.end();
    } else res.end();
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "0.0.0.0", resolve); });
  return { server, requests, port: server.address().port, close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
