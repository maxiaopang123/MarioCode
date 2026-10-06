/** Offline regression through the installed Claude SDK and Codex app-server binaries. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(desktop, "package.json"));
const { build } = createRequire(require.resolve("vite/package.json"))("esbuild");
const temporary = await mkdtemp(join(tmpdir(), "mariocode-protocol-native-"));
const prefix = join(desktop, "scripts/shared-provider-smoke");
let checks = 0;
const check = (name, condition) => { assert.ok(condition, name); checks++; console.log(`  ✓ ${name}`); };
const fakeKey = "offline-fixture-key";
const directEnv = { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "*", NODE_USE_ENV_PROXY: "0" };
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";

async function upstream(reply) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const buffers = [];
      for await (const buffer of req) buffers.push(buffer);
      const body = JSON.parse(Buffer.concat(buffers).toString("utf8") || "{}");
      const path = (req.url ?? "").split("?")[0];
      if (!["/v1/messages", "/v1/chat/completions", "/v1/responses"].includes(path)) { res.writeHead(404); res.end(); return; }
      requests.push(body);
      const events = reply(body, requests.length);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // CRLF exercises transport framing with the real consumer.
      for (const event of events) res.write(`event: ${event.type ?? "message"}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`);
      res.end(path.endsWith("/chat/completions") ? "data: [DONE]\r\n\r\n" : "");
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); } };
}
function final(protocol) {
  if (protocol === "chat-completions") return [{ choices: [{ index: 0, delta: { content: "native-fixture-complete" }, finish_reason: "stop" }] }];
  if (protocol === "responses") return [
    { type: "response.created", response: { model: "fixture", status: "in_progress" } },
    { type: "response.output_text.delta", output_index: 0, delta: "native-fixture-complete" },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
  return [
    { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "native-fixture-complete" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}
function calls(protocol, tools) {
  if (protocol === "chat-completions") return [
    { choices: [{ index: 0, delta: { tool_calls: tools.map((tool, index) => ({ index, id: tool.id, function: { name: tool.name, arguments: tool.args.slice(0, 5) } })) } }] },
    { choices: [{ index: 0, delta: { tool_calls: tools.map((tool, index) => ({ index, function: { arguments: tool.args.slice(5) } })) }, finish_reason: "tool_calls" }] },
  ];
  if (protocol === "responses") return [
    { type: "response.created", response: { status: "in_progress" } },
    ...tools.map((tool, output_index) => ({ type: "response.output_item.added", output_index, item: { type: "function_call", id: tool.id, call_id: tool.id, name: tool.name } })),
    ...tools.map((tool, output_index) => ({ type: "response.function_call_arguments.delta", output_index, delta: tool.args.slice(0, 5) })),
    ...tools.map((tool, output_index) => ({ type: "response.function_call_arguments.delta", output_index, delta: tool.args.slice(5) })),
    { type: "response.completed", response: { status: "completed" } },
  ];
  return [
    { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    ...tools.flatMap((tool, index) => [
      { type: "content_block_start", index, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: tool.args } },
      { type: "content_block_stop", index },
    ]),
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

try {
  await build({ entryPoints: [join(prefix, "native-exports.ts")], outfile: join(temporary, "modules.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(desktop, "tsconfig.json"), alias: {
    electron: join(prefix, "stub-electron.ts"), "@main/store/db.js": join(prefix, "stub-db.ts"),
    "@main/store/repositories.js": join(prefix, "stub-db.ts"), "@main/lib/logger.js": join(prefix, "stub-logger.ts"),
    "@main": join(desktop, "src/main"), "@contracts": resolve(desktop, "../../packages/contracts/src"),
  } });
  const { CodexAppServerClient, CODEX_BRIDGE_CONFIG_ARGS, startCodexResponsesBridge, createCodexContextCatalog, startBridge } = await import(pathToFileURL(join(temporary, "modules.mjs")).href);
  const suffix = `${process.platform}-${process.arch}`;
  const triples = { "win32-x64": "x86_64-pc-windows-msvc", "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl", "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin" };
  const nativeRequire = createRequire(require.resolve("@openai/codex/package.json"));
  const codexPath = process.env.MARIOCODE_TEST_CODEX_BIN || join(dirname(nativeRequire.resolve(`@openai/codex-${suffix}/package.json`)), "vendor", triples[suffix], "bin", process.platform === "win32" ? "codex.exe" : "codex");

  for (const protocol of ["chat-completions", "anthropic"]) {
    for (const model of ["fixture-unknown", "gpt-6-astra"]) {
      const home = join(temporary, `codex-${protocol}-${model}`);
      const cwd = join(home, "project");
      await mkdir(cwd, { recursive: true });
      const fixture = await upstream((body, number) => {
        if (number > 1) return final(protocol);
        const tools = (body.tools ?? []).map((tool) => tool.function ?? tool);
        const exec = tools.find((tool) => tool.description?.startsWith("Original tool: functions.exec\n"));
        const ping = tools.find((tool) => tool.name === "fixture_ping");
        assert.ok(exec || ping, "Native dynamic tool must be present");
        return calls(protocol, ["a", "b"].map((value) => ({ id: `call_${value}`, name: (exec ?? ping).name, args: JSON.stringify(exec ? { input: `text(await tools.fixture_ping({value: "${value}"}))` } : { value }) })));
      });
      const bridge = await startCodexResponsesBridge({ protocol, baseUrl: fixture.baseUrl, apiKey: fakeKey, model, sessionId: "native-test" }, fetch);
      const catalog = await createCodexContextCatalog(model, 1_000_000, 800_000);
      await writeFile(join(home, "config.toml"), `[model_providers.fixture]\nname = "Fixture"\nbase_url = "${bridge.localUrl}"\nenv_key = "MARIOCODE_FIXTURE_KEY"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
      const hostCalls = [];
      const client = new CodexAppServerClient({ codexPath, cwd, env: { ...directEnv, CODEX_HOME: home, MARIOCODE_FIXTURE_KEY: bridge.routeToken }, extraArgs: [...CODEX_BRIDGE_CONFIG_ARGS, "-c", `model=${model}`, "-c", 'model_provider="fixture"', "-c", `model_catalog_json=${JSON.stringify(catalog.path)}`], log: { info() {}, warn() {}, error() {} } });
      let complete;
      const completed = new Promise((r) => { complete = r; });
      client.onNotification((frame) => { if (frame.method === "turn/completed") complete(frame.params); });
      client.handleRequest((frame) => {
        assert.equal(frame.method, "item/tool/call", "Only the offline dynamic tool should execute");
        assert.equal(frame.params.tool, "fixture_ping");
        hostCalls.push(frame.params.arguments.value);
        return { success: true, contentItems: [{ type: "inputText", text: `fixture-result:${frame.params.arguments.value}` }] };
      });
      let timer;
      try {
        await client.start();
        const thread = await client.request("thread/start", { cwd, model, modelProvider: "fixture", sandbox: "read-only", approvalPolicy: "never", dynamicTools: [{ name: "fixture_ping", description: "Offline fixture", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] });
        await client.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "Offline fixture." }], model, effort: "high", approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } });
        const result = await Promise.race([completed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Native Codex timeout")), 20000); })]);
        check(`Native Codex ${protocol}/${model} completes tool round trip`, result.turn.status === "completed" && hostCalls.sort().join(",") === "a,b");
        check(`Native Codex ${protocol}/${model} replays results and effort`, fixture.requests.length === 2 && JSON.stringify(fixture.requests[1]).includes("fixture-result:a") && JSON.stringify(fixture.requests[1]).includes("fixture-result:b") && (protocol === "anthropic" ? fixture.requests[0].thinking?.budget_tokens === 8191 : fixture.requests[0].reasoning_effort === "high"));
      } finally { clearTimeout(timer); await client.dispose(); bridge.close(); await catalog.dispose(); await fixture.close(); }
    }
  }

  const sdk = await import(pathToFileURL(require.resolve("@anthropic-ai/claude-agent-sdk")).href);
  const { z } = require("zod");
  for (const protocol of ["chat-completions", "responses"]) {
    const home = join(temporary, `claude-${protocol}`);
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "a.txt"), "fixture-file-a");
    await writeFile(join(home, "b.txt"), "fixture-file-b");
    const fixture = await upstream((body, number) => number > 1 ? final(protocol) : calls(protocol, [
      { id: "toolu_a", name: "Read", args: JSON.stringify({ file_path: join(home, "a.txt") }) },
      { id: "toolu_b", name: "Read", args: JSON.stringify({ file_path: join(home, "b.txt") }) },
      { id: "toolu_image", name: "mcp__fixture__image", args: "{}" },
    ]));
    const bridge = await startBridge({ protocol, baseUrl: fixture.baseUrl, authToken: fakeKey, authMode: "api_key" }, fetch);
    let imageCalls = 0;
    const mcp = sdk.createSdkMcpServer({ name: "fixture", tools: [sdk.tool("image", "Offline image fixture", { dummy: z.string().optional() }, async () => {
      imageCalls++;
      return { content: [{ type: "text", text: "fixture-image" }, { type: "image", mimeType: "image/png", data: image }] };
    })] });
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 25000);
    const assistantCalls = [];
    let result;
    try {
      for await (const message of sdk.query({ prompt: "Offline fixture.", options: {
        cwd: home, model: "claude-fable-5", effort: "high", tools: ["Read"], maxTurns: 2, abortController,
        systemPrompt: "Offline fixture.", settingSources: [], persistSession: false, mcpServers: { fixture: mcp },
        canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
        env: { ...directEnv, CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: fakeKey, ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: bridge.localUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      } })) {
        if (message.type === "assistant") assistantCalls.push(...message.message.content.filter((block) => block.type === "tool_use"));
        if (message.type === "result") result = message;
      }
      check(`Native Claude ${protocol} receives valid parallel tool JSON`, result?.subtype === "success" && assistantCalls.filter((call) => call.name === "Read").map((call) => call.input.file_path).sort().join(",") === [join(home, "a.txt"), join(home, "b.txt")].sort().join(","));
      check(`Native Claude ${protocol} replays image, file results and real effort`, fixture.requests.length === 2 && imageCalls === 1 && JSON.stringify(fixture.requests[1]).includes(image) && JSON.stringify(fixture.requests[1]).includes("fixture-file-a") && JSON.stringify(fixture.requests[1]).includes("fixture-file-b") && (protocol === "responses" ? fixture.requests[0].reasoning?.effort === "high" : fixture.requests[0].reasoning_effort === "high"));
    } finally { clearTimeout(timer); abortController.abort(); bridge.close(); await fixture.close(); }
  }
  console.log(`native protocol bridges passed (${checks} checks)`);
} finally {
  if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup target");
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
