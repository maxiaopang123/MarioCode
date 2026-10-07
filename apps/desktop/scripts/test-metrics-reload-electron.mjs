import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { electronTest } from "./electron-test-helper.mjs";
await electronTest("todo023-reload",async data=>{
  const db=new DatabaseSync(join(data,"claude-gui.db"));
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  db.prepare("INSERT INTO settings VALUES (?,?)").run("mobile.enabled","0"); db.close();
  await mkdir(join(data,"work"));
},async ({data,evaluate,wait,command})=>{
  const endedAt=Date.now()-1000;
  const id=await evaluate(`(async()=>{
    const {project}=await window.api.project.create({name:"metric-test",path:${JSON.stringify(join(data,"work"))}});
    const {session}=await window.api.claude.startSession({projectId:project.id,title:"metric-reload"});
    await window.api.session.saveMessages({sessionId:session.id,messages:[
      {id:"metric-user",sessionId:session.id,role:"user",content:[{kind:"text",text:"test"}],createdAt:${endedAt-2000}},
      {id:"metric-assistant",sessionId:session.id,role:"assistant",content:{blocks:[{kind:"text",text:"Timing survives reopening"}],turnMeta:{startedAt:${endedAt-1500},endedAt:${endedAt},generationMs:1000,firstTokenMs:500,model:"fixture"}},createdAt:${endedAt-1500}}
    ]});
    await window.api.setting.set({key:"ui.lastProjectId",value:project.id});
    await window.api.setting.set({key:"ui.lastSessionId",value:session.id}); return session.id;
  })()`);
  const db=new DatabaseSync(join(data,"claude-gui.db"));
  db.prepare("UPDATE sessions SET usage_history=? WHERE id=?").run(JSON.stringify([{endedAt,durationMs:1500,generationMs:1000,firstTokenMs:500,totalProcessedTokens:120,outputTokens:20,cacheReadTokens:80,cacheCreationTokens:0,cacheUsageKnown:true,usedTokens:100}]),id); db.close();
  for(let i=0;i<2;i++) {
    await command("Page.reload");
    await wait("Boolean(window.api && document.querySelector('button .tabler-icon-settings'))");
    await evaluate("[...document.querySelectorAll('li')].find(n=>n.textContent.includes('metric-reload'))?.click()");
    await wait("document.body.textContent.includes('Timing survives reopening')");
    await wait("Boolean(document.querySelector('.sess-metrics-chips'))");
    assert.ok(await evaluate("document.querySelector('.sess-metrics-chips').textContent.includes('20')"),"reopened speed comes from disk");
    assert.ok(await evaluate("document.querySelector('.sess-metrics-chips').textContent.includes('80%')"));
    assert.ok(await evaluate("[...document.querySelectorAll('[title]')].some(n=>n.title.includes('首字延迟 0.5'))"),"first token tooltip survives reload");
  }
});
