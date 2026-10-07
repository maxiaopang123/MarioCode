import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { electronTest, desktop, delay } from "./electron-test-helper.mjs";
import { startSshFixture } from "./ssh-fixture.mjs";
import { startSharedProviderFixture } from "./shared-provider-http-fixture.mjs";
const require = createRequire(join(desktop, "package.json"));
const ssh = await startSshFixture(); const upstream = await startSharedProviderFixture();
try {
await electronTest("todo026-validation", async data => {
  const db = new DatabaseSync(join(data, "claude-gui.db")); db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  for (const [key, value] of Object.entries({ "mobile.enabled": "0", "ui.titleGenEnabled": "0", "network.proxy": JSON.stringify({ mode: "direct", customUrl: "" }), "mcp.management": JSON.stringify({ browserDisabled: true, webToolsDisabled: true, imageToolDisabled: true, scheduleToolsDisabled: true, wechatToolDisabled: true }) })) db.prepare("INSERT INTO settings VALUES (?,?)").run(key, value);
  db.close();
}, async ({ data, evaluate, wait, command, errors }) => {
  assert.equal((await evaluate("window.api.sshCatalog.get()")).enabled, false);
  const click = async text => { await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})?.click()`); await delay(120); };
  const fill = async (id, text) => { await evaluate(`document.getElementById(${JSON.stringify(id)}).focus()`); await command("Input.insertText", { text }); };
  await evaluate("document.querySelector('button .tabler-icon-settings').closest('button').click()");
  await wait("[...document.querySelectorAll('.settings-root nav button')].some(b=>b.textContent.trim()==='AI 能力')"); await click("AI 能力"); await click("MCP");
  await wait("document.body.innerText.includes('内置 MCP 目录')");
  assert.equal(await evaluate("document.querySelector('[role=switch][aria-label=\"SSH 远程命令\"]').getAttribute('aria-checked')"), "false");
  await click("添加 SSH 主机");
  await fill("ssh-alias", "test"); await fill("ssh-address", "127.0.0.1");
  await evaluate("document.getElementById('ssh-port').focus()");
  await command("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "End", code: "End", windowsVirtualKeyCode: 35 });
  for (let n = 0; n < 2; n++) { await command("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }); await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }); }
  await command("Input.insertText", { text: String(ssh.port) });
  assert.equal(await evaluate("document.getElementById('ssh-port').value"), String(ssh.port));
  await fill("ssh-username", "fixture"); await fill("ssh-password", "ssh-test-password");
  assert.equal(await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim()==='保存').disabled"), true);
  console.log("SSH form before probe", await evaluate("[...document.querySelectorAll('[role=dialog] input')].map(i=>({id:i.id,value:i.type==='password'?'[redacted]':i.value}))"));
  await writeFile(join(data, "ssh-before-probe-dom.txt"), await evaluate("document.body.innerText"));
  await click("获取主机指纹"); await wait(`document.body.innerText.includes(${JSON.stringify(ssh.fingerprint)})`);
  assert.equal(await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent.trim()==='保存').disabled"), true);
  await evaluate("document.getElementById('ssh-alias').closest('[role=dialog]').querySelector('input[type=checkbox]').click()");
  assert.equal(await evaluate("[...document.getElementById('ssh-alias').closest('[role=dialog]').querySelectorAll('button')].find(b=>b.textContent.trim()==='保存').disabled"), false);
  const formShot = await command("Page.captureScreenshot", { format: "png" }); await writeFile(join(data, "ssh-host-form.png"), Buffer.from(formShot.data, "base64"));
  await click("保存"); await wait("!document.getElementById('ssh-alias')");
  const state = await evaluate("window.api.sshCatalog.get()"); assert.equal(state.hosts.length, 1); assert.ok(!JSON.stringify(state).includes("ssh-test-password"));
  await evaluate("document.querySelector('[role=switch][aria-label=\"SSH 远程命令\"]').click()"); await wait("document.querySelector('[role=switch][aria-label=\"SSH 远程命令\"]').getAttribute('aria-checked')==='true'");
  const catalogShot = await command("Page.captureScreenshot", { format: "png" }); await writeFile(join(data, "ssh-catalog.png"), Buffer.from(catalogShot.data, "base64"));
  assert.ok(!(await readFile(join(data, ".mariocode/.claude.json"), "utf8")).includes("ssh-test-password"));
  const db = new DatabaseSync(join(data, "claude-gui.db"), { readOnly: true }); assert.ok(!db.prepare("SELECT value FROM settings WHERE key='mcp.catalog.ssh.keys'").get().value.includes("ssh-test-password")); db.close();
  // Edit retains a secret without exposing it to the form.
  await click("编辑"); await wait("Boolean(document.getElementById('ssh-password'))"); assert.equal(await evaluate("document.getElementById('ssh-password').value"), ""); await click("保存"); await wait("!document.getElementById('ssh-alias')");
  // Select actual local runtimes in the isolated profile.
  assert.equal((await evaluate(`window.api.runtimes.select(${JSON.stringify({ agent: "pi", mode: "external", path: join(desktop, "node_modules/@earendil-works/pi-coding-agent"), nodePath: process.execPath })})`)).ok, true);
  const suffix = `${process.platform}-${process.arch}`;
  const sdkRequire = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
  const claudePath = join(dirname(sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${suffix}/package.json`)), process.platform === "win32" ? "claude.exe" : "claude");
  assert.equal((await evaluate(`window.api.runtimes.select(${JSON.stringify({ agent: "claude", mode: "external", path: claudePath })})`)).ok, true);
  const triples = { "win32-x64": "x86_64-pc-windows-msvc", "linux-x64": "x86_64-unknown-linux-musl", "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin" };
  const codexPath = join(desktop, "../../node_modules/.pnpm", `@openai+codex@${require("@openai/codex/package.json").version}-${suffix}`, "node_modules/@openai/codex/vendor", triples[suffix], "bin", process.platform === "win32" ? "codex.exe" : "codex");
  assert.equal((await evaluate(`window.api.runtimes.select(${JSON.stringify({ agent: "codex", mode: "external", path: codexPath })})`)).ok, true);
  const baseUrl = `http://127.0.0.1:${upstream.port}/v1`;
  const providers = (await evaluate(`window.api.sharedProviders.save(${JSON.stringify({ name: "SSH fixture", baseUrl, apiKey: "ssh-upstream-fake-key", protocols: ["chat-completions", "anthropic", "responses"], enabledAgents: ["claude", "pi", "codex"], models: [{ id: "ssh-pi", interfaces: ["chat-completions"] }, { id: "ssh-claude", interfaces: ["anthropic"] }, { id: "ssh-codex", interfaces: ["responses"] }] })})`)).providers;
  const runtimeId = `shared_${providers[0].id.replaceAll("-", "")}`;
  const cwd = join(data, "ssh-project"); await mkdir(cwd); const { project } = await evaluate(`window.api.project.create(${JSON.stringify({ name: "SSH test", path: cwd })})`);
  for (const [engine, model] of [["pi-sdk", "ssh-pi"], ["claude-sdk", "ssh-claude"], ["codex-sdk", "ssh-codex"]]) {
    upstream.setToolPlan(model, "ssh_exec", ["uptime", "pwd"]);
    const { session } = await evaluate(`window.api.claude.startSession(${JSON.stringify({ projectId: project.id, title: `SSH ${engine}`, providerId: engine, model: engine === "claude-sdk" ? model : `${runtimeId}/${model}`, customModelId: engine === "claude-sdk" ? runtimeId : undefined, permissionMode: "bypassPermissions" })})`);
    await evaluate("globalThis.__sshEvents=[];globalThis.__sshStop=window.api.on.claudeEvent(m=>globalThis.__sshEvents.push(m.event))");
    const before = ssh.commands.length;
    await evaluate(`window.api.claude.sendTurn(${JSON.stringify({ sessionId: session.id, prompt: "Run the SSH commands", model: engine === "claude-sdk" ? model : `${runtimeId}/${model}` })})`);
    const answered = new Set(); const until = Date.now() + 60000;
    let events;
    while (true) {
      events = await evaluate("globalThis.__sshEvents");
      for (const event of events.filter(e => e.type === "approval.request" && !answered.has(e.requestId))) {
        assert.equal(event.oneShotOnly, true, JSON.stringify(event)); assert.equal(event.toolName, "ssh_exec"); answered.add(event.requestId);
        await evaluate(`window.api.claude.approve(${JSON.stringify({ sessionId: session.id, requestId: event.requestId, granted: true, always: true })})`);
      }
      if (events.some(e => e.type === "turn.done")) break;
      if (Date.now() > until) throw Error(`${engine} timeout: ${JSON.stringify(events)}`);
      await delay(100);
    }
    await evaluate("globalThis.__sshStop()");
    await writeFile(join(data, `${engine}-events.json`), JSON.stringify(events, null, 2));
    assert.ok(!events.some(e => e.type === "error"), JSON.stringify(events)); assert.equal(answered.size, 2, JSON.stringify(events)); assert.deepEqual(ssh.commands.slice(before), ["uptime", "pwd"]);
    assert.ok(events.filter(e => e.type === "text.delta").map(e => e.text).join("").includes(`fixture-ok:${model}`));
    console.log(`PASS real ${engine}: two MCP SSH calls, two approvals even in bypass`);
    if (engine === "codex-sdk") await delay(750);
  }
  await evaluate("location.reload()"); await wait("Boolean(window.api && document.querySelector('button .tabler-icon-settings'))");
  assert.equal((await evaluate("window.api.sshCatalog.get()")).hosts[0].hasCredential, true);
  await evaluate("window.api.sshCatalog.setEnabled({enabled:false})"); await evaluate(`window.api.sshCatalog.removeHost({id:${JSON.stringify(state.hosts[0].id)}})`);
  assert.ok(!(await readFile(join(data, ".mariocode/.claude.json"), "utf8")).includes('"mariocode-mcp-ssh"'));
  assert.deepEqual(errors, []);
  await writeFile(join(data, "upstream-requests.json"), JSON.stringify(upstream.requests, null, 2));
});
} finally { await ssh.close(); await upstream.close(); }
