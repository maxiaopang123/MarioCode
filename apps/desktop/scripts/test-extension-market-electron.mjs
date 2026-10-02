/** Real IPC + UI regression in an isolated profile. Never starts an MCP
 * server, contacts an account, or installs anything into the real HOME. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(desktop, "package.json"));
const data = await mkdtemp(join(tmpdir(), "mariocode-extension-market-"));
const home = join(data, "home");
const marketDir = join(home, "local-market");
const importedDir = join(home, "imported-skill");
const allowedDir = join(home, "allowed files");
for (const dir of [home, join(marketDir, "market-skill"), importedDir, allowedDir]) await mkdir(dir, { recursive: true });
await writeFile(join(marketDir, "market-skill", "SKILL.md"), "---\nname: market-skill\ndescription: Market fixture\n---\n\nMarket body\n");
await writeFile(join(importedDir, "SKILL.md"), "---\nname: imported-skill\ndescription: Import fixture\n---\n\nImport body\n");
const db = new DatabaseSync(join(data, "claude-gui.db"));
db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
db.prepare("INSERT INTO settings VALUES (?,?)").run("mobile.enabled", "0");
db.close();
// Load the built archive with the same Electron version while retaining an
// isolated profile. The installed executable pins userData to the real profile.
const packagedArchive = process.env.MARIOCODE_TEST_ASAR;
const child = spawn(require("electron"), [packagedArchive || desktop, `--user-data-dir=${data}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"], {
  cwd: desktop, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, HOME: home, USERPROFILE: home },
});
let stderr = "";
const log = createWriteStream(join(data, "electron.log"));
child.stdout.pipe(log, { end: false });
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); log.write(chunk); });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let socket, id = 0, checks = 0;
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
const rpc = (method, input = {}) => evaluate(`window.api.${method}(${JSON.stringify(input)})`);
const waitFor = async (expression) => {
  const until = Date.now() + 20000;
  while (!await evaluate(expression)) { if (Date.now() > until) throw new Error(`Condition not met: ${expression}`); await delay(100); }
};
const click = async (label) => {
  await waitFor(`[...document.querySelectorAll('button')].some(b=>b.innerText.trim()===${JSON.stringify(label)})`);
  assert.equal(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(label)});b.click();return true})()`), true);
};
const fill = async (selector, value) => {
  await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Input missing');e.focus();e.select();})()`);
  await command("Input.insertText", { text: value });
};
const screenshot = async (name) => {
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))");
  // Electron's surface resize can reach the compositor after the DOM frame.
  await delay(300);
  const { data: png } = await command("Page.captureScreenshot", { format: "png" });
  await writeFile(join(data, `${name}.png`), Buffer.from(png, "base64"));
};
const pass = (label) => { checks++; console.log(`PASS ${label}`); };

try {
  const deadline = Date.now() + 45000;
  let port;
  while (!(port = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1])) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Electron startup failed: ${stderr.slice(-1500)}`);
    await delay(100);
  }
  let page;
  while (!page) {
    page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === "page" && p.url.startsWith("file:"));
    if (Date.now() > deadline) throw new Error("Renderer missing");
    if (!page) await delay(100);
  }
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.addEventListener("open", r, { once: true }); socket.addEventListener("error", j, { once: true }); });
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data); const waiter = pending.get(msg.id); if (!waiter) return;
    pending.delete(msg.id); clearTimeout(waiter.timer);
    msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result);
  });
  await waitFor("Boolean(window.api && document.querySelector('button .tabler-icon-settings'))");
  assert.equal((await rpc("mcp.marketInstall", { id: "github", name: "github" })).ok, false);
  assert.equal((await rpc("mcp.marketInstall", { id: "filesystem", name: "files", directory: "relative" })).ok, false);
  assert.equal((await rpc("mcp.marketInstall", { id: "memory", name: "mariocode-browser" })).ok, false);
  pass("market requires credentials, absolute directories and nonreserved names");
  const config = { type: "stdio", command: "npx", args: ["-y", "fixture", allowedDir], env: { TEST: "fixture" } };
  assert.equal((await rpc("mcp.import", { servers: [{ name: "cli-example", config, origin: "global" }] })).imported.length, 1);
  assert.equal((await rpc("mcp.import", { servers: [{ name: "cli-example", config }] })).skipped.length, 1);
  assert.equal((await rpc("mcp.toggle", { name: "cli-example", scope: "user", enabled: false })).ok, true);
  const updated = { ...config, env: { TEST: "updated" } };
  assert.equal((await rpc("mcp.update", { name: "cli-example", config: updated })).ok, true);
  assert.deepEqual((await rpc("mcp.read", { name: "cli-example" })).config, updated);
  assert.equal((await rpc("mcp.list")).servers.find((s) => s.name === "cli-example").enabled, false);
  pass("imports skip duplicates; edits preserve disabled state and arguments containing spaces");

  await evaluate("document.querySelector('button .tabler-icon-settings').closest('button').click()");
  if (process.argv.includes("--settings-layout")) {
    const key = async (name, code) => {
      await command("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: code });
      await command("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code });
    };
    const viewport = (width, height) => command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await viewport(1680, 1050);
    await waitFor("document.activeElement?.getAttribute('placeholder')==='搜索设置'");
    assert.equal(await evaluate("document.querySelectorAll('.settings-root nav button[aria-expanded=true]').length"), 1);
    await screenshot("settings-general-wide");
    await fill('input[placeholder="搜索设置"]', "MCP");
    await click("MCP");
    await waitFor("document.querySelector('main.settings-content[aria-label=MCP]') && document.querySelector('input[placeholder=搜索设置]').value===''");
    pass("settings search reveals collapsed categories and navigates to the selected page");

    await viewport(1024, 760);
    await fill('input[placeholder="搜索设置"]', "常规");
    await click("常规");
    await waitFor("getComputedStyle(document.querySelector('.setting-row[data-layout=horizontal]')).flexDirection==='column'");
    assert.equal(await evaluate("document.querySelector('.settings-content').scrollWidth<=document.querySelector('.settings-content').clientWidth+1"), true);
    await fill('input[placeholder="搜索设置"]', "模型配置");
    await click("模型配置");
    await waitFor("getComputedStyle(document.querySelector('.settings-provider-layout')).gridTemplateColumns.split(' ').length===1");
    await click("新增提供商");
    assert.equal(await evaluate("document.querySelector('.settings-content').scrollWidth<=document.querySelector('.settings-content').clientWidth+1"), true);
    await screenshot("settings-providers-narrow");
    pass("small windows stack setting controls and provider forms without horizontal overflow");

    await fill('input[placeholder="搜索设置"]', "MCP");
    await click("MCP");
    await click("自定义");
    await waitFor("document.querySelectorAll('[role=dialog]').length===2");
    await key("Escape", 27);
    await waitFor("document.querySelector('.settings-root') && document.querySelectorAll('[role=dialog]').length===1");
    await fill('input[placeholder="搜索设置"]', "missing-setting");
    await waitFor("Boolean(document.querySelector('nav [role=status]'))");
    await key("Escape", 27);
    await waitFor("document.querySelector('.settings-root') && document.querySelector('input[placeholder=搜索设置]').value===''");
    pass("Escape dismisses nested dialogs and clears search before closing settings");

    await viewport(1680, 1050);
    await evaluate("(()=>{const items=[...document.querySelector('.settings-root').querySelectorAll('button:not(:disabled),input:not(:disabled),a[href],[tabindex=\"0\"]')].filter(e=>e.getClientRects().length&&e.tabIndex>=0);items.at(-1).focus()})()");
    await key("Tab", 9);
    assert.equal(await evaluate("document.activeElement?.getAttribute('aria-label')==='关闭'"), true);
    await key("Escape", 27);
    await waitFor("!document.querySelector('.settings-root')");
    assert.equal(await evaluate("Boolean(document.activeElement?.querySelector('.tabler-icon-settings'))"), true);
    await evaluate("document.querySelector('button .tabler-icon-settings').closest('button').click()");
    await click("AI 能力"); await click("模型配置");
    await screenshot("settings-providers-wide");
    pass("settings traps keyboard focus and returns focus to the workspace on close");
    const provider = await rpc("sharedProviders.save", {
      name: "Layout fixture", baseUrl: "https://example.invalid/v1",
      protocols: ["chat-completions"], models: [{ id: "fixture-model" }], enabledAgents: ["pi"], apiKey: "layout-fixture-not-a-real-key",
    });
    assert.ok(provider.providers.some((item) => item.name === "Layout fixture"));
    await click("MarioTool");
    await click("去模型配置标记");
    await waitFor("Boolean(document.querySelector('main.settings-content[aria-label=模型配置]'))");
    pass("links inside settings switch pages and keep the owning navigation group expanded");
  } else await click("AI 能力");
  await click("MCP"); await click("发现市场");
  await waitFor("document.querySelectorAll('[data-market-id]').length===6");
  await screenshot("mcp-market");
  await evaluate("document.querySelector('[data-market-id=memory] button').click()");
  await click("添加");
  await waitFor("document.body.innerText.includes('市场安装') && document.body.innerText.includes('memory')");
  assert.equal((await rpc("mcp.list")).servers.find((s) => s.name === "memory").origin.id, "memory");
  assert.equal((await rpc("mcp.marketInstall", { id: "memory", name: "memory" })).ok, false);
  await screenshot("mcp-my-extensions");
  pass("MCP discovery adds a real configuration, returns to My extensions, and retains both origins");
  await evaluate("document.querySelector('[aria-label=筛选来源]').click()");
  await waitFor("Boolean(document.querySelector('[role=option]'))");
  await evaluate("[...document.querySelectorAll('[role=option]')].find(e=>e.innerText.trim()==='市场安装').click()");
  await waitFor("!document.body.innerText.includes('cli-example') && document.body.innerText.includes('memory')");
  pass("source filter hides imports while retaining marketplace items");
  assert.equal((await rpc("mcp.remove", { name: "memory" })).ok, true);
  assert.equal((await rpc("mcp.save", { name: "memory", config })).ok, true);
  assert.equal((await rpc("mcp.list")).servers.find((s) => s.name === "memory").origin.kind, "manual");
  pass("remove and re-add clears stale marketplace provenance");

  assert.equal((await rpc("skills.marketAdd", { url: marketDir })).ok, true);
  const market = (await rpc("skills.marketList")).markets.find((m) => !m.builtin);
  assert.ok(market && market.skills.length === 1);
  assert.equal((await rpc("skills.import", { skills: [{ sourcePath: importedDir, name: "imported-skill" }] })).imported.length, 1);
  await click("技能"); await click("发现市场");
  await waitFor("document.querySelector('[data-skill-market]') && document.body.innerText.includes('market-skill')");
  await screenshot("skills-market");
  await click("安装");
  await waitFor("!document.querySelector('[data-skill-market]') && document.body.innerText.includes('market-skill') && document.body.innerText.includes('imported-skill')");
  const skills = (await rpc("skills.list")).skills;
  assert.equal(skills.find((s) => s.name === "market-skill").origin.kind, "market");
  assert.equal(skills.find((s) => s.name === "imported-skill").origin.kind, "import");
  assert.equal((await rpc("skills.marketInstall", { marketId: market.id, relPath: "market-skill", name: "market-skill" })).ok, false);
  await screenshot("skills-my-extensions");
  pass("inline Skills market installs actual files; imports and market installs share one inventory");
  await evaluate("[...document.querySelectorAll('nav button')].find(b=>b.innerText.includes('market-skill')).click()");
  await waitFor("Boolean(document.querySelector('textarea'))");
  await fill("textarea", "---\nname: market-skill\ndescription: Edited fixture\n---\n\nEdited body\n");
  await click("保存");
  await waitFor("document.body.innerText.includes('Edited fixture')");
  assert.match((await rpc("skills.read", { source: "global", name: "market-skill" })).content, /Edited body/);
  assert.equal((await rpc("skills.list")).skills.find((s) => s.name === "market-skill").origin.kind, "market");
  pass("Skill editor saves content while preserving installation provenance");
  const saved = new DatabaseSync(join(data, "claude-gui.db"));
  const origins = JSON.parse(saved.prepare("SELECT value FROM settings WHERE key='extensions.origins'").get().value);
  saved.close();
  assert.equal(origins.skill["market-skill"].id, market.id);
  assert.equal(origins.mcp["cli-example"].kind, "import");
  const installedFile = await readFile(join(home, ".mariocode", "skills", "market-skill", "SKILL.md"), "utf8");
  assert.match(installedFile, /Edited body/);
  pass("origins persist to SQLite and skill content persists to disk in the isolated profile");
  assert.ok(!stderr.includes("Maximum update depth exceeded"));
  console.log(`${checks} groups passed. Screenshots and log: ${data}`);
} finally {
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Test ended")); }
  pending.clear();
  if (socket?.readyState === WebSocket.OPEN) { socket.send(JSON.stringify({ id: ++id, method: "Browser.close" })); socket.close(); }
  if (child.exitCode === null) { await Promise.race([new Promise((r) => child.once("exit", r)), delay(5000)]); if (child.exitCode === null) child.kill(); }
  log.end();
}
