import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const desktop = resolve(fileURLToPath(new URL("..", import.meta.url)));
const host = join(desktop, "out", "pi-host", "piHost.mjs");
const candidates = [
  join(desktop, "node_modules", "@earendil-works", "pi-coding-agent"),
  join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm", "node_modules", "@earendil-works", "pi-coding-agent"),
  ...process.argv.slice(2).map((path) => resolve(path)),
];

async function packageInfo(dir) {
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    const root = pkg.exports?.["."];
    const rel = typeof root === "string" ? root : root?.import || root?.default || "dist/index.js";
    return { dir, version: pkg.version, entry: join(dir, rel) };
  } catch { return null; }
}

async function testRuntime(runtime) {
  const isolated = await mkdtemp(join(tmpdir(), `mcode-pi-host-${runtime.version}-`));
  const cwd = join(isolated, "cwd");
  await mkdir(cwd);
  const child = spawn(process.execPath, [host, runtime.entry, runtime.dir, runtime.version], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_CODING_AGENT_DIR: join(isolated, "pi"), HOME: isolated, USERPROFILE: isolated },
  });
  const messages = [];
  const waiters = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    messages.push(msg);
    const waiter = msg.id && waiters.get(msg.id);
    if (waiter) { waiters.delete(msg.id); waiter(msg); }
  });
  const waitFor = (id, timeout = 15000) => new Promise((resolvePromise, reject) => {
    const prior = messages.find((m) => m.id === id);
    if (prior) return resolvePromise(prior);
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`timeout waiting for ${id}`)); }, timeout);
    waiters.set(id, (msg) => { clearTimeout(timer); resolvePromise(msg); });
  });
  try {
    const readyDeadline = Date.now() + 15000;
    while (!messages.some((m) => m.type === "ready")) {
      if (Date.now() > readyDeadline) throw new Error("ready timeout");
      await new Promise((r) => setTimeout(r, 20));
    }
    const ready = messages.find((m) => m.type === "ready");
    if (ready.protocol !== 1) throw new Error(`bad protocol ${ready.protocol}`);

    child.stdin.write(`${JSON.stringify({ type: "call", id: "invalid", call: { method: "smoke", params: {} } })}\n`);
    await new Promise((r) => setTimeout(r, 100));
    if (messages.some((m) => m.id === "invalid")) throw new Error("invalid request was executed");

    const calls = [
      { type: "call", id: "health", call: { method: "healthCheck", params: {} } },
      { type: "call", id: "list", call: { method: "listModels", params: { providers: {}, apiKeys: {} } } },
      { type: "call", id: "smoke-a", call: { method: "smoke", params: { cwd } } },
      { type: "call", id: "smoke-b", call: { method: "smoke", params: { cwd } } },
    ];
    for (const call of calls) child.stdin.write(`${JSON.stringify(call)}\n`);
    const [health, list, smokeA, smokeB] = await Promise.all(calls.map((c) => waitFor(c.id)));
    if (!health.ok || health.value?.ok !== true) throw new Error(`health failed: ${JSON.stringify(health)}`);
    if (!list.ok || !Array.isArray(list.value) || list.value.length !== 0) throw new Error(`empty list failed: ${JSON.stringify(list)}`);
    if (!smokeA.ok || !smokeA.value?.sessionId || smokeA.value.snapshotFresh !== true || !smokeB.ok || !smokeB.value?.sessionId || smokeB.value.snapshotFresh !== true) throw new Error("parallel smoke/snapshot reset failed");
    if (smokeA.id !== "smoke-a" || smokeB.id !== "smoke-b") throw new Error("parallel responses crossed");

    const exited = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("host stayed alive after stdin EOF")); }, 5000);
      child.once("exit", (code) => { clearTimeout(timer); resolvePromise(code); });
    });
    child.stdin.end();
    const code = await exited;
    if (code !== 0) throw new Error(`host exited ${code}`);
    return `${runtime.version}: ready/health/list/smoke/validation/parallel/EOF passed`;
  } finally {
    if (!child.killed) child.kill();
    if (!resolve(isolated).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup target");
    await rm(isolated, { recursive: true, force: true });
  }
}

const runtimes = (await Promise.all(candidates.map(packageInfo))).filter(Boolean);
if (runtimes.length < 2) throw new Error(`Expected project and global Pi runtimes; found ${runtimes.map((r) => r.version).join(", ")}`);
for (const runtime of runtimes) console.log(await testRuntime(runtime));
