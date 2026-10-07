import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { electronTest, delay } from "./electron-test-helper.mjs";
await electronTest("todo025-walkthrough",async data=>{
  const db=new DatabaseSync(join(data,"claude-gui.db"));
  db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  db.prepare("INSERT INTO settings VALUES (?,?)").run("mobile.enabled","0"); db.close();
  const work=join(data,"work"); await mkdir(work);
  await writeFile(join(work,"sample.ts"),'export const count = 1;\n');
  for (const args of [['init','--initial-branch=fixture'],['add','sample.ts'],['-c','user.name=UI Fixture','-c','user.email=fixture@example.invalid','commit','-m','Fixture baseline']]) {
    const result=spawnSync('git',args,{cwd:work,windowsHide:true}); assert.equal(result.status,0);
  }
  await writeFile(join(work,"sample.ts"),'export const count = 2;\n');
},async ({data,evaluate,wait,command,errors})=>{
  await evaluate(`(async()=>{
    const {project}=await window.api.project.create({name:"Workspace walkthrough",path:${JSON.stringify(join(data,"work"))}});
    const {session}=await window.api.claude.startSession({projectId:project.id,title:"UI walkthrough"});
    const now=Date.now();
    await window.api.session.saveMessages({sessionId:session.id,messages:[
      {id:'walk-u',sessionId:session.id,role:'user',content:[{kind:'text',text:'Review this workspace'}],createdAt:now-2000},
      {id:'walk-a',sessionId:session.id,role:'assistant',content:{blocks:[{kind:'text',text:${JSON.stringify("Workspace UI verification\n\nCheck `sample.ts` and continue.")}}],turnMeta:{startedAt:now-1800,endedAt:now-500,firstTokenMs:300,generationMs:1000,model:'fixture-model'}},createdAt:now-1800}
    ]});
    await window.api.setting.set({key:'ui.lastProjectId',value:project.id});
    await window.api.setting.set({key:'ui.lastSessionId',value:session.id});
  })()`);
  await command('Page.reload'); await wait("Boolean(window.api && document.querySelector('button .tabler-icon-settings'))");
  await evaluate("[...document.querySelectorAll('li')].find(n=>n.textContent.includes('UI walkthrough'))?.click()");
  await wait("document.body.textContent.includes('Workspace UI verification')");
  const pointer=async selector=>{
    const point=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing target '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`);
    assert.ok(point.hit,`Target painted: ${selector}`);
    await command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:point.x,y:point.y});
    await command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:point.x,y:point.y});
  };
  const screenshot=async name=>{
    await delay(250);
    const shot=await command('Page.captureScreenshot',{format:'png',fromSurface:false},10000);
    await writeFile(join(data,name+'.png'),Buffer.from(shot.data,'base64'));
  };
  const pane=async icon=>{
    const selector=`nav[aria-label="工具"] button:has(.tabler-icon-${icon})`;
    if(await evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-pressed')!=='true'`)) await pointer(selector);
  };
  await pointer('.fsess .fs-card > button'); await wait("document.querySelector('.fsess')?.dataset.folded==='false'");
  await command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});
  await command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});
  await wait("document.querySelector('.fsess')?.dataset.folded==='true'");
  for (const theme of ['light','dark']) {
    await evaluate("[...document.querySelectorAll('button[aria-label]')].filter(b=>b.getAttribute('aria-label')==='关闭标签页').forEach(b=>b.click())");
    await wait("[...document.querySelectorAll('.composer-prose')].some(e=>e.getBoundingClientRect().height>0)");
    await evaluate(`window.api.theme.set({theme:${JSON.stringify(theme)}})`);
    await screenshot(theme+'-chat');
    await pane('folder');
    await wait("[...document.querySelectorAll('button[title]')].some(b=>b.title.endsWith('sample.ts'))");
    await evaluate("[...document.querySelectorAll('button[title]')].find(b=>b.title.endsWith('sample.ts')).click()");
    await wait("Boolean(document.querySelector('.monaco-editor'))");
    await screenshot(theme+'-file');
    await evaluate("[...document.querySelectorAll('button[aria-label]')].filter(b=>b.getAttribute('aria-label')==='关闭标签页').forEach(b=>b.click())");
    await wait("[...document.querySelectorAll('.composer-prose')].some(e=>e.getBoundingClientRect().height>0)");
    await pane('git-branch');
    await wait("document.body.textContent.includes('sample.ts') && document.body.textContent.includes('fixture')");
    await screenshot(theme+'-git');
    await pane('world');
    await wait("document.querySelector('nav[aria-label=工具] button:has(.tabler-icon-world)').getAttribute('aria-pressed')==='true'");
    await screenshot(theme+'-browser');
    await pane('list-details');
    await screenshot(theme+'-turns');
    await pane('messages');
    await screenshot(theme+'-sidechat');
    await pointer('nav[aria-label="工具"] button:has(.tabler-icon-terminal-2)');
    await wait("[...document.querySelectorAll('.xterm')].some(e=>e.getBoundingClientRect().height>50)");
    await screenshot(theme+'-terminal');
    await pointer('nav[aria-label="工具"] button:has(.tabler-icon-terminal-2)');
  }
  await pointer('button:has(.tabler-icon-settings)');
  await wait("Boolean(document.querySelector('.settings-root nav'))");
  for(const group of ['AI 能力','输入与提醒','工作台','系统']) await evaluate(`[...document.querySelectorAll('.settings-root nav button')].find(b=>b.textContent.trim()===${JSON.stringify(group)})?.click()`);
  const pages=['常规','外观','模型配置','上下文与压缩','系统提示词','Agent','网络','技能','MCP','MarioTool','语音输入','快捷键','鼠标手势','消息通知','定时任务','Git','终端','浏览器','用量统计','关于'];
  for(const label of pages) {
    await evaluate(`(()=>{const e=[...document.querySelectorAll('.settings-root nav button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!e)throw Error('Missing settings page '+${JSON.stringify(label)});e.dataset.walkTarget='yes'})()`);
    await pointer('[data-walk-target]'); await evaluate("document.querySelector('[data-walk-target]').removeAttribute('data-walk-target')");
    await wait(`document.querySelector('main.settings-content')?.getAttribute('aria-label')===${JSON.stringify(label)}`);
    assert.ok(await evaluate("document.querySelector('main.settings-content').textContent.trim().length>10"),label);
  }
  await screenshot('dark-settings-about');
  assert.deepEqual(errors,[],'no renderer exceptions throughout workspace and settings');
  await writeFile(join(data,'walkthrough.json'),JSON.stringify({themes:['light','dark'],panes:['chat','file','git','browser','turns','sidechat','terminal'],settings:pages,errors},null,2));
});
