import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
export const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const delay = ms => new Promise(r => setTimeout(r, ms));

export async function electronTest(name, seed, verify, options = {}) {
  const root = resolve(desktop, "../../.turbo", name);
  await mkdir(root, { recursive: true });
  const data = await mkdtemp(join(root, "run-"));
  await seed(data);
  const require = createRequire(join(desktop, "package.json"));
  const child = spawn(require("electron"), [...(options.mainInspector ? ["--inspect=0"] : []), process.env.MARIOCODE_TEST_ASAR || desktop, `--user-data-dir=${data}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"], {
    cwd: desktop, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, HOME: data, USERPROFILE: data },
  });
  let log = ""; let ws; let mainWs;
  child.stdout.on("data", c => { log += c; }); child.stderr.on("data", c => { log += c; });
  let id = 0; const pending = new Map(); const errors = [];
  const mainPending = new Map();
  try {
    const deadline = Date.now() + 60000;
    let port;
    while (!(port = log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/)?.[1])) {
      if (Date.now() > deadline || child.exitCode !== null) throw Error(`App did not start: ${log.slice(-2500)}`);
      await delay(100);
    }
    let page;
    while (!page) {
      page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === "page" && p.url.startsWith("file:"));
      if (Date.now() > deadline) throw Error("Main page missing");
      if (!page) await delay(100);
    }
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r,j) => { ws.addEventListener("open",r,{once:true}); ws.addEventListener("error",j,{once:true}); });
    ws.addEventListener("message", e => {
      const msg = JSON.parse(e.data); const p = pending.get(msg.id);
      if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
      if (p) { pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result); }
    });
    const command = (method, params = {}, timeout = 20000) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`CDP timed out: ${method}`)); }, timeout);
      pending.set(requestId,{resolve,reject,timer}); ws.send(JSON.stringify({id:requestId,method,params}));
    });
    const evaluate = async expression => {
      const result = await command("Runtime.evaluate", { expression, returnByValue:true, awaitPromise:true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? "Renderer failed");
      return result.result.value;
    };
    const wait = async expression => {
      const until = Date.now()+20000;
      while (!await evaluate(expression)) { if (Date.now()>until) throw Error(`UI assertion timed out: ${expression}`); await delay(100); }
    };
    // Optional, local test inspector: examine real native child bounds without
    // exposing diagnostic IPC or a debug API in the production application.
    let mainEvaluate;
    if (options.mainInspector) {
      const url = log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1];
      if (!url) throw Error("Main process inspector missing");
      mainWs = new WebSocket(url);
      await new Promise((r,j) => { mainWs.addEventListener("open",r,{once:true}); mainWs.addEventListener("error",j,{once:true}); });
      mainWs.addEventListener("message", e => {
        const msg = JSON.parse(e.data); const p = mainPending.get(msg.id);
        if (p) { mainPending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(Error(msg.error.message)) : p.resolve(msg.result); }
      });
      mainEvaluate = async expression => {
        const result = await new Promise((resolve,reject) => {
          const requestId = ++id;
          const timer = setTimeout(() => { mainPending.delete(requestId); reject(Error("Main inspector timed out")); },20000);
          mainPending.set(requestId,{resolve,reject,timer});
          mainWs.send(JSON.stringify({id:requestId,method:"Runtime.evaluate",params:{expression,returnByValue:true,awaitPromise:true}}));
        });
        if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? "Main inspection failed");
        return result.result.value;
      };
    }
    await wait("Boolean(window.api && document.querySelector('button .tabler-icon-settings'))");
    await command("Runtime.enable");
    await verify({data,command,evaluate,wait,errors,mainEvaluate});
    await writeFile(join(data,"result.json"),JSON.stringify({result:"passed",name},null,2));
    console.log(`PASS: ${name}; artifacts ${data}`);
  } finally {
    ws?.close();
    mainWs?.close();
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error("Test closed")); }
    for (const p of mainPending.values()) { clearTimeout(p.timer); p.reject(Error("Test closed")); }
    if (child.exitCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/F","/T","/PID",String(child.pid)],{windowsHide:true,stdio:"ignore"});
      else child.kill();
    }
    await writeFile(join(data,"electron.log"),log);
  }
}
