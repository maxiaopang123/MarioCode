/** Settings navigation must remain painted and interactive, not just mounted
 * in the DOM. Uses an isolated profile and real pointer events. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { createWriteStream, readdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(desktop, "package.json"));
const pnpmDir = resolve(desktop, "../../node_modules/.pnpm");
const pngPackage = readdirSync(pnpmDir).find((entry) => entry.startsWith("pngjs@"));
assert.ok(pngPackage, "Installer's existing PNG decoder must be available");
const { PNG } = require(join(pnpmDir, pngPackage, "node_modules/pngjs"));
const data = await mkdtemp(join(tmpdir(), "mariocode-settings-navigation-"));
const db = new DatabaseSync(join(data, "claude-gui.db"));
db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
db.prepare("INSERT INTO settings VALUES (?,?)").run("mobile.enabled", "0");
db.close();
const child = spawn(require("electron"), [process.env.MARIOCODE_TEST_ASAR || desktop, `--user-data-dir=${data}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"], {
  cwd: desktop, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, HOME: data, USERPROFILE: data },
});
const log = createWriteStream(join(data, "electron.log"));
let stderr = "", socket, id = 0;
child.stdout.pipe(log, { end: false });
child.stderr.on("data", (chunk) => { stderr += String(chunk); log.write(chunk); });
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const pending = new Map(), errors = [], results = [];
const command = (method, params = {}, timeout = 15000) => new Promise((done, fail) => {
  const requestId = ++id;
  const timer = setTimeout(() => { pending.delete(requestId); fail(new Error(`CDP timeout: ${method}`)); }, timeout);
  pending.set(requestId, { done, fail, timer });
  socket.send(JSON.stringify({ id: requestId, method, params }));
});
const evaluate = async (expression) => {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "Renderer evaluation failed");
  return result.result.value;
};
const waitFor = async (expression) => {
  const until = Date.now() + 20000;
  while (!await evaluate(expression)) {
    if (Date.now() > until) throw new Error(`Condition not met: ${expression}`);
    await delay(100);
  }
};
const pointerClick = async (selector) => {
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Click target missing');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);
  assert.equal(point.hit, true, `Pointer target must be visible: ${selector}`);
  await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: point.x, y: point.y });
  await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: point.x, y: point.y });
};
const navClick = async (label) => {
  await evaluate(`(()=>{const e=[...document.querySelectorAll('.settings-root nav button')].find(b=>b.innerText.trim()===${JSON.stringify(label)});if(!e)throw Error('Nav target missing');e.dataset.navigationTest='target'})()`);
  await pointerClick('[data-navigation-test="target"]');
  await evaluate("document.querySelector('[data-navigation-test]')?.removeAttribute('data-navigation-test')");
};
const assertPainted = async (name) => {
  await delay(500);
  const rect = await evaluate("(()=>{const r=document.querySelector('.settings-root').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()");
  const { data: encoded } = await command("Page.captureScreenshot", { format: "png", clip: rect });
  const buffer = Buffer.from(encoded, "base64");
  await writeFile(join(data, `${name}.png`), buffer);
  const png = PNG.sync.read(buffer), colors = new Set();
  for (let y = 10; y < png.height - 10; y += 3) {
    for (let x = 10; x < png.width - 10; x += 3) {
      const p = (y * png.width + x) * 4;
      colors.add(`${png.data[p]},${png.data[p + 1]},${png.data[p + 2]}`);
    }
  }
  results.push({ name, colors: colors.size });
  if (colors.size <= 30) {
    await writeFile(join(data, "blank-dom.json"), JSON.stringify(await evaluate("(()=>{const e=document.querySelector('.settings-root');return{body:document.body.innerText.slice(0,6000),root:e.outerHTML.slice(0,3000),ancestors:[e,e.parentElement,document.body,document.documentElement].map(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return{tag:n.tagName,rect:{x:r.x,y:r.y,width:r.width,height:r.height},scrollTop:n.scrollTop,scrollLeft:n.scrollLeft,opacity:s.opacity,visibility:s.visibility,transform:s.transform,contentVisibility:s.contentVisibility}}),hit:document.elementFromPoint(400,300)?.outerHTML.slice(0,300)}})()"), null, 2));
    const alternate = await command("Page.captureScreenshot", { format: "png", fromSurface: false });
    await writeFile(join(data, `${name}-alternate.png`), Buffer.from(alternate.data, "base64"));
  }
  assert.ok(colors.size > 30, `Settings became blank in ${name}: only ${colors.size} colors`);
  assert.equal(errors.length, 0, `Renderer exceptions: ${JSON.stringify(errors)}`);
};

try {
  const until = Date.now() + 40000;
  let port;
  while (!(port = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1])) {
    if (Date.now() > until || child.exitCode !== null) throw new Error(`Electron startup failed: ${stderr.slice(-1200)}`);
    await delay(100);
  }
  let page;
  while (!page) {
    page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((entry) => entry.type === "page" && entry.url.startsWith("file:"));
    if (Date.now() > until) throw new Error("Renderer missing");
    if (!page) await delay(100);
  }
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", fail, { once: true }); });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer);
    message.error ? waiter.fail(new Error(message.error.message)) : waiter.done(message.result);
  });
  await command("Runtime.enable");
  await waitFor("Boolean(window.api && document.querySelector('button .tabler-icon-settings'))");
  await evaluate("window.api.theme.set({theme:'light'})");
  await pointerClick("button:has(.tabler-icon-settings)");
  await waitFor("Boolean(document.querySelector('.settings-root nav'))");
  await assertPainted("initial-general");
  for (const theme of ["light", "dark"]) {
    await evaluate(`window.api.theme.set({theme:${JSON.stringify(theme)}})`);
    for (const [width, height] of [[1024, 760], [1680, 1050]]) {
      await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      for (let round = 0; round < 3; round++) {
        for (const label of ["外观", "常规"]) {
          await navClick(label);
          await waitFor(`document.querySelector('main.settings-content')?.getAttribute('aria-label')===${JSON.stringify(label)}`);
          await assertPainted(`${theme}-${width}-${round}-${label}`);
        }
      }
    }
  }
  await pointerClick('.settings-root button[aria-label="关闭"]');
  await waitFor("!document.querySelector('.settings-root')");
  await pointerClick("button:has(.tabler-icon-settings)");
  await waitFor("Boolean(document.querySelector('.settings-root nav'))");
  await assertPainted("reopened-general");
  console.log(`Settings navigation passed (${results.length} painted screens). Artifacts: ${data}`);
} finally {
  await writeFile(join(data, "verification.json"), JSON.stringify({ results, errors }, null, 2));
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ id: ++id, method: "Browser.close" }));
    socket.close();
  }
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.fail(new Error("Test ended")); }
  pending.clear();
  if (child.exitCode === null) {
    await Promise.race([new Promise((done) => child.once("exit", done)), delay(5000)]);
    if (child.exitCode === null) child.kill();
  }
  log.end();
}
