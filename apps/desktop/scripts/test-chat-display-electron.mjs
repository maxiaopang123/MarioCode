import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { electronTest, desktop, delay } from "./electron-test-helper.mjs";
const png = await readFile(join(desktop,"build/icon.png"));
let hits = 0;
const server = createServer((req,res) => { hits++; res.writeHead(200,{"content-type":"image/png"}); res.end(png); });
await new Promise(r => server.listen(0,"127.0.0.1",r));
const url = `http://127.0.0.1:${server.address().port}/image.png`;
try {
  await electronTest("todo022-validation",async data => {
    const db = new DatabaseSync(join(data,"claude-gui.db"));
    db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    for (const [key,value] of Object.entries({"mobile.enabled":"0","network.proxy":JSON.stringify({mode:"direct",customUrl:""}),"ui.titleGenEnabled":"0"})) db.prepare("INSERT INTO settings VALUES (?,?)").run(key,value);
    db.close();
    await mkdir(join(data,"work")); await writeFile(join(data,"work","hero.png"),png);
    await writeFile(join(data,"work","broken.png"),"invalid image bytes");
    await writeFile(join(data,"work","readme.md"),"# test");
  },async ({data,evaluate,wait,command}) => {
    const image = join(data,"work","hero.png").replace(/\\/g,"/");
    const broken = join(data,"work","broken.png").replace(/\\/g,"/");
    const reply = `图片：\n\n![hero](${image})\n\n![broken](${broken})\n\n![remote](${url})\n\n路径：src/readme.md 与 \`readme.md\`。`;
    const sessionId = await evaluate(`(async()=>{
      const {project}=await window.api.project.create({name:"display-test",path:${JSON.stringify(join(data,"work"))}});
      const {session}=await window.api.claude.startSession({projectId:project.id,title:"display-check"});
      const now=Date.now();
      await window.api.session.saveMessages({sessionId:session.id,messages:[
        {id:"display-user",sessionId:session.id,role:"user",content:[{kind:"text",text:"test"}],createdAt:now-1000},
        {id:"display-assistant",sessionId:session.id,role:"assistant",content:{blocks:[
          {kind:"tool_use",toolCallId:"image-call",toolName:"mario_image_generate",input:{prompt:"test"},status:"done",result:"已保存到: "+${JSON.stringify(image)}},
          {kind:"image",toolCallId:"image-call",data:${JSON.stringify(png.toString("base64"))},mimeType:"image/png"},
          {kind:"tool_use",toolCallId:"broken-call",toolName:"mario_image_generate",input:{prompt:"test"},status:"done",result:"已保存到: "+${JSON.stringify(broken)}},
          {kind:"image",toolCallId:"broken-call",data:${JSON.stringify(png.toString("base64"))},mimeType:"image/png"},
          {kind:"text",text:${JSON.stringify(reply)}}
        ],turnMeta:{startedAt:now-900,endedAt:now-100,model:"test"}},createdAt:now-900}
      ]});
      await window.api.setting.set({key:"ui.lastProjectId",value:project.id});
      await window.api.setting.set({key:"ui.lastSessionId",value:session.id});
      return session.id;
    })()`);
    const reopen = async () => {
      await command("Page.reload"); await wait("Boolean(window.api && document.querySelector('button .tabler-icon-settings'))");
      await evaluate(`(()=>{const n=[...document.querySelectorAll('[role=button]')].find(n=>n.textContent.includes('display-check'));n?.click()})()`);
      await wait("Boolean(document.querySelector('.md-figure-img'))");
      await evaluate("document.querySelector('.chat-ledger[data-open=false] .chat-ledger-head')?.click()");
    };
    await reopen(); await delay(250);
    assert.equal(hits,0,"default click-load does not contact the image host");
    await wait("document.body.textContent.includes('图片已在回复中显示')");
    assert.equal(await evaluate("[...document.querySelectorAll('summary')].filter(s=>s.textContent.includes('图片已在回复中显示')).length"),1,"failed prose image leaves the other tool preview visible");
    assert.ok(await evaluate("document.querySelectorAll('.fchip').length>=2"));
    await evaluate(`window.api.setting.set({key:"ui.chatDisplay",value:JSON.stringify({remoteImages:"trusted",trustedDomains:["other.example"],prosePaths:false})})`);
    await reopen(); await delay(250); assert.equal(hits,0,"untrusted host stays manual");
    assert.equal(await evaluate("document.querySelectorAll('.fchip').length"),1,"prose toggle preserves inline-code path chip");
    await evaluate(`window.api.setting.set({key:"ui.chatDisplay",value:JSON.stringify({remoteImages:"trusted",trustedDomains:["127.0.0.1"],prosePaths:true})})`);
    await reopen(); await wait("document.querySelectorAll('.md-figure-img, .md-figure-lone img').length>=2");
    assert.ok(hits>0,"exact trusted hostname auto-loads");
    await evaluate("document.querySelector('button .tabler-icon-settings').closest('button').click()");
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='外观')");
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='外观').click()");
    await wait("Boolean(document.querySelector('#setting-remote-images'))");
    assert.equal(await evaluate("document.querySelector('#setting-remote-images').value"),"trusted");
    await evaluate("(()=>{const s=document.querySelector('#setting-remote-images');s.value='always';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await wait("window.api.setting.get({key:'ui.chatDisplay'}).then(({value})=>value && JSON.parse(value).remoteImages==='always')");
    await reopen();
    await wait("document.querySelectorAll('.md-figure-img, .md-figure-lone img').length>=2");
    const history=await evaluate(`window.api.session.messages({sessionId:${JSON.stringify(sessionId)}})`);
    assert.ok(history.messages.length>=2,"preferences leave history unchanged");
    const screenshot=await command("Page.captureScreenshot",{format:"png"}).catch(()=>null);
    if(screenshot)await writeFile(join(data,"display.png"),Buffer.from(screenshot.data,"base64"));
  });
} finally { await new Promise(r=>server.close(r)); }
