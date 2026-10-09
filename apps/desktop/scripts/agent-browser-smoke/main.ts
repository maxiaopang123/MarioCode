/**
 * TODO-051 smoke: Agent browser views are isolated from the user's tabs and
 * are recycled. Runs the REAL BrowserManager + agentBrowserTools inside a
 * headless Electron main (the window module is stubbed, see window.ts).
 *
 * Covers: user tab untouched · session isolation · list scoped to the session ·
 * per-session cap (LRU eviction) · idle TTL reaper · touch revives · presented
 * views survive the reaper · session removal closes views and tells the
 * renderer · take-over turns a view into a user tab the agent can no longer use.
 */
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  BrowserManager,
  AGENT_VIEWS_PER_SESSION_MAX,
  AGENT_VIEW_IDLE_TTL_MS,
} from "@main/browser/BrowserManager.js";
import {
  browserList,
  browserNavigate,
  browserPresent,
  browserSnapshot,
} from "@main/browser/agentBrowserTools.js";
import { initDb, closeDb } from "@main/store/db.js";
import { setTestWindow, sentMessages } from "./window.js";

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map(c => (c.type === "text" ? c.text ?? "" : "")).join("\n");
const agentViews = (session: string) =>
  BrowserManager.list().filter(i => i.owner === "agent" && i.agentSessionId === session);

