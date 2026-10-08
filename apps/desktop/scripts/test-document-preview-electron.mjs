import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile, writeFile, mkdir, symlink, open } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { electronTest, desktop, delay } from "./electron-test-helper.mjs";
import { documentFixtures, fixturePdf } from "./document-preview-fixtures.mjs";

await electronTest("document-preview", async data=>{
  const db=new DatabaseSync(join(data,"claude-gui.db"));db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  for(const [key,value] of Object.entries({"mobile.enabled":"0","ui.titleGenEnabled":"0","network.proxy":JSON.stringify({mode:"direct",customUrl:""})})) db.prepare("INSERT INTO settings VALUES (?,?)").run(key,value);
  db.close(); await documentFixtures(join(data,"work"));
  await mkdir(join(data,"outside"));await writeFile(join(data,"outside/private.pdf"),fixturePdf());
  await symlink(join(data,"outside"),join(data,"work/escaped"),process.platform==="win32"?"junction":"dir");
  const large=await open(join(data,"work/large.pdf"),"w"); await large.truncate(33*1024*1024);await large.close();
}, async({data,evaluate,wait,command,errors})=>{
  const {project}=await evaluate(`window.api.project.create({name:"Document fixture",path:${JSON.stringify(join(data,"work"))}})`);
  for(const file of await readdir(join(desktop,"out/renderer/assets"))) {
    if(!file.endsWith(".js"))continue;
    const source=await readFile(join(desktop,"out/renderer/assets",file),"utf8"),match=source.match(/\buseSessionStore as (\w+)/);
    if(match){await evaluate(`import(${JSON.stringify(pathToFileURL(join(desktop,"out/renderer/assets",file)).href)}).then(m=>{window.documentTestStore=m[${JSON.stringify(match[1])}];})`);break;}
  }
  await evaluate(`window.documentTestStore.setState({projects:[${JSON.stringify(project)}],displayMode:'tabs',ideEditorMode:'tabs'});window.documentTestStore.getState().selectProject(${JSON.stringify(project.id)})`);
  await command("Page.bringToFront");
  const openFile=async name=>{await evaluate(`window.documentTestStore.getState().openFileInIde(${JSON.stringify(join(data,"work",name))})`);await wait(`Boolean(document.querySelector('[data-document-preview]'))`);};
  const next=()=>evaluate("document.querySelector('[data-document-preview] button[aria-label=\"下一页\"]').click()");
  const shot=async name=>{const png=await command("Page.captureScreenshot",{format:"png",fromSurface:false});await writeFile(join(data,`${name}.png`),Buffer.from(png.data,"base64"));};
  await openFile("sample.pdf");
  await wait("document.querySelector('[data-pdf-text]')?.textContent.includes('PDF first page fixture')");
  assert.ok(await evaluate("document.querySelector('[data-pdf-page] canvas').width>100"),"PDF renders locally in a canvas");
  const width=await evaluate("document.querySelector('[data-pdf-page] canvas').width");
  await evaluate("document.querySelector('button[aria-label=\"放大\"]').click()");
  await wait(`document.querySelector('[data-pdf-page] canvas').width>${width}`);
  await next();await wait("document.querySelector('[data-pdf-text]')?.textContent.includes('PDF second page fixture')");
  await shot("pdf");
  await openFile("sample.docx");await wait("document.querySelector('.document-reading')?.textContent.includes('中文 Word 阅读测试')");
  assert.ok(await evaluate("document.querySelector('.document-reading table').textContent.includes('表格内容')"));
  await wait("document.querySelector('.document-reading img')?.naturalWidth>0");
  assert.equal(await evaluate("Boolean(document.querySelector('.document-reading a[href^=javascript]')||window.docPreviewUnsafe)"),false,"Document links cannot execute code");
  await shot("word");
  for(const extension of ["xlsx","xls"]) {
    await openFile(`sample.${extension}`);await wait("document.querySelector('.document-sheet')?.textContent.includes('中文工作表')");
    assert.ok(await evaluate("document.querySelector('.document-sheet').textContent.includes('42.00')"),"Cached formulas retain their formatted value");
    await evaluate("document.querySelector('button[aria-label=\"下一组列\"]').click()");
    await wait("document.querySelector('.document-sheet')?.textContent.includes('后续列内容')");
    await evaluate("document.querySelector('button[aria-label=\"上一组列\"]').click()");
    await wait("document.querySelector('.document-sheet')?.textContent.includes('中文工作表')");
    await next();await wait("document.querySelector('.document-sheet')?.textContent.includes('Row 205')");
    await evaluate("(()=>{const select=document.querySelector('select[aria-label=\"工作表\"]');select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await wait("document.querySelector('.document-sheet')?.textContent.includes('第二表内容')");
  }
  await shot("excel");
  await openFile("sample.pptx");
  try { await wait("document.querySelector('[data-slide-content]')?.textContent.includes('第一张中文幻灯片')"); }
  catch (error) { await shot("powerpoint-failure"); console.log(await evaluate("document.querySelector('[data-document-preview]')?.innerHTML")); throw error; }
  assert.ok(await evaluate("document.querySelector('[data-slide-content] table').textContent.includes('幻灯片表格')"));
  await wait("document.querySelector('[data-slide-content] img')?.naturalWidth>0");
  await next();await wait("document.querySelector('[data-slide-content]')?.textContent.includes('第二张幻灯片')");
  await shot("powerpoint");
  // A late background parse from the outgoing file cannot replace the new file.
  await openFile("sample.docx");await wait("document.querySelector('[data-document-preview]')?.dataset.documentPreview==='.docx'");
  await evaluate(`(()=>{const s=window.documentTestStore.getState();s.openFileInIde(${JSON.stringify(join(data,"work/sample.docx"))});s.openFileInIde(${JSON.stringify(join(data,"work/sample.xlsx"))});s.openFileInIde(${JSON.stringify(join(data,"work/sample.pptx"))});})()`);
  await wait("document.querySelector('[data-slide-content]')?.textContent.includes('第一张中文幻灯片')");
  await openFile("sample.pdf");await wait("document.querySelector('[data-pdf-text]')?.textContent.includes('PDF first page fixture')");
  await evaluate("[...document.querySelectorAll('[data-document-preview] button')].find(button=>button.textContent==='刷新').click()");
  await wait("document.querySelector('[data-pdf-text]')?.textContent.includes('PDF first page fixture')");
  await openFile("broken.pptx");await wait("document.querySelector('[data-document-preview] [role=alert]')?.textContent.includes('无法预览')");
  for(const [path,code] of [["outside/private.pdf","outside"],["work/escaped/private.pdf","outside"],["work/large.pdf","large"],["work/missing.pdf","read"]]) {
    assert.deepEqual(await evaluate(`window.api.file.readDocument({filePath:${JSON.stringify(join(data,path))}})`),{ok:false,code});
  }
  await openFile("sample.docx");await wait("document.querySelector('.document-reading')?.textContent.includes('中文 Word 阅读测试')");
  await evaluate("window.documentTestStore.getState().setLocale('en')");await wait("document.querySelector('[data-document-preview]').textContent.includes('Read-only preview')");
  await delay(100);assert.equal(errors.length,0,"No renderer exceptions");
});
