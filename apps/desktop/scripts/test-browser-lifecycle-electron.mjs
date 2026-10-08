import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { electronTest, desktop, delay } from "./electron-test-helper.mjs";

await electronTest("browser-lifecycle", async data => {
  const db = new DatabaseSync(join(data,"claude-gui.db"));
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  for (const [key,value] of Object.entries({"mobile.enabled":"0","ui.titleGenEnabled":"0","network.proxy":JSON.stringify({mode:"direct",customUrl:""})})) {
    db.prepare("INSERT INTO settings VALUES (?,?)").run(key,value);
  }
  db.close();
  await mkdir(join(data,"work"));
  await writeFile(join(data,"work/browser.html"), '<html><body style="background:#c9f8d4"><h1>Browser lifecycle fixture</h1><input id="entry"></body></html>');
}, async ({data,evaluate,mainEvaluate,wait,command,errors}) => {
  const {project} = await evaluate(`window.api.project.create({name:"Browser fixture",path:${JSON.stringify(join(data,"work"))}})`);
  for (const name of await readdir(join(desktop,"out/renderer/assets"))) {
    if (!name.endsWith(".js")) continue;
    const source = await readFile(join(desktop,"out/renderer/assets",name),"utf8");
    const match = source.match(/\buseSessionStore as (\w+)/);
    if (match) {
      await evaluate(`import(${JSON.stringify(pathToFileURL(join(desktop,"out/renderer/assets",name)).href)}).then(m=>{window.browserTestStore=m[${JSON.stringify(match[1])}];})`);
      break;
    }
  }
  assert.ok(await evaluate("Boolean(window.browserTestStore)"));
  await evaluate(`window.browserTestStore.setState({projects:[${JSON.stringify(project)}]});window.browserTestStore.getState().selectProject(${JSON.stringify(project.id)})`);
  await command("Page.bringToFront");
  await command("Emulation.setFocusEmulationEnabled",{enabled:true});
  const fixtureUrl = pathToFileURL(join(data,"work/browser.html")).href;
  await evaluate(`window.browserTestStore.setState({rightOpen:true,rightPanelTab:"browser",pendingBrowserUrl:${JSON.stringify(fixtureUrl)}})`);
  await wait("window.browserTestStore.getState().browserTabs.length===1");
  await mainEvaluate("globalThis.browserTestElectron=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');true");
  const views = () => mainEvaluate(`(()=>{const m=globalThis.browserTestElectron;return m.BrowserWindow.getAllWindows().flatMap(w=>w.contentView.children.filter(v=>v instanceof m.WebContentsView).map(v=>({bounds:v.getBounds(),url:v.webContents.getURL()})));})()`);
  const nativePage = `(()=>{const m=globalThis.browserTestElectron;return m.BrowserWindow.getAllWindows().flatMap(w=>w.contentView.children).find(v=>v instanceof m.WebContentsView&&v.webContents.getURL()===${JSON.stringify(fixtureUrl)})?.webContents;})()`;
  const readyUntil = Date.now()+6000;
  while (!await mainEvaluate(`(async()=>{const wc=${nativePage};return wc?wc.mainFrame.executeJavaScript("document.body?.textContent.includes('Browser lifecycle fixture')").catch(()=>false):false})()`)) {
    assert.ok(Date.now()<readyUntil,"Native page did not load its fixture content"); await delay(50);
  }
  async function assertVisible() {
    const until = Date.now()+6000;
    while (true) {
      const native = (await views()).filter(v=>v.url===fixtureUrl && v.bounds.x>=0);
      const stage = await evaluate("(()=>{const e=[...document.querySelectorAll('div.relative.min-h-0.flex-1.overflow-auto.bg-white')].find(e=>e.getBoundingClientRect().width>0);if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})()");
      if (native.length===1 && stage && Object.entries(stage).every(([k,n])=>Math.abs(native[0].bounds[k]-n)<=1)) return;
      assert.ok(Date.now()<until, `Native browser did not match the current stage: ${JSON.stringify({native,stage})}`);
      await delay(50);
    }
  }
  async function assertHidden() {
    await delay(150);
    assert.ok((await views()).every(v=>v.bounds.x<0), "Hidden browser cannot cover another panel");
  }
  await assertVisible();
  // Container swaps use the same native view; an old unmount cannot hide the new owner.
  for (let i=0;i<4;i++) {
    await evaluate("window.browserTestStore.getState().setBrowserPanelOpen(true)");
    await assertVisible();
    await evaluate("window.browserTestStore.setState({browserPanelOpen:false,rightOpen:true,rightPanelTab:'browser'})");
    await assertVisible();
    await evaluate("window.browserTestStore.getState().setRightPanelTab('files')");
    await assertHidden();
    await evaluate("window.browserTestStore.getState().setRightPanelTab('browser')");
    await assertVisible();
  }
  for (const key of ["settingsOpen","canvasOpen","rightOpen"]) {
    const hideValue = key !== "rightOpen";
    await evaluate(`window.browserTestStore.setState({${key}:${hideValue}})`);
    await assertHidden();
    await evaluate(`window.browserTestStore.setState({${key}:${!hideValue}})`);
    await assertVisible();
  }
  // Queue a show on an unmeasurable stage, then leave before its retries end.
  await evaluate("(()=>{const e=document.createElement('style');e.id='zero-browser-fixture';e.textContent='div.relative.min-h-0.flex-1.overflow-auto.bg-white{display:none!important}';document.head.append(e);window.browserTestStore.getState().setBrowserPanelOpen(true)})()");
  await delay(100);
  await evaluate("window.browserTestStore.getState().setSettingsOpen(true)");
  await delay(1300);
  await assertHidden();
  await evaluate("document.getElementById('zero-browser-fixture').remove();window.browserTestStore.getState().setSettingsOpen(false)");
  await assertVisible();
  // Close a toolbar menu before its native capture completes.
  await mainEvaluate(`(()=>{const m=globalThis.browserTestElectron;const v=m.BrowserWindow.getAllWindows().flatMap(w=>w.contentView.children).find(v=>v instanceof m.WebContentsView&&v.webContents.getURL()===${JSON.stringify(fixtureUrl)});globalThis.browserTestCaptureStarted=false;globalThis.browserTestOriginalCapture=v.webContents.capturePage.bind(v.webContents);globalThis.browserTestCaptureView=v;v.webContents.capturePage=async(...args)=>{const image=await globalThis.browserTestOriginalCapture(...args);globalThis.browserTestCaptureStarted=true;await new Promise(r=>{globalThis.browserTestReleaseCapture=r});return image};return true;})()`);
  const point = await evaluate("(()=>{const e=[...document.querySelectorAll('button:has(.tabler-icon-dots)')].find(e=>e.getBoundingClientRect().width>0);const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
  await command("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",clickCount:1,...point});
  await command("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",clickCount:1,...point});
  const until=Date.now()+6000;
  while (!await mainEvaluate("globalThis.browserTestCaptureStarted")) { assert.ok(Date.now()<until,"Menu did not start capture"); await delay(50); }
  await command("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
  await command("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});
  await delay(100);
  await mainEvaluate("globalThis.browserTestReleaseCapture();globalThis.browserTestCaptureView.webContents.capturePage=globalThis.browserTestOriginalCapture;true");
  await delay(300);
  await assertVisible();
  await evaluate("window.browserTestStore.setState({browserPanelOpen:false,rightOpen:true,rightPanelTab:'browser'})");
  await assertVisible();
  assert.equal(await mainEvaluate(`${nativePage}.mainFrame.executeJavaScript("document.body.textContent.includes('Browser lifecycle fixture')")`),true,"Container changes preserve the loaded page");
  const nativeShot = await mainEvaluate(`${nativePage}.capturePage().then(i=>i.toPNG().toString('base64'))`);
  assert.ok(nativeShot.length>0,"Native page still paints after menu close and container changes");
  await writeFile(join(data,"browser-page.png"),Buffer.from(nativeShot,"base64"));
  const shot = await mainEvaluate("globalThis.browserTestElectron.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('file:')).capturePage().then(i=>i.toPNG().toString('base64'))");
  await writeFile(join(data,"browser-sidebar.png"),Buffer.from(shot,"base64"));
  assert.equal(errors.length,0,"No renderer exceptions while changing browser containers");
}, {mainInspector:true});
