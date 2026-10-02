/** Real shared-provider UI + encrypted store + local HTTP discovery fixture.
 * Keeps isolated artifacts under the caller-supplied directory for inspection. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { startSharedProviderFixture } from "./shared-provider-http-fixture.mjs";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(desktop, "package.json"));
const base = resolve(process.argv[2] ?? join(desktop, "../../../shared-provider-validation"));
await mkdir(base, { recursive: true });
const data = await mkdtemp(join(base, "run-"));
const localPiDir = join(data, ".pi", "agent");
await mkdir(localPiDir, { recursive: true });
const localModels = JSON.stringify({ providers: {}, preservationMarker: "unchanged" });
await writeFile(join(localPiDir, "models.json"), localModels);
const fixtureKey = "test-only-shared-key-not-a-real-credential";
const fixture = await startSharedProviderFixture();
const fixtureRequests = fixture.requests;
const fixtureHost = Object.values(networkInterfaces()).flat().find((address) => address?.family === "IPv4" && !address.internal)?.address ?? "127.0.0.1";
const fixtureBaseUrl = `http://${fixtureHost}:${fixture.port}/v1`;
const db = new DatabaseSync(join(data, "claude-gui.db"));
db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
db.prepare("INSERT INTO settings VALUES (?,?)").run("mobile.enabled", "0");
db.prepare("INSERT INTO settings VALUES (?,?)").run("network.proxy", JSON.stringify({ mode: "direct", customUrl: "" }));
db.prepare("INSERT INTO settings VALUES (?,?)").run("ui.titleGenEnabled", "0");
db.prepare("INSERT INTO settings VALUES (?,?)").run("mcp.management", JSON.stringify({ browserDisabled: true, webToolsDisabled: true, imageToolDisabled: true, scheduleToolsDisabled: true, wechatToolDisabled: true }));
db.close();
const child = spawn(require("electron"), [process.env.MARIOCODE_TEST_ASAR || desktop, `--user-data-dir=${data}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"], {
  cwd: desktop, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, HOME: data, USERPROFILE: data, PI_CODING_AGENT_DIR: localPiDir },
});
let stderr = "";
const log = createWriteStream(join(data, "electron.log"));
child.stdout.pipe(log, { end: false });
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); log.write(chunk); });
child.once("error", (error) => { stderr += error.message; });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let socket;
let id = 0;
const pending = new Map();
const command = (method, params = {}, timeout = 30000) => new Promise((resolvePromise, reject) => {
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
try {
  const until = Date.now() + 30000;
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
  while (!await evaluate("Boolean(window.api && document.querySelector('button .tabler-icon-settings'))")) {
    if (Date.now() > until) throw new Error("Renderer did not mount");
    await delay(150);
  }
  assert.equal(await evaluate("document.title"), "MarioCode");
  // Packaged builds intentionally do not bundle agent SDKs/binaries. Select
  // the checkout's real runtimes through the same verified external-runtime
  // API used by settings, only in this isolated test profile.
  const piSelection = await evaluate(`window.api.runtimes.select(${JSON.stringify({ agent: "pi", mode: "external", path: join(desktop, "node_modules", "@earendil-works", "pi-coding-agent"), nodePath: process.execPath })})`);
  assert.equal(piSelection.ok, true, piSelection.error);
  const suffix = `${process.platform}-${process.arch}`;
  const triples = { "win32-x64": "x86_64-pc-windows-msvc", "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl", "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin" };
  const codexVersion = require("@openai/codex/package.json").version;
  const codexPath = process.env.MARIOCODE_TEST_CODEX_BIN || join(desktop, "../../node_modules/.pnpm", `@openai+codex@${codexVersion}-${suffix}`, "node_modules/@openai/codex/vendor", triples[suffix], "bin", process.platform === "win32" ? "codex.exe" : "codex");
  const codexSelection = await evaluate(`window.api.runtimes.select(${JSON.stringify({ agent: "codex", mode: "external", path: codexPath })})`);
  assert.equal(codexSelection.ok, true, codexSelection.error);
  // Visible settings navigation, not a fabricated renderer state.
  await evaluate("document.querySelector('button .tabler-icon-settings')?.closest('button').click()");
  const openUntil = Date.now() + 20000;
  while (!await evaluate("Boolean(document.querySelector('.settings-root nav'))")) {
    if (Date.now() > openUntil) throw new Error("Settings did not open");
    await delay(100);
  }
  await evaluate("[...document.querySelectorAll('.settings-root nav button')].find(b=>b.innerText.trim()==='AI 能力')?.click()");
  const settingsDeadline = Date.now() + 20000;
  while (!await evaluate("[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='模型配置')")) {
    if (Date.now() > settingsDeadline) throw new Error(`Model settings tab missing: ${await evaluate("document.body.innerText")}`);
    await delay(200);
  }
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='模型配置')?.click()");
  let text;
  do {
    text = await evaluate("document.body.innerText");
    if (text.includes("公用模型提供商") && text.includes("新增提供商")) break;
    await delay(250);
  } while (Date.now() < settingsDeadline);
  await writeFile(join(data, "settings-dom.txt"), text);
  assert.ok(text.includes("公用模型提供商"), "Shared providers is the default model settings page");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='新增提供商').click()");
  await delay(250);
  async function fill(label, value) {
    await evaluate(`[...document.querySelectorAll('label')].find(l=>l.textContent.trim().startsWith(${JSON.stringify(label)})).querySelector('input').focus()`);
    await command("Input.insertText", { text: value });
  }
  async function check(label) {
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`);
    await delay(80);
  }
  await fill("提供商名称", "共享验证（仅测试配置）");
  await fill("API 基础地址", fixtureBaseUrl);
  await fill("公用 API Key", fixtureKey);
  await check("Anthropic Messages");
  await check("OpenAI Responses");
  await evaluate("document.querySelector('input[aria-label=\"模型 ID（与服务商一致）\"]').focus()");
  await command("Input.insertText", { text: "fixture-model" });
  // Provider flags must not grant interfaces to an existing model.
  assert.equal(await evaluate("[...document.querySelectorAll('li')].find(l=>l.querySelector('input[aria-label=\"模型 ID（与服务商一致）\"]'))?.textContent.includes('Pi：Chat')"), true);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Codex').disabled"), true, "Codex requires a Responses model, not just a provider flag");
  await evaluate("[...[...document.querySelectorAll('li')].find(l=>l.querySelector('input[aria-label=\"模型 ID（与服务商一致）\"]')).querySelectorAll('button')].find(b=>b.textContent.trim()==='Responses').click()");
  await check("Codex");
  await check("OpenAI Responses");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Codex').getAttribute('aria-pressed')"), "true", "Protocol edits must preserve engine choice");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='保存公用配置').disabled"), true);
  await check("OpenAI Responses");
  assert.equal(await evaluate("[...[...document.querySelectorAll('li')].find(l=>l.querySelector('input[aria-label=\"模型 ID（与服务商一致）\"]')).querySelectorAll('button')].find(b=>b.textContent.trim()==='Responses').getAttribute('aria-pressed')"), "false", "Re-enabling a provider protocol must not silently grant model capabilities");
  await evaluate("[...[...document.querySelectorAll('li')].find(l=>l.querySelector('input[aria-label=\"模型 ID（与服务商一致）\"]')).querySelectorAll('button')].find(b=>b.textContent.trim()==='Responses').click()");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='加载模型').click()");
  const draftDiscoveryUntil = Date.now() + 20000;
  while (!await evaluate("[...document.querySelectorAll('[role=dialog]')].some(d=>d.textContent.includes('http-discovered-model'))")) {
    if (Date.now() > draftDiscoveryUntil) throw new Error(`Draft HTTP discovery failed: ${await evaluate("document.body.innerText")}`);
    await delay(100);
  }
  assert.equal(fixtureRequests.length, 1);
  assert.equal(fixtureRequests[0].authorization, `Bearer ${fixtureKey}`);
  assert.equal(await evaluate("[...[...document.querySelectorAll('label')].find(l=>l.textContent.includes('http-discovered-model')).parentElement.querySelectorAll('button')].find(b=>b.textContent.trim()==='Messages')?.getAttribute('aria-pressed')"), "false", "Discovery must not invent Messages support");
  assert.equal(await evaluate("[...[...document.querySelectorAll('label')].find(l=>l.textContent.includes('http-discovered-model')).parentElement.querySelectorAll('button')].find(b=>b.textContent.trim()==='Responses')?.getAttribute('aria-pressed')"), "false", "Discovery must not invent Responses support");
  await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.innerText.trim()==='取消').click()");
  await delay(150);
  assert.ok(await evaluate("[...document.querySelectorAll('input')].some(i=>i.value==='fixture-model')"));
  assert.ok(!await evaluate("[...document.querySelectorAll('input')].some(i=>i.value==='http-discovered-model')"), "Cancel discovery preserves the form");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='保存公用配置').click()");
  const saveUntil = Date.now() + 20000;
  let saved;
  do {
    saved = await evaluate("window.api.sharedProviders.list()");
    if (saved.providers.length === 1) break;
    await delay(200);
  } while (Date.now() < saveUntil);
  assert.equal(saved.providers.length, 1, `UI save failed: ${await evaluate("document.body.innerText")}`);
  const provider = saved.providers[0];
  assert.equal(provider.hasApiKey, true);
  assert.ok(!JSON.stringify(saved).includes(fixtureKey));
  const runtimeId = `shared_${provider.id.replaceAll("-", "")}`;
  const [claude, codex, pi] = await evaluate("Promise.all([window.api.customModel.list(),window.api.codexModels.list(),window.api.piModels.list()])");
  assert.ok(claude.models.some((m) => m.id === runtimeId && m.protocol === "openai"));
  assert.ok(codex.providers.some((p) => p.id === runtimeId));
  assert.ok(pi.providers[runtimeId]?.models.some((m) => m.id === "fixture-model"));
  const available = await evaluate("window.api.piModels.listAvailable()");
  assert.ok(available.models.some((m) => m.id === `${runtimeId}/fixture-model`), "Pi SDK registration, including packaged host");
  assert.ok(!JSON.stringify([claude, codex, pi]).includes(fixtureKey));
  const peek = await evaluate(`Promise.all([window.api.customModel.getToken({id:${JSON.stringify(runtimeId)}}),window.api.codexModels.getApiKey({id:${JSON.stringify(runtimeId)}}),window.api.piModels.getApiKey({name:${JSON.stringify(runtimeId)}})])`);
  assert.ok(!JSON.stringify(peek).includes(fixtureKey), "Legacy reveal endpoints cannot reveal shared key");
  assert.equal(await readFile(join(localPiDir, "models.json"), "utf8"), localModels);
  const metadataDb = new DatabaseSync(join(data, "claude-gui.db"), { readOnly: true });
  const stored = JSON.stringify(metadataDb.prepare("SELECT key,value FROM settings WHERE key LIKE 'sharedProviders.%'").all());
  metadataDb.close();
  assert.ok(!stored.includes(fixtureKey), "Real safeStorage protects the key at rest");
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('共享验证（仅测试配置）')).click()`);
  await delay(250);
  assert.equal(await evaluate("document.querySelector('input[type=password]').value"), "", "Reopening never reveals saved key");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='加载模型').click()");
  const discoveryUntil = Date.now() + 20000;
  while (!await evaluate("[...document.querySelectorAll('[role=dialog]')].some(d=>d.textContent.includes('http-discovered-model'))")) {
    if (Date.now() > discoveryUntil) throw new Error(`HTTP discovery failed: ${await evaluate("document.body.innerText")}`);
    await delay(100);
  }
  assert.equal(fixtureRequests.length, 2);
  assert.equal(fixtureRequests[1].path, "/v1/models");
  assert.equal(fixtureRequests[1].authorization, `Bearer ${fixtureKey}`);
  assert.ok(!(await evaluate("document.body.innerText")).includes(fixtureKey));
  await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.innerText.trim()==='合并到表单').click()");
  await delay(150);
  assert.ok(await evaluate("[...document.querySelectorAll('input')].some(i=>i.value==='http-discovered-model')"), "Discovery selection merges into the form");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='保存公用配置').click()");
  while (!(await evaluate("window.api.sharedProviders.list()")).providers[0]?.models.some((model) => model.id === "http-discovered-model")) {
    if (Date.now() > discoveryUntil) throw new Error("Discovered HTTP model was not saved");
    await delay(100);
  }
  const afterDiscovery = (await evaluate("window.api.sharedProviders.list()")).providers[0];
  assert.deepEqual(afterDiscovery.models.find((m) => m.id === "http-discovered-model").interfaces, ["chat-completions"]);
  assert.deepEqual(afterDiscovery.models.find((m) => m.id === "fixture-model").interfaces, ["chat-completions", "responses"], "Existing model interfaces survive discovery");

  // Actual app -> provider -> local upstream -> streamed answer. No paid
  // model calls, user credentials, or external model catalogs are used.
  const models = [
    { id: "vendor/chat-model", interfaces: ["chat-completions"] },
    { id: "messages-model", interfaces: ["anthropic"] },
    { id: "responses-model", interfaces: ["responses"] },
    { id: "vendor/responses-alt", interfaces: ["responses"] },
  ];
  const wireBaseUrl = `http://${process.env.MARIOCODE_TEST_WIRE_HOST || "127.0.0.1"}:${fixture.port}/v1`;
  const overrides = { anthropic: wireBaseUrl.replace(/\/v1$/, "/messages/v1"), responses: wireBaseUrl.replace(/\/v1$/, "/responses/v1") };
  const wireConfig = { id: provider.id, name: provider.name, baseUrl: wireBaseUrl, apiKey: fixtureKey, protocols: provider.protocols, enabledAgents: ["claude", "pi", "codex"], models, endpointOverrides: overrides };
  await evaluate(`window.api.sharedProviders.save(${JSON.stringify(wireConfig)})`);
  const cwd = join(data, "wire-project");
  await mkdir(cwd);
  const { project } = await evaluate(`window.api.project.create(${JSON.stringify({ name: "Offline wire test", path: cwd })})`);
  const turns = [
    { engine: "pi-sdk", id: "vendor/chat-model", path: "/v1/chat/completions" },
    { engine: "pi-sdk", id: "messages-model", path: "/messages/v1/messages" },
    { engine: "pi-sdk", id: "responses-model", path: "/responses/v1/responses" },
    { engine: "codex-sdk", id: "responses-model", path: "/responses/v1/responses" },
  ];
  let codexSession;
  for (const turn of [...turns, { engine: "codex-sdk", id: "vendor/responses-alt", path: "/responses/v1/responses", resume: true }]) {
    const { session } = turn.resume ? { session: codexSession } : await evaluate(`window.api.claude.startSession(${JSON.stringify({ projectId: project.id, title: "Offline wire check", kind: "side", providerId: turn.engine, model: `${runtimeId}/${turn.id}`, permissionMode: "bypassPermissions" })})`);
    if (turn.engine === "codex-sdk") codexSession = session;
    await evaluate("globalThis.__wireEvents = []; globalThis.__stopWireEvents = window.api.on.claudeEvent(msg => globalThis.__wireEvents.push(msg.event))");
    try {
      const requestCount = fixtureRequests.length;
      await evaluate(`window.api.claude.sendTurn(${JSON.stringify({ sessionId: session.id, prompt: "Reply briefly", model: `${runtimeId}/${turn.id}` })})`);
      const deadline = Date.now() + 45000;
      let events;
      do {
        events = await evaluate("globalThis.__wireEvents");
        if (events.some((e) => e.type === "turn.done" && e.sessionId === session.id)) break;
        if (Date.now() > deadline) throw new Error(`${turn.engine} turn timed out: ${JSON.stringify(events)}`);
        await delay(150);
      } while (true);
      assert.ok(!events.some((e) => e.type === "error"), `${turn.engine} errors: ${JSON.stringify(events)}`);
      assert.ok(events.filter((e) => e.type === "text.delta").map((e) => e.text).join("").includes(`fixture-ok:${turn.id}`), `${turn.engine} streaming answer missing: ${JSON.stringify(events)}`);
      assert.ok(fixtureRequests.slice(requestCount).some((r) => r.path === turn.path && r.body.model === turn.id && (r.authorization === `Bearer ${fixtureKey}` || r.apiKey === fixtureKey)), `${turn.engine} request did not use its model endpoint and stored key`);
    } finally { await evaluate("globalThis.__stopWireEvents()"); }
  }
  try {
    await command("Page.bringToFront");
    const screenshot = await command("Page.captureScreenshot", { format: "png", fromSurface: false }, 5000);
    await writeFile(join(data, "shared-providers.png"), Buffer.from(screenshot.data, "base64"));
  } catch { console.log("Screenshot unavailable; live DOM/IPC assertions completed."); }
  await writeFile(join(data, "verification.json"), JSON.stringify({
    result: "passed", providerId: provider.id,
    fixtureBaseUrl,
    checks: ["real shared provider form save", "three agent projections", "Pi SDK in-memory registration", "encrypted key at rest", "no key disclosure via legacy IPC", "local Pi models unchanged", "reopened form does not reveal key", "real HTTP model discovery with draft key", "cancel discovery preserves form", "real HTTP model discovery with stored key", "discovered model selection and save", "discovery does not invent interfaces", "interface edits preserve engine choices", "Pi real Chat/Messages/Responses turns", "Codex real Responses turn and model switch on resume"],
  }, null, 2));
  console.log(`Electron shared-provider verification passed. Artifacts: ${data}`);
} finally {
  await writeFile(join(data, "wire-requests.json"), JSON.stringify(fixtureRequests.map((r) => ({ path: r.path, model: r.body.model, stream: r.body.stream })), null, 2));
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Test ended")); }
  pending.clear();
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ id: ++id, method: "Browser.close" }));
    socket.close();
  }
  if (child.exitCode === null) {
    await Promise.race([new Promise((r) => child.once("exit", r)), delay(5000)]);
    if (child.exitCode === null) child.kill();
  }
  log.end();
  await fixture.close();
}
