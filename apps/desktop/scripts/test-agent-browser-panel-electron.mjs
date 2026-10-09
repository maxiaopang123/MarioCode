/** TODO-051: the browser panel follows agent-view hand-offs.
 *  Main pushes `presented` / `continued` / `closed` browser events (simulated
 *  here from the main process with a fake browserId); the panel must adopt a
 *  presented view as a tab + show the banner, drop the tab when the view is
 *  handed back or recycled (so no stale agent page lingers in the strip), and
 *  keep the tab when the user takes it over. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { electronTest, desktop, delay } from "./electron-test-helper.mjs";

await electronTest("agent-browser-panel", async data => {
  const db = new DatabaseSync(join(data, "claude-gui.db"));
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  for (const [key, value] of Object.entries({ "mobile.enabled": "0", "ui.titleGenEnabled": "0", "network.proxy": JSON.stringify({ mode: "direct", customUrl: "" }) })) {
    db.prepare("INSERT INTO settings VALUES (?,?)").run(key, value);
  }
  db.close();
  await mkdir(join(data, "work"));
  await writeFile(join(data, "work/browser.html"), "<html><body><h1>Own tab</h1></body></html>");
}, async ({ data, evaluate, mainEvaluate, wait, command, errors }) => {
  const { project } = await evaluate(`window.api.project.create({name:"Agent browser panel",path:${JSON.stringify(join(data, "work"))}})`);
  for (const name of await readdir(join(desktop, "out/renderer/assets"))) {
    if (!name.endsWith(".js")) continue;
    const source = await readFile(join(desktop, "out/renderer/assets", name), "utf8");
    const match = source.match(/\buseSessionStore as (\w+)/);
    if (match) {
      await evaluate(`import(${JSON.stringify(pathToFileURL(join(desktop, "out/renderer/assets", name)).href)}).then(m=>{window.panelTestStore=m[${JSON.stringify(match[1])}];})`);
      break;
    }
  }
  assert.ok(await evaluate("Boolean(window.panelTestStore)"));
  await evaluate(`window.panelTestStore.setState({projects:[${JSON.stringify(project)}]});window.panelTestStore.getState().selectProject(${JSON.stringify(project.id)})`);
  await command("Page.bringToFront");
  await command("Emulation.setFocusEmulationEnabled", { enabled: true });
  const fixtureUrl = pathToFileURL(join(data, "work/browser.html")).href;
  await evaluate(`window.panelTestStore.setState({rightOpen:true,rightPanelTab:"browser",pendingBrowserUrl:${JSON.stringify(fixtureUrl)}})`);
  await wait("window.panelTestStore.getState().browserTabs.length===1");

  await mainEvaluate("globalThis.panelTestElectron=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');true");
  const push = (type, browserId, payload) => mainEvaluate(`(()=>{const m=globalThis.panelTestElectron;for(const w of m.BrowserWindow.getAllWindows())w.webContents.send("browser:event",{channel:"browser:event",browserId:${JSON.stringify(browserId)},type:${JSON.stringify(type)},payload:${JSON.stringify(payload ?? {})}});return true})()`);
  const tabCount = () => evaluate("window.panelTestStore.getState().browserTabs.length");
  const banner = () => evaluate("document.body.textContent.includes('Agent 需要你操作')");
  const ids = () => evaluate("window.panelTestStore.getState().browserTabs.map(t=>t.browserId)");
  const ownId = (await ids())[0];

  // 1. presented → adopted as a tab + banner with the agent's note.
  await push("presented", "agent-view-1", { url: "https://example.test/login", title: "Login", note: "请登录 GitHub" });
  await wait("window.panelTestStore.getState().browserTabs.length===2");
  await wait("document.body.textContent.includes('Agent 需要你操作: 请登录 GitHub')");
  assert.ok((await ids()).includes("agent-view-1"));

  // 2. continued → the adopted tab is dropped, the banner goes, the user's own tab remains.
  await push("continued", "agent-view-1");
  await wait("window.panelTestStore.getState().browserTabs.length===1");
  assert.equal(await banner(), false, "banner cleared after continue");
  assert.deepEqual(await ids(), [ownId], "user's own tab untouched");

  // 3. presented again, then recycled by main (closed) → tab + banner dropped.
  await push("presented", "agent-view-2", { url: "https://example.test/oauth", title: "OAuth", note: "完成授权" });
  await wait("window.panelTestStore.getState().browserTabs.length===2");
  await push("closed", "agent-view-2", { reason: "session-gone" });
  await wait("window.panelTestStore.getState().browserTabs.length===1");
  assert.equal(await banner(), false, "banner cleared after the view was recycled");

  // 4. a `closed` for a view the panel never adopted is a harmless no-op.
  await push("closed", "never-adopted", { reason: "idle-timeout" });
  await delay(200);
  assert.equal(await tabCount(), 1);

  // 4b. presented while the right panel is CLOSED: the hand-off must not be lost —
  //      the store adopts the view, opens the panel on the browser tab and shows the banner.
  await evaluate("window.panelTestStore.setState({rightOpen:false,rightPanelTab:'files'})");
  await delay(200);
  await push("presented", "agent-view-4", { url: "https://example.test/captcha", title: "Captcha", note: "通过验证" });
  await wait("window.panelTestStore.getState().rightOpen&&window.panelTestStore.getState().rightPanelTab==='browser'");
  await wait("window.panelTestStore.getState().browserTabs.length===2");
  await wait("document.body.textContent.includes('Agent 需要你操作: 通过验证')");
  assert.equal(await evaluate("window.panelTestStore.getState().presentedBrowser?.browserId"), "agent-view-4");
  // handed back while the panel is closed again: store-level release, no stale tab
  await evaluate("window.panelTestStore.setState({rightOpen:false,rightPanelTab:'files'})");
  await delay(200);
  await push("continued", "agent-view-4");
  await wait("window.panelTestStore.getState().browserTabs.length===1");
  assert.equal(await evaluate("window.panelTestStore.getState().presentedBrowser"), null, "presented cleared without the panel");
  await evaluate("window.panelTestStore.setState({rightOpen:true,rightPanelTab:'browser'})");
  await delay(300);

  // 5. presented again, take over → banner gone, the page stays as an ordinary tab.
  await push("presented", "agent-view-3", { url: "https://example.test/2fa", title: "2FA", note: "输入验证码" });
  await wait("window.panelTestStore.getState().browserTabs.length===2");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='接管').click()");
  await wait("!document.body.textContent.includes('Agent 需要你操作')");
  await delay(200);
  assert.equal(await tabCount(), 2, "taken-over page stays as the user's tab");
  assert.ok((await ids()).includes("agent-view-3"));

  assert.deepEqual(errors, [], "No renderer exceptions");
}, { mainInspector: true });
