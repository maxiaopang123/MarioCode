/**
 * The operation area, end to end in the built app.
 *
 * Guards the wiring of the 「一步一行」 redesign (原型 exec-steps-claude-style),
 * not the heuristics (`test:tool-summary` covers those):
 *
 *   1. a batch of Bash calls renders as ONE sentence header (「执行 3 条命令」)
 *      instead of 「3 个操作　Bash ×3」;
 *   2. each row is its own one-line sentence — the payload, not the shared
 *      `cd "…" && MC_SSH_PASS=… node run.mjs "echo …"` wrapper that used to
 *      make three sibling calls look identical and print a credential;
 *   3. expanding a row shows the typed layer (`$ command` + exit code), with
 *      the credential still masked in the rendered command;
 *   4. no credential anywhere in the DOM.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { electronTest, delay } from "./electron-test-helper.mjs";

const SECRET = "s3cret-value";
const wrap = (payload) =>
  `cd "C:\\Users\\MI\\mariocode\\skills\\ssh-yiliyun\\scripts" && MC_SSH_PASS='${SECRET}' node run.mjs "echo '${payload}'"`;
const payloads = ["=== 找 octopus 中转站 ===", "=== octopus 探针配置 ===", "=== 运行时状态 ==="];

await electronTest("tool-row-summary", async (data) => {
  // Same pre-boot settings as the other desktop fixtures: no LAN/mobile
  // surface, direct network, no title generation (it would need a model).
  const db = new DatabaseSync(join(data, "claude-gui.db"));
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  for (const [key, value] of Object.entries({
    "mobile.enabled": "0",
    "network.proxy": JSON.stringify({ mode: "direct", customUrl: "" }),
    "ui.titleGenEnabled": "0",
  })) db.prepare("INSERT INTO settings VALUES (?,?)").run(key, value);
  db.close();
  await mkdir(join(data, "work"));
}, async ({ data, evaluate, wait, command }) => {
  const work = join(data, "work").replace(/\\/g, "/");
  const commands = payloads.map(wrap);
  await evaluate(`(async()=>{
    const {project}=await window.api.project.create({name:"row-test",path:${JSON.stringify(work)}});
    const {session}=await window.api.claude.startSession({projectId:project.id,title:"row-check"});
    const now=Date.now();
    const block=(id,command)=>({kind:"tool_use",toolCallId:id,toolName:"Bash",input:{command},status:"done",result:"=== 运行时状态 ===\\nOK"});
    await window.api.session.saveMessages({sessionId:session.id,messages:[
      {id:"row-user",sessionId:session.id,role:"user",content:[{kind:"text",text:"go"}],createdAt:now-2000},
      {id:"row-assistant",sessionId:session.id,role:"assistant",content:{blocks:[
        ...${JSON.stringify(commands)}.map((c,i)=>block("row-call-"+i,c)),
        {kind:"text",text:"操作完成。"}
      ],turnMeta:{startedAt:now-1900,endedAt:now-100,model:"test"}},createdAt:now-1900}
    ]});
    await window.api.setting.set({key:"ui.lastProjectId",value:project.id});
    await window.api.setting.set({key:"ui.lastSessionId",value:session.id});
    return session.id;
  })()`);

  const reopen = async () => {
    await command("Page.reload");
    await wait("Boolean(window.api && document.querySelector('button .tabler-icon-settings'))");
    await evaluate(`(()=>{const n=[...document.querySelectorAll('[role=button]')].find(n=>n.textContent.includes('row-check'));n?.click()})()`);
    await wait("document.body.innerText.includes('操作完成。')");
    await wait("Boolean(document.querySelector('.chat-ledger'))");
    // Open the ledger, then the operation group inside it. The group's header
    // is now a SENTENCE (「执行 3 条命令」), not the old 「3 个操作」 tally —
    // that swap is exactly what this test pins down.
    await evaluate("document.querySelector('.chat-ledger-head')?.click()");
    await wait("document.querySelector('.chat-ledger')?.getAttribute('data-open')==='true'");
    await wait("Boolean(document.querySelector('.chat-ledger-body button'))");
    await evaluate(`(()=>{
      const head=[...document.querySelectorAll('.chat-ledger-body button')].find(b=>b.textContent.includes('执行 3 条命令'));
      head?.click();
    })()`);
    try {
      await wait("document.querySelectorAll('.chat-ledger-body button').length>=4");
    } catch (err) {
      // A stuck expand is usually a selector drift, not a logic bug — print
      // what the ledger actually contains before failing.
      const diag = await evaluate(`JSON.stringify({
        ledgers: document.querySelectorAll('.chat-ledger').length,
        body: document.querySelectorAll('.chat-ledger-body').length,
        buttons: [...document.querySelectorAll('.chat-ledger-body button')].map(b=>b.textContent.trim()),
        text: document.querySelector('.chat-ledger-body')?.innerText?.slice(0,400) ?? null
      })`);
      throw new Error(`${err.message} :: ${diag}`);
    }
    await delay(200);
  };
  await reopen();

  // 1. One sentence instead of 「3 个操作　Bash ×3」.
  const header = await evaluate(`[...document.querySelectorAll('.chat-ledger-body button')]
    .map(b=>b.textContent.trim()).find(t=>t.includes('条命令')) ?? ''`);
  assert.equal(header, "执行 3 条命令", `group header is a sentence, got ${JSON.stringify(header)}`);

  // 2. Three distinct rows, each carrying its own payload.
  const rows = await evaluate(`[...document.querySelectorAll('.chat-ledger-body button')]
    .map(b=>b.textContent.trim()).filter(t=>t.startsWith('==='))`);
  assert.equal(rows.length, 3, `three command rows render, got ${JSON.stringify(rows)}`);
  for (const [i, payload] of payloads.entries()) {
    assert.ok(rows[i].includes(payload), `row ${i} shows its payload: ${rows[i]}`);
    assert.ok(!rows[i].includes("node run.mjs"), `row ${i} drops the runner wrapper: ${rows[i]}`);
  }
  assert.equal(new Set(rows).size, 3, "rows are distinguishable");

  // 3. The typed expansion layer: `$ command` + exit code, credential masked.
  await evaluate(`(()=>{
    const row=[...document.querySelectorAll('.chat-ledger-body button')].find(b=>b.textContent.includes(${JSON.stringify(payloads[0])}));
    row?.click();
  })()`);
  await wait("Boolean(document.querySelector('.chat-ledger-body pre, .chat-ledger-body .font-mono'))");
  await delay(150);
  const expanded = await evaluate(`document.querySelector('.chat-ledger-body button[aria-expanded], .chat-ledger-body')?.innerText ?? ''`);
  assert.ok(expanded.includes("$"), "the expansion shows the $ command line");
  assert.ok(expanded.includes("退出码 0"), "and the exit code meta strip");
  assert.ok(expanded.includes("node run.mjs"), "the expansion carries the FULL command");
  assert.ok(!expanded.includes(SECRET), "but masks the credential value");
  assert.ok(expanded.includes("MC_SSH_PASS=***"), "keeping the variable name");

  // 4. No credential anywhere in the rendered turn (row, ticker or tooltip).
  const text = await evaluate("document.body.innerText");
  assert.ok(!text.includes(SECRET), "the password never reaches the DOM");
  assert.ok(!text.includes("MC_SSH_PASS='"), "nor an unmasked credential assignment");

  const shot = await command("Page.captureScreenshot", { format: "png" }).catch(() => null);
  if (shot) await writeFile(join(data, "tool-rows.png"), Buffer.from(shot.data, "base64"));
});
