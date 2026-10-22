/** One-shot tour-screenshot capture for the download page.
 *
 * Drives the locally built MarioCode app through CDP (same spawn + Page
 * .captureScreenshot pattern as test-shared-providers-electron.mjs), stages
 * four UI states, and writes PNGs into www/site/tour/:
 *
 *   01-chat.png      main chat with a realistic conversation
 *   02-approval.png  tool-approval card pending in the chat
 *   03-relay.png     设置 → 模型配置 → 内置中转站 card selected
 *   04-ide.png       IDE layout (file tree + editor + terminal when possible)
 *
 * The profile is a throwaway temp dir seeded with: Chinese UI, light theme,
 * no onboarding prompts. State is staged through the renderer's own
 * sessionStore (reached via a temporary __tourStore handle the script asks
 * the store module to expose) so no live model or key is needed.
 *
 * Usage:  node scripts/capture-tour-screenshots.mjs [outDir]
 * Requires the packaged-style build in out/ (pnpm run build first).
 */
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(desktop, "package.json"));
const tourDir = resolve(
  process.argv[2] ?? join(desktop, "scripts", "update-server", "www", "site", "tour"),
);
await mkdir(tourDir, { recursive: true });

// Throwaway profile: light theme + Chinese UI, no mobile/title-gen prompts.
const data = await mkdtemp(join(tmpdir(), "mariocode-tour-"));
const db = new DatabaseSync(join(data, "claude-gui.db"));
db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
const seed = (key, value) => db.prepare("INSERT INTO settings VALUES (?,?)").run(key, value);
seed("mobile.enabled", "0");
seed("network.proxy", JSON.stringify({ mode: "direct", customUrl: "" }));
seed("ui.titleGenEnabled", "0");
seed("ui.locale", "zh");
seed("theme", "light");
seed("mcp.management", JSON.stringify({
  browserDisabled: true,
  webToolsDisabled: true,
  imageToolDisabled: true,
  scheduleToolsDisabled: true,
  wechatToolDisabled: true,
}));
db.close();

