/** Real Electron + real local runtimes; no model requests or user credentials.
 * Keeps isolated artifacts under the caller-supplied directory for inspection. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(desktop, "package.json"));
const base = resolve(process.argv[2] ?? join(desktop, "../../../runtime-electron-validation"));
await mkdir(base, { recursive: true });
const data = await mkdtemp(join(base, "run-"));
const db = new DatabaseSync(join(data, "claude-gui.db"));
db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
db.prepare("INSERT INTO settings VALUES (?,?)").run("mobile.enabled", "0");
db.close();
const child = spawn(require("electron"), [desktop, `--user-data-dir=${data}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"], {
  cwd: desktop, windowsHide: false, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, HOME: data, USERPROFILE: data, PI_CODING_AGENT_DIR: join(data, "pi") },
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
  while (!await evaluate("Boolean(window.api && document.body.innerText.includes('MarioCode'))")) {
    if (Date.now() > until) throw new Error("Renderer did not mount");
    await delay(150);
  }
  assert.equal(await evaluate("document.title"), "MarioCode");
  // Visible settings navigation, not a fabricated renderer state.
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='设置')?.click()");
  const settingsDeadline = Date.now() + 20000;
  while (!await evaluate("[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Agent')")) {
    if (Date.now() > settingsDeadline) throw new Error(`Agent settings tab missing: ${await evaluate("document.body.innerText")}`);
    await delay(200);
  }
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Agent')?.click()");
  let text;
  do {
    text = await evaluate("document.body.innerText");
    if (text.includes("MarioCode 管理") && text.includes("使用本机安装")) break;
    await delay(250);
  } while (Date.now() < settingsDeadline);
  await writeFile(join(data, "settings-dom.txt"), text);
  assert.ok(text.includes("MarioCode 管理") && text.includes("使用本机安装"), "Runtime source controls are visible");
  const discoveries = {};
  for (const agent of ["claude", "codex", "pi"]) {
    discoveries[agent] = await evaluate(`window.api.runtimes.discover(${JSON.stringify({ agent })})`);
    assert.ok(discoveries[agent].candidates.some((c) => c.available), `${agent}: a real local installation is detected`);
  }
  const pi = discoveries.pi.candidates.find((c) => c.available);
  await evaluate("[...document.querySelectorAll('button')].filter(b=>b.innerText.trim()==='使用本机安装').at(-1).click()");
  await delay(250);
  await evaluate("document.querySelector('input').focus()");
  await command("Input.insertText", { text: pi.path });
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='验证并使用').click()");
  const bindingDeadline = Date.now() + 20000;
  while (!await evaluate("document.body.innerText.includes('基础检查通过')")) {
    if (Date.now() > bindingDeadline) throw new Error(`UI binding failed: ${await evaluate("document.body.innerText")}`);
    await delay(250);
  }
  let state = (await evaluate("window.api.runtimes.list()")).runtimes.find((r) => r.agent === "pi");
  assert.equal(state.selectedMode, "external");
  assert.equal(state.source, "external");
  assert.equal(state.available, true, state.diagnostic);
  assert.equal(state.updateAvailable, false);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].filter(b=>b.innerText.trim()==='安装').length"), 2, "External Pi no longer offers managed install actions");
  const activePath = state.activePath;
  const failed = await evaluate(`window.api.runtimes.select(${JSON.stringify({ agent: "pi", mode: "external", path: join(data, "missing-pi") })})`);
  assert.equal(failed.ok, false);
  state = (await evaluate("window.api.runtimes.list()")).runtimes.find((r) => r.agent === "pi");
  assert.equal(state.activePath, activePath, "Failed binding preserves the working selection");
  // Concurrent real model-list calls exercise the Electron-side single-flight.
  const lists = await evaluate("Promise.all(Array.from({length:5},()=>window.api.piModels.listAvailable()))");
  assert.ok(lists.every((r) => Array.isArray(r.models)));
  assert.ok(!stderr.includes("No such built-in module: node:sqlite"));
  assert.ok(!stderr.includes("piModels.listAvailable failed"), "Pi host loads successfully through the real app");
  await assert.rejects(access(join(data, "runtimes", "pi")), "External selection must not copy a Pi installation");
  try {
    await command("Page.bringToFront");
    const screenshot = await command("Page.captureScreenshot", { format: "png", fromSurface: false }, 5000);
    await writeFile(join(data, "runtime-settings.png"), Buffer.from(screenshot.data, "base64"));
  } catch { console.log("Screenshot unavailable; live DOM/IPC assertions completed."); }
  await writeFile(join(data, "verification.json"), JSON.stringify({
    result: "passed", runtime: { source: state.source, version: state.activeVersion, path: activePath },
    checks: ["real Electron UI", "three local CLI discoveries", "zero-copy Pi selection", "failed selection preserved", "concurrent Pi host model discovery", "no sqlite compatibility error"],
  }, null, 2));
  console.log(`Electron runtime verification passed. Artifacts: ${data}`);
} finally {
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
}
