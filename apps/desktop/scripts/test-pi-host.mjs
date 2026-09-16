import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

async function directoryContains(dir, needle) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (await directoryContains(path, needle)) return true; }
    else { try { if ((await readFile(path, "utf8")).includes(needle)) return true; } catch { /* binary/unreadable */ } }
  }
  return false;
}

async function testRuntime(runtime) {
  const isolated = await mkdtemp(join(tmpdir(), `mcode-pi-host-${runtime.version}-`));
  const cwd = join(isolated, "cwd");
  await mkdir(cwd);
  const userPiDir = join(isolated, ".pi", "agent");
  await mkdir(userPiDir, { recursive: true });
  const modelsSentinel = '{"sentinel":"models-untouched"}';
  const authSentinel = '{"sentinel":"auth-untouched"}';
  await writeFile(join(userPiDir, "models.json"), modelsSentinel);
  await writeFile(join(userPiDir, "auth.json"), authSentinel);
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

    const fixtureProviders = {
      shared_0123456789abcdef0123456789abcdef: {
        name: "Isolated fixture",
        baseUrl: "https://fixture.invalid/v1",
        api: "openai-completions",
        authHeader: true,
        models: [{ id: "fixture-model", name: "Fixture Model", contextWindow: 4096, maxTokens: 1024 }],
        hasApiKey: true,
      },
    };
    const calls = [
      { type: "call", id: "health", call: { method: "healthCheck", params: { agentDir: join(isolated, "agent") } } },
      { type: "call", id: "list", call: { method: "listModels", params: { providers: {}, apiKeys: {}, agentDir: join(isolated, "agent") } } },
      { type: "call", id: "list-fixture", call: { method: "listModels", params: { providers: fixtureProviders, apiKeys: { shared_0123456789abcdef0123456789abcdef: "fixture-secret-never-return" }, agentDir: join(isolated, "agent") } } },
      { type: "call", id: "smoke-a", call: { method: "smoke", params: { cwd, agentDir: join(isolated, "agent") } } },
      { type: "call", id: "smoke-b", call: { method: "smoke", params: { cwd, agentDir: join(isolated, "agent") } } },
    ];
    for (const call of calls) child.stdin.write(`${JSON.stringify(call)}\n`);
    const [health, list, fixture, smokeA, smokeB] = await Promise.all(calls.map((c) => waitFor(c.id)));
    if (!health.ok || health.value?.ok !== true) throw new Error(`health failed: ${JSON.stringify(health)}`);
    if (!list.ok || !Array.isArray(list.value) || list.value.length !== 0) throw new Error(`empty list failed: ${JSON.stringify(list)}`);
    if (!fixture.ok || fixture.value?.[0]?.id !== "shared_0123456789abcdef0123456789abcdef/fixture-model") throw new Error(`in-memory provider registration failed: ${JSON.stringify(fixture)}`);
    if (fixture.value[0].supplier !== "Isolated fixture") throw new Error(`shared supplier leaked runtime id: ${JSON.stringify(fixture)}`);
    if (JSON.stringify(fixture).includes("fixture-secret-never-return")) throw new Error("list response leaked API key");
    if (await directoryContains(join(isolated, "agent"), "fixture-secret-never-return")) throw new Error("runtime API key was persisted to the private agent directory");
    if (!smokeA.ok || !smokeA.value?.sessionId || smokeA.value.snapshotFresh !== true || !smokeB.ok || !smokeB.value?.sessionId || smokeB.value.snapshotFresh !== true) throw new Error("parallel smoke/snapshot reset failed");
    if (smokeA.id !== "smoke-a" || smokeB.id !== "smoke-b") throw new Error("parallel responses crossed");
    if (await readFile(join(userPiDir, "models.json"), "utf8") !== modelsSentinel || await readFile(join(userPiDir, "auth.json"), "utf8") !== authSentinel) throw new Error("host touched the user's ~/.pi configuration");

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
