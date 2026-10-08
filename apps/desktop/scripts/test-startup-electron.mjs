/** Restore an existing profile in the V4 project sidebar (TODO-044 step 2).
 * The saved chat lives in a project that is not the first one, a stale V3
 * `ui.streamScope` is persisted, and another project holds 31 chats: startup
 * must restore the chat + history, clear the stale scope, expand only the
 * active project, and "显示更多" must page to the oldest row without errors. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { electronTest, desktop, delay } from "./electron-test-helper.mjs";

await electronTest("startup-recovery", async data => {
  const db = new DatabaseSync(join(data, "claude-gui.db"));
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  for (const [key, value] of Object.entries({
    "mobile.enabled": "0", "ui.titleGenEnabled": "0", "clawbot.chat.enabled": "0",
    "network.proxy": JSON.stringify({ mode: "direct", customUrl: "" }),
  })) db.prepare("INSERT INTO settings VALUES (?,?)").run(key, value);
  db.close();
  await mkdir(join(data, "many"));
  await mkdir(join(data, "active"));
}, async ({ data, evaluate, wait, command, errors }) => {
  const fixture = await evaluate(`(async()=>{
    const {project:many}=await window.api.project.create({name:"Many chats",path:${JSON.stringify(join(data, "many"))}});
    const {project:active}=await window.api.project.create({name:"Restored project",path:${JSON.stringify(join(data, "active"))}});
    const ids=[];
    for(let i=0;i<31;i++){
      const {session}=await window.api.claude.startSession({projectId:many.id,title:"Page fixture "+i});
      ids.push(session.id);
    }
    const {session}=await window.api.claude.startSession({projectId:active.id,title:"Restored chat"});
    await window.api.session.saveMessages({sessionId:session.id,messages:[
      {id:"restore-user",sessionId:session.id,role:"user",content:[{kind:"text",text:"Existing profile"}],createdAt:1},
      {id:"restore-assistant",sessionId:session.id,role:"assistant",content:{blocks:[{kind:"text",text:"Restored history is intact."}]},createdAt:2}
    ]});
    // A scope persisted by the removed V3 rail must not narrow anything now.
    await window.api.setting.set({key:"ui.streamScope",value:many.id});
    await window.api.setting.set({key:"ui.lastProjectId",value:active.id});
    await window.api.setting.set({key:"ui.lastSessionId",value:session.id});
    return {many:many.id,active:active.id,session:session.id,ids};
  })()`);
  const db = new DatabaseSync(join(data, "claude-gui.db"));
  for (let i=0; i<fixture.ids.length; i++) {
    db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(100+i, fixture.ids[i]);
  }
  db.close();

  // Locate the real store export in the built app (no production debug API).
  const require = createRequire(join(desktop, "package.json"));
  let storeUrl, storeExport;
  const asar = process.env.MARIOCODE_TEST_ASAR;
  const archive = asar ? createRequire(require.resolve("electron-builder"))("@electron/asar") : null;
  const entries = asar
    ? archive.listPackage(asar).filter(p => /[\\/]out[\\/]renderer[\\/]assets[\\/].*\.js$/.test(p))
    : (await readdir(join(desktop, "out/renderer/assets"))).filter(p => p.endsWith(".js"));
  for (const entry of entries) {
    const file = asar ? join(asar, entry.slice(1)) : join(desktop, "out/renderer/assets", entry);
    const source = asar ? archive.extractFile(asar, entry.slice(1)).toString() : await readFile(file, "utf8");
    const match = source.match(/\buseSessionStore as (\w+)/);
    if (match) { storeUrl = pathToFileURL(file).href; storeExport = match[1]; break; }
  }
  assert.ok(storeUrl && storeExport, "Built renderer exports its store");
  const attachStore = () => evaluate(`import(${JSON.stringify(storeUrl)}).then(m=>{window.startupTestStore=m[${JSON.stringify(storeExport)}];return true;})`);

  for (let i=0; i<2; i++) {
    await command("Page.reload");
    await delay(150);
    await wait("Boolean(document.body?.textContent.includes('Restored history is intact.'))");
    await attachStore();
    await wait("window.startupTestStore.getState().streamScope===null");
    const state = await evaluate(`(()=>{const s=window.startupTestStore.getState();return {
      projects:s.projects.length,active:s.activeSessionId,scope:s.streamScope,
      expanded:Object.keys(s.expandedProjects).filter(k=>s.expandedProjects[k]),
      manyLoaded:(s.sessionsByProject[${JSON.stringify(fixture.many)}]||[]).length,
      manyTotal:s.sessionsTotalByProject[${JSON.stringify(fixture.many)}],
      composer:Boolean(document.querySelector('[contenteditable=true]')),
      headers:[...document.querySelectorAll('section button[aria-expanded]')].map(b=>({t:b.textContent,open:b.getAttribute('aria-expanded')})),
      restoredRow:[...document.querySelectorAll('[role=button]')].some(n=>n.textContent.includes('Restored chat'))
    };})()`);
    assert.equal(state.projects, 2, "Existing projects hydrate");
    assert.equal(state.active, fixture.session, "Last chat restores");
    assert.equal(state.scope, null, "Stale V3 scope is cleared");
    assert.deepEqual(state.expanded, [fixture.active], "Only the active project starts expanded");
    assert.equal(state.headers.length, 2, "Both projects render a header");
    assert.ok(state.restoredRow, "Active chat row is visible in its project");
    assert.equal(state.manyLoaded, 5, "A busy project loads only its first page");
    assert.equal(state.manyTotal, 31);
    assert.ok(state.composer, "Chat pane mounts");
  }

  // Expand the busy project and page to its oldest row with 显示更多.
  await evaluate(`[...document.querySelectorAll('section button[aria-expanded]')].find(b=>b.textContent.includes('Many chats')).click()`);
  await wait("[...document.querySelectorAll('[role=button]')].some(n=>n.textContent.includes('Page fixture 30'))");
  for (let i=0; i<8; i++) {
    if (await evaluate(`(window.startupTestStore.getState().sessionsByProject[${JSON.stringify(fixture.many)}]||[]).length>=31`)) break;
    const clicked = await evaluate("(()=>{const b=[...document.querySelectorAll('button')].find(n=>n.textContent.includes('显示更多'));if(!b)return false;b.click();return true})()");
    if (!clicked) break;
    await delay(400);
  }
  assert.equal(await evaluate(`(window.startupTestStore.getState().sessionsByProject[${JSON.stringify(fixture.many)}]||[]).length`), 31, "Paging reaches every chat");
  await wait("![...document.querySelectorAll('button')].some(n=>n.textContent.includes('显示更多'))");

  // Opening the oldest chat works and keeps the restored history readable.
  await evaluate(`window.startupTestStore.getState().openTab(${JSON.stringify(fixture.ids[0])})`);
  await wait(`window.startupTestStore.getState().activeSessionId===${JSON.stringify(fixture.ids[0])}`);
  await evaluate(`window.startupTestStore.getState().openTab(${JSON.stringify(fixture.session)})`);
  await wait("document.body.textContent.includes('Restored history is intact.')");
  assert.equal((await evaluate(`window.api.session.messages({sessionId:${JSON.stringify(fixture.session)}})`)).messages.length, 2);
  assert.deepEqual(errors, [], "No renderer exceptions");
  const screenshot = await command("Page.captureScreenshot", { format: "png" });
  await writeFile(join(data, "startup-recovered.png"), Buffer.from(screenshot.data, "base64"));
});
