import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { electronTest } from "./electron-test-helper.mjs";
const key="migration-fixture-secret-not-a-real-key";
await electronTest("todo024-validation",async data=>{
  const db=new DatabaseSync(join(data,"claude-gui.db"));
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  db.prepare("INSERT INTO settings VALUES (?,?)").run("mobile.enabled","0"); db.close();
  await mkdir(join(data,".pi","agent"),{recursive:true});
  await writeFile(join(data,".pi","agent","models.json"),JSON.stringify({preservationMarker:"keep me",providers:{handwritten:{baseUrl:"https://example.invalid/v1",api:"openai-completions",apiKey:"MIGRATION_TEST_ENV",headers:{"x-test":"custom"},models:[{id:"hand-model",compat:{supportsDeveloperRole:false}}]}}}));
},async ({data,evaluate,wait,command})=>{
  const source=await evaluate(`(async()=>{
    const claude=(await window.api.customModel.save({name:"Legacy Claude",baseUrl:"https://example.invalid/v1",authMode:"api_key",protocol:"anthropic",authToken:${JSON.stringify(key)},models:[{id:"old-claude",contextWindow:200000}]})).models.find(p=>p.name==='Legacy Claude');
    await window.api.piModels.save({name:"legacy_pi",config:{name:"Legacy Pi",baseUrl:"https://example.invalid/v1",api:"openai-completions",authHeader:true,models:[{id:"old-pi",contextWindow:200000,maxTokens:1000,reasoning:true,input:['text','image']}]},apiKey:${JSON.stringify(key)}});
    await window.api.codexModels.save({id:"legacy_codex",name:"Legacy Codex",baseUrl:"https://example.invalid/v1",models:[{id:"old-codex",label:'Old Codex',contextWindow:200000}],apiKey:${JSON.stringify(key)}});
    return claude.id;
  })()`);
  const originalPi=await readFile(join(data,".pi","agent","models.json"),"utf8");
  const db=new DatabaseSync(join(data,"claude-gui.db"),{readOnly:true});
  const originals=Object.fromEntries(["customModels","customModelKeys","piProviderKeys","codexProviders","codexProviderKeys"].map(k=>[k,db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value]));
  const listed=(await evaluate("window.api.sharedProviders.listLegacy()")).entries;
  assert.equal(listed.length,4); assert.ok(!JSON.stringify(listed).includes(key));
  assert.equal(listed.find(p=>p.sourceId==='handwritten').issue,'advanced');
  await evaluate("document.querySelector('button .tabler-icon-settings').closest('button').click()");
  await wait("[...document.querySelectorAll('.settings-root nav button')].some(b=>b.textContent.trim()==='AI 能力')");
  await evaluate("[...document.querySelectorAll('.settings-root nav button')].find(b=>b.textContent.trim()==='AI 能力').click()");
  await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='模型配置')");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='模型配置').click()");
  await wait("Boolean(document.querySelector('[data-legacy-providers]'))");
  await evaluate("document.querySelector('[data-legacy-providers]').open=true");
  await evaluate(`document.querySelector('[data-legacy-id="'+CSS.escape(${JSON.stringify(source)})+'"] button').click()`);
  await wait(`document.querySelector('[data-legacy-id="'+CSS.escape(${JSON.stringify(source)})+'"]')?.textContent.includes('已复制')`);
  const copied=(await evaluate("window.api.sharedProviders.list()")).providers;
  assert.equal(copied.length,1); assert.equal(copied[0].hasApiKey,true);
  for(const entry of [{engine:'claude',sourceId:source},{engine:'pi',sourceId:'legacy_pi'},{engine:'codex',sourceId:'legacy_codex'}]) {
    const replies=await evaluate(`Promise.all([window.api.sharedProviders.importLegacy(${JSON.stringify(entry)}),window.api.sharedProviders.importLegacy(${JSON.stringify(entry)})])`);
    assert.equal(replies[0].providerId,replies[1].providerId,'concurrent imports are idempotent');
    assert.ok(replies[0].providers.find(p=>p.id===replies[0].providerId).enabledAgents.includes(entry.engine));
  }
  assert.equal((await evaluate("window.api.sharedProviders.list()")).providers.length,3);
  assert.ok(await evaluate("window.api.sharedProviders.importLegacy({engine:'pi',sourceId:'handwritten'}).then(()=>false,()=>true)"));
  const p=(await evaluate("window.api.sharedProviders.list()")).providers[0];
  const {id,name,baseUrl,protocols,enabledAgents,models}=p;
  const draft={id,name,baseUrl,protocols,enabledAgents,models,apiKey:''};
  await evaluate(`window.api.sharedProviders.save(${JSON.stringify({...draft,baseUrl:'https://example.invalid/fixed/v1'})})`);
  assert.ok(await evaluate(`window.api.sharedProviders.save(${JSON.stringify({...draft,baseUrl:'https://another.invalid/v1'})}).then(()=>false,()=>true)`),'new server needs a key');
  assert.ok(await evaluate(`window.api.sharedProviders.save(${JSON.stringify({...draft,endpointOverrides:{anthropic:'https://another.invalid/v1'}})}).then(()=>false,()=>true)`),'override cannot forward a stored key');
  await evaluate(`window.api.sharedProviders.save(${JSON.stringify({...draft,name:'Edited copy'})})`);
  for(const [k,v] of Object.entries(originals)) assert.equal(db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value,v,'legacy metadata and keys stay unchanged');
  assert.ok(!db.prepare("SELECT value FROM settings WHERE key='sharedProviders.keys'").get().value.includes(key),'imported keys encrypted');
  db.close();
  assert.equal(await readFile(join(data,".pi","agent","models.json"),'utf8'),originalPi,'handwritten Pi file preserved byte for byte');
  assert.ok((await evaluate("window.api.customModel.list()")).models.some(p=>p.id===source&&p.name==='Legacy Claude'),'old chat source still resolves');
  await command("Page.reload"); await wait("Boolean(window.api)");
  assert.equal((await evaluate("window.api.sharedProviders.listLegacy()")).entries.filter(e=>e.importedProviderId).length,3,'import mappings persist');
});