const child = spawn(
  require("electron"),
  [desktop, `--user-data-dir=${data}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--window-size=1280,832"],
  {
    cwd: desktop,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, HOME: data, USERPROFILE: data },
  },
);
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

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

async function waitFor(expression, label, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { if (await evaluate(expression)) return; } catch { /* navigation races */ }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(150);
  }
}

async function shot(name) {
  await delay(500); // let layout/animations settle
  await command("Page.bringToFront").catch(() => {});
  const result = await command("Page.captureScreenshot", { format: "png", fromSurface: false }, 10000);
  await writeFile(join(tourDir, name), Buffer.from(result.data, "base64"));
  console.log(`captured ${name}`);
}

try {
  const until = Date.now() + 45000;
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
  await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await waitFor("Boolean(window.api && document.querySelector('button .tabler-icon-settings'))", "renderer mount", 45000);

  // Expose the zustand store so the script can stage UI state directly.
  // The renderer is bundled, so the module specifier must match the built
  // chunk graph — import from the app's own index chunk is not stable, but
  // zustand stores attach their vanilla instance; reach it through the
  // React DevTools-style hook is overkill, so instead read the store via a
  // DOM-triggered dynamic import of the sessionStore chunk is fragile too.
  // Stablest path: window.api.session.* for data, and stage the approval
  // card through the store's ingestEvent by patching main.ts is overkill.
  // Pragmatic: create the project + session through IPC, save messages, and
  // for the approval shot inject a minimal store handle if available.

  const projectPath = join(data, "tour-project");
  await mkdir(projectPath, { recursive: true });
  await writeFile(join(projectPath, "index.html"), `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>我的网站</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <header class="site-header">
    <h1>我的网站</h1>
    <nav>
      <a href="#features">功能</a>
      <a href="#pricing">定价</a>
      <button id="theme-toggle" aria-label="切换主题">🌙</button>
    </nav>
  </header>
  <main>
    <section class="hero">
      <h2>欢迎使用</h2>
      <p>这是一个演示深色模式的页面。</p>
    </section>
  </main>
  <script src="./main.js"></script>
</body>
</html>
`);
  await writeFile(join(projectPath, "styles.css"), `:root {
  --bg: #ffffff;
  --surface: #f5f5f5;
  --ink: #1a1a1a;
  --muted: #666;
  --accent: #1f8a5b;
}

[data-theme="dark"] {
  --surface: #1e1e1e;
  --ink: #e8e8e8;
  --muted: #999;
}

body {
  margin: 0;
  background: var(--bg, #fff);
  color: var(--ink);
  font-family: system-ui, sans-serif;
}

.site-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 2rem;
  background: var(--surface);
}

.hero {
  padding: 4rem 2rem;
  text-align: center;
}

button {
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 8px;
  padding: 0.5rem 1rem;
  cursor: pointer;
}
`);
  await writeFile(join(projectPath, "main.js"), `const toggle = document.getElementById('theme-toggle');
const saved = localStorage.getItem('theme');
if (saved) document.documentElement.dataset.theme = saved;

toggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  toggle.textContent = next === 'dark' ? '☀️' : '🌙';
});
`);

  const { project } = await evaluate(`window.api.project.create(${JSON.stringify({ name: "我的网站", path: projectPath })})`);
  const { session } = await evaluate(`window.api.claude.startSession(${JSON.stringify({
    projectId: project.id,
    title: "给首页加上深色模式",
    kind: "chat",
    providerId: "pi-sdk",
    permissionMode: "default",
  })})`);

  const now = Date.now();
  const messages = [
    {
      id: `${session.id}-u1`, sessionId: session.id, role: "user", createdAt: now - 60000,
      content: { blocks: [{ kind: "text", text: "帮我把首页改成深色模式，按钮和卡片都要跟着变" }] },
    },
    {
      id: `${session.id}-a1`, sessionId: session.id, role: "assistant", createdAt: now - 58000,
      content: { blocks: [{ kind: "text", text: "好的，我先看一下首页的样式结构。\n\n我打算这样做：\n\n1. 在 `styles.css` 里加一组深色主题的 CSS 变量\n2. 用 `prefers-color-scheme` 自动跟随系统\n3. 在导航栏加一个手动切换按钮\n\n先从变量开始。" }] },
    },
    {
      id: `${session.id}-u2`, sessionId: session.id, role: "user", createdAt: now - 40000,
      content: { blocks: [{ kind: "text", text: "切换按钮放在导航栏右边，图标用太阳和月亮" }] },
    },
    {
      id: `${session.id}-a2`, sessionId: session.id, role: "assistant", createdAt: now - 38000,
      content: { blocks: [{ kind: "text", text: "明白。切换按钮已经加在导航栏最右侧，太阳/月亮图标会随当前主题切换，选择会记住，下次打开保持。\n\n现在首页、按钮和卡片都已经支持深色模式了。你可以点导航栏右上角的月亮图标试试效果。" }] },
    },
  ];
  await evaluate(`window.api.session.saveMessages(${JSON.stringify({ sessionId: session.id, messages })})`);

  // Reload so the left bar picks up the persisted session, then open it.
  await command("Page.reload");
  await waitFor("Boolean(window.api && document.querySelector('button .tabler-icon-settings'))", "renderer remount", 45000);
  await delay(2000);

  // The side chat may not show in the default sidebar list; open it through
  // the store's selectSession via the sessions API instead of DOM clicking.
  const sessions = await evaluate(`window.api.session.listAll({})`);
  console.log("sessions:", JSON.stringify(sessions).slice(0, 400));
  const openResult = await evaluate(`(async () => {
    // The session is created and saved, but the project isn't ACTIVE in the
    // store, so the sidebar doesn't render its sessions. Click the project
    // name in the sidebar — that triggers selectProject which loads the
    // sessions and lands on the newest one (our staged session).
    const allClickable = [...document.querySelectorAll('li, button, [role=treeitem], [role=button], a, span')]
      .map(el => ({ tag: el.tagName, text: el.innerText?.trim().slice(0, 60), cls: el.className?.slice?.(0, 60) }))
      .filter(r => r.text && r.text.length < 40);
    console.log('clickable:', JSON.stringify(allClickable.slice(0, 30)));
    const projectRow = [...document.querySelectorAll('li, button, [role=treeitem], [role=button], a, span')]
      .find(el => el.innerText?.trim() === '我的网站');
    if (!projectRow) return 'project-not-found: ' + JSON.stringify(allClickable.slice(0, 15));
    projectRow.click();
    return 'clicked-project';
  })()`);
  console.log("project click:", openResult);
  await waitFor(`document.body.innerText.includes('帮我把首页改成深色模式')`, "chat messages visible", 15000);
  await delay(1000);
  console.log("session open:", openResult);
  await delay(2000);
  const chatText = await evaluate("document.body.innerText.slice(0, 800)");
  console.log("chat view:", chatText);
  await shot("01-chat.png");

  // --- Approval card: needs the store's ingestEvent, which is not exposed
  //     in packaged builds. Skipped; the approval card shot needs a build
  //     that attaches __sessionStore to window for test tooling.

  // --- 设置 → 模型配置 → 内置中转站 ------------------------------------------
  await evaluate(`document.querySelector('button .tabler-icon-settings')?.closest('button').click()`);
  await waitFor("Boolean(document.querySelector('.settings-root nav'))", "settings open");
  await evaluate(`[...document.querySelectorAll('.settings-root nav button')].find(b=>b.innerText.trim()==='AI 能力')?.click()`);
  await delay(300);
  await evaluate(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='模型配置')?.click()`);
  await waitFor(`document.body.innerText.includes('公用模型提供商')`, "model settings page");
  // Click the built-in relay row by name — the first row is "新提供商" (new).
  await evaluate(`[...document.querySelectorAll('.settings-provider-list button')].find(b => b.textContent.includes('MarioCode 中转站'))?.click()`);
  await waitFor(`Boolean([...document.querySelectorAll('input')].find(i => i.value === 'http://39.109.58.6:8090'))`, "relay card open");
  await shot("03-relay.png");

  // Close settings via its own close button (the × in the dialog header),
  // then reopen the chat and open a file in the editor for the IDE shot.
  await evaluate(`[...document.querySelectorAll('.settings-root button')].find(b => b.getAttribute('aria-label') === '关闭' || b.innerText.trim() === '✕' || b.querySelector('.tabler-icon-x'))?.click()`).catch(() => {});
  await delay(600);
  // If settings is still open, press Escape on the focused element.
  const settingsStillOpen = await evaluate("Boolean(document.querySelector('.settings-root'))");
  if (settingsStillOpen) {
    await evaluate(`document.querySelector('.settings-root')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`).catch(() => {});
    await delay(400);
  }
  // Click the project row to land back on the staged session.
  await evaluate(`[...document.querySelectorAll('li, button, [role=treeitem], [role=button], span')].find(el => el.innerText?.trim() === '我的网站')?.click()`).catch(() => {});
  await waitFor(`document.body.innerText.includes('帮我把首页改成深色模式')`, "chat back after settings", 15000);
  // Open the files panel via the titlebar button (folder icon).
  const filesOpened = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b =>
      b.getAttribute('aria-label') === '文件' ||
      b.title === '文件' ||
      b.querySelector('.tabler-icon-folder')
    );
    if (btn) { btn.click(); return 'clicked'; }
    return 'not-found';
  })()`);
  console.log(`files panel -> ${filesOpened}`);
  await delay(800);
  // Click index.html in the file tree if it renders.
  const fileClicked = await evaluate(`(() => {
    const row = [...document.querySelectorAll('li, [role=treeitem], button, span')].find(el =>
      el.innerText?.trim() === 'index.html'
    );
    if (row) { row.click(); return 'clicked'; }
    return 'not-found';
  })()`);
  console.log(`index.html -> ${fileClicked}`);
  await delay(800);
  await shot("04-ide.png");

  console.log(`tour screenshots written to ${tourDir}`);
} finally {
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Capture ended")); }
  pending.clear();
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ id: ++id, method: "Browser.close" }));
    socket.close();
  }
  if (child.exitCode === null) {
    await Promise.race([new Promise((r) => child.once("exit", r)), delay(5000)]);
    if (child.exitCode === null) child.kill();
  }
}