async function main() {
  const data = process.env.MARIOCODE_SMOKE_DATA!;
  app.setPath("userData", data);
  app.on("window-all-closed", () => {});
  await app.whenReady();
  await initDb();
  const server = createServer((req, res) => {
    const name = (req.url ?? "/").replace(/^\//, "") || "root";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<html><body><h1>Fixture page ${name}</h1><button id="b">go</button></body></html>`);
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const window = new BrowserWindow({ width: 1000, height: 750, show: true });
  setTestWindow(window);

  try {
    // ── A user tab the agent must never touch ──
    const user = BrowserManager.create(data);
    assert.ok(user.ok);
    const userId = user.browserId;
    BrowserManager.loadUrl(userId, `${base}/user-page`);
    await BrowserManager.waitForLoad(userId);
    const userUrlBefore = BrowserManager.list().find(i => i.browserId === userId)!.url;
    assert.ok(userUrlBefore.endsWith("/user-page"));

    // ── 1. navigate auto-creates a HIDDEN agent view; the user's tab is untouched ──
    const nav = await browserNavigate({ url: `${base}/a1` }, data, "S1");
    assert.ok(!textOf(nav).startsWith("❌"), textOf(nav));
    assert.equal(agentViews("S1").length, 1, "one agent view for S1");
    const a1 = agentViews("S1")[0].browserId;
    assert.notEqual(a1, userId);
    const views = window.contentView.children.map(v => v.getBounds());
    assert.ok(views.some(b => b.x < 0), "agent view is off-screen");
    assert.equal(BrowserManager.list().find(i => i.browserId === userId)!.url, userUrlBefore, "user tab URL unchanged");
    assert.equal(BrowserManager.list().find(i => i.browserId === userId)!.owner, "user");

    // ── 2. isolation: the agent cannot target the user's tab; sessions don't leak ──
    const snapUser = textOf(await browserSnapshot({ browserId: userId }, "S1"));
    assert.ok(snapUser.startsWith("❌") && snapUser.includes("用户的浏览器标签"), "user tab is refused: " + snapUser);
    const snapOwn = textOf(await browserSnapshot({}, "S1"));
    assert.ok(snapOwn.includes("Fixture page a1"), "implicit target is the agent's own view");
    const snapOther = textOf(await browserSnapshot({ browserId: a1 }, "S2"));
    assert.ok(snapOther.startsWith("❌"), "another session cannot use S1's view");
    const list = textOf(browserList("S1"));
    assert.ok(list.includes(a1) && !list.includes(userId), "list shows only this session's agent views");
    assert.ok(textOf(browserList("S2")).includes("没有 Agent 的浏览器视图"), "S2 sees none");

    // ── 3. per-session cap evicts the least recently used view ──
    await delay(8);
    await browserNavigate({ url: `${base}/a2`, newTab: true }, data, "S1");
    await delay(8);
    await browserNavigate({ url: `${base}/a3`, newTab: true }, data, "S1");
    assert.equal(agentViews("S1").length, AGENT_VIEWS_PER_SESSION_MAX);
    const ids = agentViews("S1").map(i => i.browserId);
    const a2 = ids.find(id => id !== a1 && BrowserManager.list().find(i => i.browserId === id)!.url.endsWith("/a2"))!;
    await delay(8);
    await browserSnapshot({ browserId: a1 }, "S1"); // a1 becomes the newest; a2 is now the LRU
    await delay(8);
    await browserNavigate({ url: `${base}/a4`, newTab: true }, data, "S1");
    const after = agentViews("S1").map(i => i.browserId);
    assert.equal(after.length, AGENT_VIEWS_PER_SESSION_MAX, "cap holds");
    assert.ok(!after.includes(a2), "LRU view (a2) was evicted");
    assert.ok(after.includes(a1), "recently used view survived");

    // ── 4. idle reaper: not before the TTL, after it only idle views ──
    BrowserManager.markIdleForSession("S1");
    assert.deepEqual(BrowserManager.reapIdleAgentViews(Date.now()), [], "fresh idle views are kept");
    BrowserManager.touchAgentView(a1); // used again → active, must survive the reaper
    const reaped = BrowserManager.reapIdleAgentViews(Date.now() + AGENT_VIEW_IDLE_TTL_MS + 1000);
    assert.equal(reaped.length, AGENT_VIEWS_PER_SESSION_MAX - 1, "only the still-idle views are reaped");
    assert.ok(!reaped.includes(a1) && BrowserManager.list().some(i => i.browserId === a1), "touched view lives on");
    assert.ok(BrowserManager.list().some(i => i.browserId === userId), "user tab never reaped");

    // ── 5. presented views survive the reaper; session removal closes them + notifies the renderer ──
    await browserNavigate({ url: `${base}/login` }, data, "S3");
    const s3 = agentViews("S3")[0].browserId;
    const present = textOf(await browserPresent({ note: "请登录" }, "S3"));
    assert.ok(!present.startsWith("❌"), present);
    BrowserManager.markIdleForSession("S3"); // presented → must NOT go idle
    assert.deepEqual(BrowserManager.reapIdleAgentViews(Date.now() + AGENT_VIEW_IDLE_TTL_MS * 10), [], "presented view is never reaped");
    sentMessages.length = 0;
    const closed = BrowserManager.closeAgentViewsForSession("S3");
    assert.deepEqual(closed, [s3]);
    assert.ok(!BrowserManager.list().some(i => i.browserId === s3), "session removal destroys the view");
    assert.ok(
      sentMessages.some(m => (m as { type?: string; browserId?: string }).type === "closed" && (m as { browserId?: string }).browserId === s3),
      "renderer is told to drop the adopted tab",
    );

    // ── 6. take-over: the view becomes the user's; the agent opens a fresh one ──
    await browserNavigate({ url: `${base}/oauth` }, data, "S4");
    const s4 = agentViews("S4")[0].browserId;
    await browserPresent({ note: "完成授权" }, "S4");
    assert.ok(BrowserManager.takeoverBrowser(s4).ok);
    assert.equal(BrowserManager.list().find(i => i.browserId === s4)!.owner, "user");
    const refused = textOf(await browserSnapshot({ browserId: s4 }, "S4"));
    assert.ok(refused.startsWith("❌"), "agent can no longer use a taken-over view");
    await browserNavigate({ url: `${base}/oauth-next` }, data, "S4");
    assert.equal(agentViews("S4").length, 1, "agent opened a new hidden view");
    assert.notEqual(agentViews("S4")[0].browserId, s4);

    console.log("PASS: agent-browser isolation and recycling");
  } finally {
    BrowserManager.disposeAll();
    window.destroy();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    closeDb();
  }
}
main().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
