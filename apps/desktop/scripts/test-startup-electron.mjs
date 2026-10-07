/** Restore an existing profile whose active chat is outside the saved sidebar
 * scope. The first page has more results while startup re-dirties it: automatic
 * row location must allow IPC, React commits and the scoped refresh to finish. */
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
  await mkdir(join(data, "scope"));
  await mkdir(join(data, "active"));
}, async ({ data, evaluate, wait, command, errors }) => {
  const fixture = await evaluate(`(async()=>{
    const {project:scope}=await window.api.project.create({name:"Sidebar fixture",path:${JSON.stringify(join(data, "scope"))}});
    const {project:active}=await window.api.project.create({name:"Restored project",path:${JSON.stringify(join(data, "active"))}});
    const ids=[];
    for(let i=0;i<31;i++){
      const {session}=await window.api.claude.startSession({projectId:scope.id,title:"Page fixture "+i});
      ids.push(session.id);
    }
    const {session}=await window.api.claude.startSession({projectId:active.id,title:"Restored chat"});
    await window.api.session.saveMessages({sessionId:session.id,messages:[
      {id:"restore-user",sessionId:session.id,role:"user",content:[{kind:"text",text:"Existing profile"}],createdAt:1},
      {id:"restore-assistant",sessionId:session.id,role:"assistant",content:{blocks:[{kind:"text",text:"Restored history is intact."}]},createdAt:2}
    ]});
    await window.api.setting.set({key:"ui.streamScope",value:scope.id});
    await window.api.setting.set({key:"ui.lastProjectId",value:active.id});
    await window.api.setting.set({key:"ui.lastSessionId",value:session.id});
    return {scope:scope.id,active:active.id,session:session.id,ids};
  })()`);
  // Leave the restored chat beyond the initial unfiltered page, exactly as
  // a real profile with many newer chats in another project does.
  const db = new DatabaseSync(join(data, "claude-gui.db"));
  db.prepare("UPDATE sessions SET updated_at=1 WHERE id=?").run(fixture.session);
  for (let i=0; i<fixture.ids.length; i++) {
    db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(100+i, fixture.ids[i]);
  }
  db.close();

  // Locate the real store export in the built app. This allows assertions on
  // its hydrated state and exercising normal navigation without depending
  // on a particular hashed chunk filename or adding a production debug API.
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
    await wait("!window.startupTestStore.getState().streamDirty");
    const state = await evaluate(`(()=>{const s=window.startupTestStore.getState();return {
      projects:s.projects.length,active:s.activeSessionId,scope:s.streamScope,
      rows:s.streamSessions.map(x=>x.projectId),loaded:s.streamSessions.length,total:s.streamTotal,
      ready:s.claudeInstalled!==null,composer:Boolean(document.querySelector('[contenteditable=true]'))
    };})()`);
    assert.equal(state.projects, 2, "Existing projects hydrate");
    assert.equal(state.active, fixture.session, "Last chat restores outside the sidebar filter");
    assert.equal(state.scope, fixture.scope);
    assert.ok(state.rows.every(id => id === fixture.scope), "Sidebar refreshes to the saved scope");
    assert.equal(state.loaded, 10, "Locating an out-of-scope chat does not fetch every page");
    assert.equal(state.total, 31);
    assert.ok(state.composer, "Chat pane mounts");
    await wait("window.startupTestStore.getState().claudeInstalled!==null");
  }

  // Normal automatic location still pages to and mounts an older chat.
  await evaluate(`window.startupTestStore.getState().openTab(${JSON.stringify(fixture.ids[0])})`);
  await wait(`(()=>{const s=window.startupTestStore.getState();return s.streamSessions.some(x=>x.id===${JSON.stringify(fixture.ids[0])}) && [...document.querySelectorAll('li')].some(n=>n.textContent.includes('Page fixture 0'));})()`).catch(async error => {
    console.log(await evaluate("(()=>{const s=window.startupTestStore.getState();return {active:s.activeSessionId,scope:s.streamScope,dirty:s.streamDirty,hasMore:s.streamHasMore,loaded:s.streamSessions.length,total:s.streamTotal,text:document.body.textContent.slice(0,220)};})()"));
    throw error;
  });
  assert.equal(await evaluate("window.startupTestStore.getState().streamSessions.length"), 31);

  // A no-progress page (failed/superseded request) must end the locator even
  // if the previous page still has hasMore=true. Assert responsiveness and
  // request count rather than duplicating the locator implementation.
  await evaluate(`(async()=>{
    const store=window.startupTestStore;await store.getState().openTab(${JSON.stringify(fixture.ids[30])});
    await store.getState().loadStreamSessions(true);
  })()`);
  await wait("window.startupTestStore.getState().streamSessions.length===10 && ![...document.querySelectorAll('li')].some(n=>n.textContent.includes('Page fixture 0'))");
  await evaluate(`(async()=>{
    const store=window.startupTestStore;
    window.realStartupLoadMore=store.getState().loadMoreStreamSessions;
    window.startupLoadMoreCalls=0;
    store.setState({loadMoreStreamSessions:async()=>{window.startupLoadMoreCalls++;}});
    await store.getState().openTab(${JSON.stringify(fixture.ids[0])});
  })()`);
  await delay(200);
  assert.equal(await evaluate("window.startupLoadMoreCalls"), 1, "No-progress paging ends after one attempt");
  await evaluate("window.startupTestStore.setState({loadMoreStreamSessions:window.realStartupLoadMore})");
  await evaluate(`window.startupTestStore.getState().setStreamScope(${JSON.stringify(fixture.active)})`);
  await wait(`(()=>{const s=window.startupTestStore.getState();return !s.streamDirty && s.streamSessions.length===1 && s.streamSessions[0].id===${JSON.stringify(fixture.session)};})()`);
  await evaluate(`window.startupTestStore.getState().openTab(${JSON.stringify(fixture.session)})`);
  await wait("document.body.textContent.includes('Restored history is intact.')");
  assert.equal((await evaluate(`window.api.session.messages({sessionId:${JSON.stringify(fixture.session)}})`)).messages.length, 2);
  assert.deepEqual(errors, [], "No renderer exceptions");
  const screenshot = await command("Page.captureScreenshot", { format: "png" });
  await writeFile(join(data, "startup-recovered.png"), Buffer.from(screenshot.data, "base64"));
});
