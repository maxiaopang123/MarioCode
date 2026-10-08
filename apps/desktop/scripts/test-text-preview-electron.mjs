import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { electronTest, desktop, delay } from "./electron-test-helper.mjs";

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="style.css?v=1"></head><body>
<h1>中文 HTML 预览</h1><p>样式、图片和页面交互</p><img src="中文%20图.png" width="80" height="80"><button id="counter">0</button>
<script>document.body.dataset.inline='yes';localStorage.setItem('fixture','stored');document.body.dataset.storage=localStorage.getItem('fixture');document.body.dataset.api=String(Boolean(window.api));document.body.dataset.node=typeof require;try{parent.document.body.dataset.previewEscaped='yes'}catch{document.body.dataset.parent='blocked'}</script>
<script src="page.js"></script><script type="module" src="module.mjs"></script></body></html>`;
const markdown = "# 中文 Markdown 预览\n\n| 名称 | 内容 |\n| --- | --- |\n| 表格 | 正常 |\n\n![本地图片](中文%20图.png)\n\n```ts\nconst value = 42;\n```\n";
await electronTest("text-preview", async data => {
  const db = new DatabaseSync(join(data,"claude-gui.db")); db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  for(const [key,value] of Object.entries({"mobile.enabled":"0","ui.titleGenEnabled":"0","network.proxy":JSON.stringify({mode:"direct",customUrl:""})})) db.prepare("INSERT INTO settings VALUES (?,?)").run(key,value);
  db.close(); await mkdir(join(data,"work")); await mkdir(join(data,"outside"));
  for(const [name, content] of Object.entries({"sample.html":html,"sample.htm":html,"readme.md":markdown,"readme.markdown":markdown,
    "style.css":"body{font-family:sans-serif;padding:24px}h1{color:rgb(12,34,56)}button{padding:12px;border-radius:8px}img{display:block;margin:20px 0}",
    "page.js":"document.body.dataset.external='yes';document.querySelector('#counter').onclick=e=>e.target.textContent=String(Number(e.target.textContent)+1)",
    "module.mjs":"import {label} from './lib.mjs'; document.body.dataset.module=label;fetch('./data.json').then(r=>r.json()).then(d=>document.body.dataset.json=d.value)",
    "lib.mjs":"export const label='module-loaded'", "data.json":'{"value":"json-loaded"}',".env":"PRIVATE=hidden",
    "large.html":"x".repeat(2*1024*1024+1),"missing.md":"placeholder"})) await writeFile(join(data,"work",name),content);
  await writeFile(join(data,"work/中文 图.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=","base64"));
  await writeFile(join(data,"outside/private.html"),html);
  await symlink(join(data,"outside"),join(data,"work/escaped"),process.platform==="win32"?"junction":"dir");
  await mkdir(join(data,"work/.private"));await writeFile(join(data,"work/.private/secret.json"),'{"secret":"hidden"}');
  await symlink(join(data,"work/.private"),join(data,"work/linked-secret"),process.platform==="win32"?"junction":"dir");
}, async ({data,evaluate,wait,command,errors,mainEvaluate}) => {
  const {project}=await evaluate(`window.api.project.create({name:'Text fixture',path:${JSON.stringify(join(data,"work"))}})`);
  for(const file of await readdir(join(desktop,"out/renderer/assets"))) {
    if(!file.endsWith('.js'))continue;
    const source=await readFile(join(desktop,"out/renderer/assets",file),'utf8');
    for(const [name,global] of [['useSessionStore','previewStore'],['getModelEntry','previewModel']]) {
      const match=source.match(new RegExp(`\\b${name} as (\\w+)`));
      if(match) await evaluate(`import(${JSON.stringify(pathToFileURL(join(desktop,"out/renderer/assets",file)).href)}).then(m=>window[${JSON.stringify(global)}]=m[${JSON.stringify(match[1])}])`);
    }
  }
  await evaluate(`window.previewStore.setState({projects:[${JSON.stringify(project)}],displayMode:'tabs',ideEditorMode:'tabs'});window.previewStore.getState().selectProject(${JSON.stringify(project.id)})`);
  await mainEvaluate("globalThis.previewElectron=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')('electron');true");
  const wc="globalThis.previewElectron.BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/index.html')).webContents";
  const frameEval = async expression => {
    const url=await evaluate("document.querySelector('[data-html-preview] iframe')?.src??null");
    if(!url)return null;
    return mainEvaluate(`(async()=>{const frame=${wc}.mainFrame.frames.find(f=>f.url===${JSON.stringify(url)});return frame?Promise.race([frame.executeJavaScript(${JSON.stringify(expression)}).catch(()=>null),new Promise(resolve=>setTimeout(()=>resolve(null),1000))]):null})()`);
  };
  const frameWait = async expression => {const deadline=Date.now()+20000;while(!await frameEval(expression)){assert.ok(Date.now()<deadline,expression);await delay(100);}};
  const filePath=name=>join(data,"work",name);
  const openFile=name=>evaluate(`window.previewStore.getState().openFileInIde(${JSON.stringify(filePath(name))})`);
  const clickTitle=title=>evaluate(`[...document.querySelectorAll('button[title]')].find(button=>button.title===${JSON.stringify(title)}).click()`);
  const shot=async name=>{const result=await command('Page.captureScreenshot',{format:'png',fromSurface:false});await writeFile(join(data,name+'.png'),Buffer.from(result.data,'base64'));};
  const status=url=>mainEvaluate(`globalThis.previewElectron.net.fetch(${JSON.stringify(url)}).then(r=>r.status)`);

  // Enter from the actual tree click, without a context menu or browser tab.
  await evaluate("(()=>{const button=document.querySelector('nav[aria-label=工具] button:has(.tabler-icon-folder)');if(button.getAttribute('aria-pressed')!=='true')button.click()})()");
  await wait("[...document.querySelectorAll('button[title]')].some(button=>button.title.endsWith('sample.html'))");
  await evaluate("[...document.querySelectorAll('button[title]')].find(button=>button.title.endsWith('sample.html')).click()");
  await wait("Boolean(document.querySelector('[data-html-preview] iframe'))");
  await frameWait("document.body.dataset.module==='module-loaded'&&document.body.dataset.json==='json-loaded'");
  const inspection=await frameEval("({text:document.querySelector('h1').textContent,color:getComputedStyle(document.querySelector('h1')).color,image:document.querySelector('img').naturalWidth,inline:document.body.dataset.inline,external:document.body.dataset.external,api:document.body.dataset.api,node:document.body.dataset.node,parent:document.body.dataset.parent})");
  assert.deepEqual(inspection,{text:'中文 HTML 预览',color:'rgb(12, 34, 56)',image:1,inline:'yes',external:'yes',api:'false',node:'undefined',parent:'blocked'});
  assert.equal(await frameEval("document.body.dataset.storage"),'stored','Independent preview storage works');
  assert.equal(await evaluate("Boolean(document.body.dataset.previewEscaped)"),false);
  await frameEval("document.querySelector('#counter').click();true");assert.equal(await frameEval("document.querySelector('#counter').textContent"),'1');
  const firstUrl=await evaluate("document.querySelector('[data-html-preview] iframe').src");
  assert.equal(await status(new URL('.env',firstUrl).href),403);
  assert.equal(await status(new URL('escaped/private.html',firstUrl).href),403);
  assert.equal(await status(new URL('readme.md',firstUrl).href),403);
  assert.equal(await status(new URL('linked-secret/secret.json',firstUrl).href),403);
  await shot('html');

  // Toggle through a real cached editor model: preview, undo, redo and save.
  const roundtrip=async(name,original,changed,selector)=>{
    await clickTitle('切换到源码编辑');
    await wait(`Boolean(document.querySelector('.monaco-editor')&&window.previewModel(${JSON.stringify(filePath(name))}))`);
    await evaluate(`(()=>{const model=window.previewModel(${JSON.stringify(filePath(name))}).model;window.previewOriginalModel=model;model.pushStackElement();model.pushEditOperations([],[{range:model.getFullModelRange(),text:${JSON.stringify(changed)}}],()=>null);model.pushStackElement();})()`);
    await clickTitle('切换到预览'); await wait(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    if(name.endsWith('html')) await frameWait("document.querySelector('h1')?.textContent.includes('未保存')");
    else await wait("document.querySelector('[data-markdown-preview]')?.textContent.includes('未保存')");
    assert.equal(await readFile(filePath(name),'utf8'),original,'Preview never writes the draft to disk');
    await clickTitle('切换到源码编辑');await wait("Boolean(document.querySelector('.monaco-editor'))");
    assert.equal(await evaluate(`window.previewModel(${JSON.stringify(filePath(name))}).model===window.previewOriginalModel`),true,'Preview preserves model identity');
    await evaluate("window.previewOriginalModel.undo()");assert.equal(await evaluate("window.previewOriginalModel.getValue()"),original,'Undo survives preview');
    await evaluate("window.previewOriginalModel.redo()");assert.equal(await evaluate("window.previewOriginalModel.getValue()"),changed);
    await evaluate("document.querySelector('.monaco-editor textarea').focus()");
    await command('Input.dispatchKeyEvent',{type:'keyDown',key:'s',code:'KeyS',windowsVirtualKeyCode:83,modifiers:2});
    await command('Input.dispatchKeyEvent',{type:'keyUp',key:'s',code:'KeyS',windowsVirtualKeyCode:83,modifiers:2});
    const deadline=Date.now()+10000;while(await readFile(filePath(name),'utf8')!==changed){assert.ok(Date.now()<deadline,'Editor save');await delay(100);}
    await clickTitle('切换到预览');
    await wait(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    assert.equal(await evaluate("document.body.textContent.includes('正在预览未保存的内容')"),false,'Saved preview is no longer marked dirty');
  };
  await roundtrip('sample.html',html,html.replace('中文 HTML 预览','未保存 HTML 内容'),'[data-html-preview] iframe');
  assert.equal(await status(firstUrl),410,'Outgoing preview capabilities are revoked');
  await openFile('readme.md');await wait("document.querySelector('[data-markdown-preview]')?.textContent.includes('中文 Markdown 预览')");
  await wait("document.querySelector('[data-markdown-preview] img')?.naturalWidth===1");await shot('markdown');
  await roundtrip('readme.md',markdown,markdown.replace('中文 Markdown 预览','未保存 Markdown 内容'),'[data-markdown-preview]');
  console.log('PASS: HTML and Markdown draft / undo / save');
  for(const name of ['sample.htm','readme.markdown']) {await openFile(name);await wait(`Boolean(document.querySelector(${JSON.stringify(name.endsWith('htm')?'[data-html-preview] iframe':'[data-markdown-preview]')}))`);}
  await openFile('sample.html');await frameWait("document.querySelector('h1')?.textContent.includes('未保存 HTML')");
  await writeFile(filePath('sample.html'),html.replace('中文 HTML 预览','磁盘已更新'));
  await evaluate("[...document.querySelectorAll('[data-html-preview] button')].find(button=>button.textContent==='刷新').click()");
  await frameWait("document.querySelector('h1')?.textContent==='磁盘已更新'");
  console.log('PASS: external file refresh');
  await evaluate(`window.previewStore.getState().openFileInIde(${JSON.stringify(filePath('sample.html'))},{line:1})`);
  await wait("Boolean(document.querySelector('.monaco-editor'))");
  assert.equal(await evaluate("Boolean(document.querySelector('[data-html-preview] iframe'))"),false,'Line reveals force source editing');
  assert.equal(await evaluate(`window.previewModel(${JSON.stringify(filePath('sample.html'))}).model.getValue().includes('磁盘已更新')`),true,'Clean editor reloads external changes');
  await evaluate(`window.previewStore.getState().openFileInIde(${JSON.stringify(filePath('sample.html'))},{diff:true,before:${JSON.stringify(html)}})`);
  await wait("Boolean(document.querySelector('.monaco-diff-editor'))");
  await openFile('large.html');await wait("document.querySelector('[data-html-preview] [role=alert]')?.textContent.includes('2 MB')");
  for(const path of [join(data,'outside/private.html'),filePath('escaped/private.html')]) assert.deepEqual(await evaluate(`window.api.file.htmlPreview({filePath:${JSON.stringify(path)}})`),{ok:false,code:'outside'});
  await openFile('not-found.md');await wait("document.querySelector('[role=alert]')?.textContent.includes('无法读取文件')");
  await openFile('sample.htm');await wait("Boolean(document.querySelector('[data-html-preview] iframe'))");
  const oldUrl=await evaluate("document.querySelector('[data-html-preview] iframe').src");
  await openFile('readme.markdown');await wait("Boolean(document.querySelector('[data-markdown-preview]'))");
  await delay(150);assert.equal(await status(oldUrl),410);
  // Startup restores open tabs without going through openFileInIde.
  await evaluate(`window.previewStore.setState({ideFileViewModeByProject:{},ideActiveFileByProject:{[${JSON.stringify(project.id)}]:${JSON.stringify(filePath('sample.htm'))}}})`);
  await wait("Boolean(document.querySelector('[data-html-preview] iframe'))");
  await frameWait("document.querySelector('h1')?.textContent==='中文 HTML 预览'");
  await evaluate(`window.previewStore.setState({ideActiveFileByProject:{[${JSON.stringify(project.id)}]:${JSON.stringify(filePath('readme.markdown'))}}})`);
  await wait("Boolean(document.querySelector('[data-markdown-preview]'))");
  await evaluate("window.previewStore.getState().setLocale('en')");await wait("[...document.querySelectorAll('button[title]')].some(button=>button.textContent==='Edit')");
  assert.deepEqual(errors,[],'No uncaught renderer errors');
}, {mainInspector:true});
