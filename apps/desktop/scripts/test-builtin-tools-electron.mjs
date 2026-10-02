/** The built app, isolated profile (userData + HOME in a temp dir): Settings →
 *  内置工具 renders and saves through the real IPC, the MCP page lists the two
 *  new built-in servers, the prompt preview shows the built-in tools section,
 *  and one real Bing search runs. Needs `pnpm build` first and network access.
 *  Screenshots and the Electron log stay in the printed directory. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(desktop, "package.json"));
const data = await mkdtemp(join(process.argv[2] ? resolve(process.argv[2]) : tmpdir(), "mariocode-builtin-tools-"));
await mkdir(data, { recursive: true });
const db = new DatabaseSync(join(data, "claude-gui.db"));
db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
db.prepare("INSERT INTO settings VALUES (?,?)").run("mobile.enabled", "0");
db.close();
const child = spawn(require("electron"), [desktop, `--user-data-dir=${data}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"], {
  cwd: desktop, windowsHide: false, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, HOME: data, USERPROFILE: data },
});
let stderr = "";
const log = createWriteStream(join(data, "electron.log"));
child.stdout.pipe(log, { end: false });
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); log.write(chunk); });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let socket;
let id = 0;
const pending = new Map();
const command = (method, params = {}, timeout = 60000) => new Promise((resolvePromise, reject) => {
  const requestId = ++id;
  const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, timeout);
  pending.set(requestId, { resolve: resolvePromise, reject, timer });
  socket.send(JSON.stringify({ id: requestId, method, params }));
});
const evaluate = async (expression) => {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Renderer evaluation failed");
  return result.result.value;
};
const waitForText = async (needle, ms = 20000) => {
  const until = Date.now() + ms;
  while (!(await evaluate(`document.body.innerText.includes(${JSON.stringify(needle)})`))) {
    if (Date.now() > until) throw new Error(`Text never appeared: ${needle}`);
    await delay(200);
  }
};
const clickButton = (label) => evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(label)})?.click()`);
const screenshot = async (name) => {
  const { data: png } = await command("Page.captureScreenshot", { format: "png" });
  const file = join(data, `${name}.png`);
  await writeFile(file, Buffer.from(png, "base64"));
  console.log(`screenshot: ${file}`);
};
const ok = (label) => console.log(`PASS ${label}`);

try {
  const until = Date.now() + 40000;
  let port;
  while (!(port = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1])) {
    if (Date.now() > until || child.exitCode !== null) throw new Error(`Electron failed to start: ${stderr.slice(-1500)}`);
    await delay(100);
  }
  let page;
  while (!page) {
    page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === "page" && p.url.startsWith("file:"));
    if (Date.now() > until) throw new Error("Electron page missing");
    if (!page) await delay(100);
  }
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.addEventListener("open", r, { once: true }); socket.addEventListener("error", j, { once: true }); });
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id); clearTimeout(waiter.timer);
    msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
  });
  while (!(await evaluate("Boolean(window.api && document.body.innerText.includes('MarioCode'))"))) {
    if (Date.now() > until) throw new Error("Renderer did not mount");
    await delay(150);
  }

  // IPC: defaults, a real search, the MCP rows, the preview section.
  const initial = await evaluate("window.api.builtinTools.get()");
  assert.equal(initial.webToolsEnabled, true);
  assert.equal(initial.browserToolsEnabled, true);
  assert.equal(initial.config.search.backend, "bing");
  assert.equal(initial.imageIssue, "noSource");
  assert.deepEqual(initial.keys, { bocha: false, zhipu: false, tavily: false, exa: false, brave: false });
  ok("builtinTools.get defaults (web on, Bing, no search keys, image not configured)");

  const search = await evaluate("window.api.builtinTools.testSearch({ query: 'Electron BrowserWindow' })");
  assert.ok(search.ok && search.backend === "bing" && search.count >= 3, JSON.stringify(search));
  ok(`builtinTools.testSearch via Bing: ${search.count} results in ${search.ms}ms, first "${search.first?.title}"`);

  // The image source is a shared provider (its endpoint + key are reused);
  // the image tool stores no key of its own.
  const shared = await evaluate(`window.api.sharedProviders.save({
    name: "Smoke image provider",
    baseUrl: "https://example.invalid/v1",
    protocols: ["chat-completions"],
    models: [{ id: "gpt-image-1", imageGeneration: true }],
    enabledAgents: ["pi"],
    apiKey: "sk-smoke-not-a-real-key",
  })`);
  const smokeProvider = shared.providers.find((p) => p.name === "Smoke image provider");
  const providerId = smokeProvider?.id;
  // The 生图 marker is what the MarioTool page's image-model picker lists.
  assert.equal(smokeProvider?.models[0]?.imageGeneration, true, JSON.stringify(smokeProvider?.models));
  assert.ok(providerId, JSON.stringify(shared));
  const saved = await evaluate(`window.api.builtinTools.save({
    config: { ...${JSON.stringify(initial.config)}, image: { source: ${JSON.stringify(providerId)}, model: "gpt-image-1", size: "1024x1024" } },
  })`);
  assert.ok(saved.ok && saved.state.imageIssue === null && !("image" in saved.state.keys), JSON.stringify(saved));
  ok("builtinTools.save points the image tool at a shared provider (mario_image_generate ready)");

  // Optional search-API keys: presence only, never the value.
  const withKey = await evaluate(`window.api.builtinTools.save({ keys: { exa: "exa-smoke-not-a-real-key" } })`);
  assert.ok(withKey.ok && withKey.state.keys.exa === true && !JSON.stringify(withKey).includes("exa-smoke"), JSON.stringify(withKey));
  const cleared = await evaluate(`window.api.builtinTools.save({ keys: { exa: null } })`);
  assert.ok(cleared.ok && cleared.state.keys.exa === false, JSON.stringify(cleared));
  ok("builtinTools.save stores / clears a search key; the state reports presence only");

  const mcp = await evaluate("window.api.mcp.list({})");
  const builtins = mcp.servers.filter((s) => s.scope === "builtin").map((s) => `${s.name}:${s.enabled}`);
  assert.deepEqual(builtins, ["mariocode-browser:true", "mariocode-image:true", "mariocode-web:true"]);
  ok(`MCP built-in rows: ${builtins.join(", ")}`);

  await evaluate("window.api.mcp.toggle({ name: 'mariocode-web', scope: 'builtin', enabled: false })");
  assert.equal((await evaluate("window.api.builtinTools.get()")).webToolsEnabled, false);
  await evaluate("window.api.mcp.toggle({ name: 'mariocode-web', scope: 'builtin', enabled: true })");
  ok("MCP panel switch and the built-in tools page share one flag");

  // Browser tools: the MarioTool switch flips the MCP row mariocode-browser (and back).
  const browserRow = async () =>
    (await evaluate("window.api.mcp.list({})")).servers.find((s) => s.scope === "builtin" && s.name === "mariocode-browser");
  const browserOff = await evaluate("window.api.builtinTools.save({ browserToolsEnabled: false })");
  assert.ok(browserOff.ok && browserOff.state.browserToolsEnabled === false, JSON.stringify(browserOff));
  assert.equal((await browserRow())?.enabled, false);
  const browserOn = await evaluate("window.api.builtinTools.save({ browserToolsEnabled: true })");
  assert.ok(browserOn.ok && browserOn.state.browserToolsEnabled === true, JSON.stringify(browserOn));
  assert.equal((await browserRow())?.enabled, true);
  ok("MarioTool browser-tools switch and the MCP row mariocode-browser share one flag");

  const preview = await evaluate("window.api.systemPrompt.preview({ providerId: 'pi-sdk', projectPath: null })");
  const layer = preview.sections.find((s) => s.id === "builtin.usage.on");
  assert.ok(layer?.text?.includes("mario_web_search") && layer.text.includes("mario_image_generate"), JSON.stringify(preview.sections.map((s) => s.id)));
  ok("Pi prompt preview carries the built-in tools section");

  // UI: the page itself, via the visible settings navigation.
  await evaluate("document.querySelector('button .tabler-icon-settings')?.closest('button').click()");
  await waitForText("AI 能力");
  await clickButton("AI 能力");
  await waitForText("MarioTool");
  await clickButton("MarioTool");
  await waitForText("联网搜索与网页读取");
  await waitForText("已就绪");
  await clickButton("测试");
  await waitForText("必应返回", 30000);
  ok("Settings → MarioTool renders, shows image ready, the test button searches");
  await screenshot("builtin-tools-page");
  await clickButton("MCP");
  await waitForText("mariocode-web");
  await evaluate("[...document.querySelectorAll('*')].find(e=>e.textContent?.trim()==='mariocode-web')?.scrollIntoView({block:'center'})");
  await delay(400);
  await screenshot("mcp-builtin-rows");
  console.log(`\nall checks passed — artifacts in ${data}`);
} finally {
  socket?.close();
  child.kill();
}
