import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { electronTest, delay } from "./electron-test-helper.mjs";

await electronTest("session-overview", async data => {
  const db = new DatabaseSync(join(data, "claude-gui.db"));
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  for (const [key, value] of Object.entries({
    "mobile.enabled": "0", "ui.titleGenEnabled": "0", "network.proxy": JSON.stringify({ mode: "direct", customUrl: "" }),
  })) db.prepare("INSERT INTO settings VALUES (?,?)").run(key, value);
  db.close();
  await mkdir(join(data, "work"));
}, async ({ data, evaluate, wait, command, errors }) => {
  const now = Date.now();
  const sessionId = await evaluate(`(async()=>{
    const {project}=await window.api.project.create({name:"Overview fixture",path:${JSON.stringify(join(data, "work"))}});
    const {session}=await window.api.claude.startSession({projectId:project.id,title:"Overview fixture"});
    await window.api.session.saveMessages({sessionId:session.id,messages:[
      {id:"overview-u1",sessionId:session.id,role:"user",content:[{kind:"text",text:"First navigation target"}],createdAt:${now - 5000}},
      {id:"overview-a1",sessionId:session.id,role:"assistant",content:{blocks:[
        {kind:"tool_use",toolCallId:"overview-read",toolName:"Read",input:{file_path:"sample.ts"},status:"done",result:"fixture"},
        {kind:"text",text:"Saved bookmark target"}
      ],turnMeta:{startedAt:${now - 4800},endedAt:${now - 4000},model:"fixture-model"}},createdAt:${now - 4800}},
      {id:"overview-u2",sessionId:session.id,role:"user",content:[{kind:"text",text:"Second navigation target"}],createdAt:${now - 3000}},
      {id:"overview-a2",sessionId:session.id,role:"assistant",content:{blocks:[{kind:"text",text:"Overview restored"}],turnMeta:{startedAt:${now - 2800},endedAt:${now - 2000},model:"fixture-model"}},createdAt:${now - 2800}}
    ]});
    await window.api.session.updateBookmarks({id:session.id,bookmarks:[{id:"overview-bm",messageId:"overview-a1",excerpt:"Saved bookmark target",title:"Kept bookmark",role:"assistant",createdAt:${now - 4000}}]});
    await window.api.setting.set({key:"ui.lastProjectId",value:project.id});
    await window.api.setting.set({key:"ui.lastSessionId",value:session.id});
    return session.id;
  })()`);
  const db = new DatabaseSync(join(data, "claude-gui.db"));
  db.prepare("UPDATE sessions SET usage_history=? WHERE id=?").run(JSON.stringify([
    { endedAt: now - 4000, durationMs: 800, generationMs: 500, outputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: 0, cacheUsageKnown: true, totalProcessedTokens: 120, usedTokens: 100 },
    { endedAt: now - 2000, durationMs: 800, generationMs: 500, outputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: 0, cacheUsageKnown: true, totalProcessedTokens: 120, usedTokens: 100 },
  ]), sessionId);
  db.close();
  const click = async selector => {
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
    await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
  };
  for (let reopen = 0; reopen < 2; reopen++) {
    await command("Page.reload");
    await command("Page.bringToFront");
    await wait("Boolean(document.querySelector('.fsess')) && document.body.textContent.includes('Overview restored')");
    assert.ok(await evaluate("document.querySelector('.fsess .fs-sum').textContent.includes('2')"), "Turn count survives removing the outline");
    await click(".fsess .fs-card > button");
    await wait("document.querySelector('.fsess')?.dataset.folded==='false'");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('.fsess h4')].map(n=>n.textContent.trim())"), ["书签1", "缓存与速度", "用量"], "Only the duplicate outline is removed");
    assert.ok(await evaluate("document.querySelector('.fsess').textContent.includes('Kept bookmark')"));
    const timeline = await evaluate("(()=>{const n=[...document.querySelectorAll('[data-chat-root] div')].find(n=>n.className.includes('absolute left-0 top-1/2'));return !!n && n.querySelectorAll('.cursor-pointer').length===3})()");
    assert.ok(timeline, "Left navigation still contains both turns and the assistant bookmark");
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    await wait("document.querySelector('.fsess')?.dataset.folded==='true'");
  }
  await click(".fsess .fs-card > button");
  await delay(250);
  const shot = await command("Page.captureScreenshot", { format: "png", fromSurface: false });
  await writeFile(join(data, "overview.png"), Buffer.from(shot.data, "base64"));
  assert.equal(errors.length, 0, "No renderer exceptions");
});
