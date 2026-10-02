import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startSharedProviderFixture } from "./shared-provider-http-fixture.mjs";

const desktop = resolve(fileURLToPath(new URL("..", import.meta.url)));
const host = process.env.MARIOCODE_TEST_PI_HOST || join(desktop, "out", "pi-host", "piHost.mjs");
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
    const realDir = await realpath(dir);
    const aiCandidates = [
      join(realDir, "..", "pi-ai", "dist", "index.js"),
      join(realDir, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
    ];
    let aiEntry;
    for (const candidate of aiCandidates) {
      try { await readFile(candidate); aiEntry = candidate; break; } catch { /* try the next install layout */ }
    }
    if (!aiEntry) throw new Error(`matching pi-ai runtime not found for ${dir}`);
    return { dir, version: pkg.version, entry: join(dir, rel), aiEntry };
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
  const upstream = await startSharedProviderFixture();
  const isolated = await mkdtemp(join(tmpdir(), `mariocode-pi-host-${runtime.version}-`));
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
        models: [{ id: "fixture-model" }],
        hasApiKey: true,
      },
    };
    const calls = [
      { type: "call", id: "health", call: { method: "healthCheck", params: { agentDir: join(isolated, "agent") } } },
      { type: "call", id: "list", call: { method: "listModels", params: { providers: {}, apiKeys: {}, agentDir: join(isolated, "agent") } } },
      { type: "call", id: "list-fixture", call: { method: "listModels", params: { providers: fixtureProviders, apiKeys: { shared_0123456789abcdef0123456789abcdef: "fixture-secret-never-return" }, agentDir: join(isolated, "agent") } } },
      { type: "call", id: "smoke-a", call: { method: "smoke", params: { cwd, agentDir: join(isolated, "agent") } } },
      { type: "call", id: "smoke-b", call: { method: "smoke", params: { cwd, agentDir: join(isolated, "agent") } } },
      { type: "call", id: "smoke-model", call: { method: "smoke", params: { cwd, agentDir: join(isolated, "agent"), providers: fixtureProviders, apiKeys: { shared_0123456789abcdef0123456789abcdef: "fixture-secret-never-return" } } } },
    ];
    for (const call of calls) child.stdin.write(`${JSON.stringify(call)}\n`);
    const [health, list, fixture, smokeA, smokeB, smokeModel] = await Promise.all(calls.map((c) => waitFor(c.id)));
    if (!health.ok || health.value?.ok !== true) throw new Error(`health failed: ${JSON.stringify(health)}`);
    if (!list.ok || !Array.isArray(list.value) || list.value.length !== 0) throw new Error(`empty list failed: ${JSON.stringify(list)}`);
    if (!fixture.ok || fixture.value?.[0]?.id !== "shared_0123456789abcdef0123456789abcdef/fixture-model") throw new Error(`in-memory provider registration failed: ${JSON.stringify(fixture)}`);
    if (fixture.value[0].supplier !== "Isolated fixture") throw new Error(`shared supplier leaked runtime id: ${JSON.stringify(fixture)}`);
    if (JSON.stringify(fixture).includes("fixture-secret-never-return")) throw new Error("list response leaked API key");
    const registered = smokeModel.value?.registeredModel;
    const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    if (!smokeModel.ok || registered?.name !== "fixture-model" || registered?.reasoning !== false
      || JSON.stringify(registered?.input) !== JSON.stringify(["text"])
      || JSON.stringify(registered?.cost) !== JSON.stringify(zeroCost)
      || registered?.contextWindow !== 128000 || registered?.maxTokens !== 16384) {
      throw new Error(`shared model registration was not normalized: ${JSON.stringify(smokeModel)}`);
    }
    const { calculateCost } = await import(pathToFileURL(runtime.aiEntry).href);
    const usage = { input: 1000, output: 1000, cacheRead: 100, cacheWrite: 50, totalTokens: 2150,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const calculated = calculateCost(registered, usage);
    if (calculated.total !== 0) throw new Error(`zero-rate cost calculation changed total: ${JSON.stringify(calculated)}`);
    if (await directoryContains(join(isolated, "agent"), "fixture-secret-never-return")) throw new Error("runtime API key was persisted to the private agent directory");
    if (!smokeA.ok || !smokeA.value?.sessionId || smokeA.value.snapshotFresh !== true || !smokeB.ok || !smokeB.value?.sessionId || smokeB.value.snapshotFresh !== true) throw new Error("parallel smoke/snapshot reset failed");
    if (smokeA.id !== "smoke-a" || smokeB.id !== "smoke-b") throw new Error("parallel responses crossed");
    if (await readFile(join(userPiDir, "models.json"), "utf8") !== modelsSentinel || await readFile(join(userPiDir, "auth.json"), "utf8") !== authSentinel) throw new Error("host touched the user's ~/.pi configuration");

    // One shared provider, three models with distinct wire APIs and endpoint
    // overrides. Run real turns, not just listing registration metadata.
    const sharedId = "shared_0123456789abcdef0123456789abcdef";
    const wireModels = [
      { id: "vendor/chat-model", api: "openai-completions", route: "chat", suffix: "/chat/completions" },
      { id: "messages-model", api: "anthropic-messages", route: "messages", suffix: "/messages" },
      { id: "responses-model", api: "openai-responses", route: "responses", suffix: "/responses" },
    ];
    const wireProviders = { [sharedId]: { ...fixtureProviders[sharedId], baseUrl: `http://127.0.0.1:${upstream.port}/chat/v1`, models: wireModels.map(({ id, api, route }) => ({ id, api, baseUrl: `http://127.0.0.1:${upstream.port}/${route}/v1` })) } };
    let resumeProviderSessionId;
    for (const [index, model] of [...wireModels, wireModels[0]].entries()) {
      const turnId = `wire-${index}`;
      const params = { turnId, request: { sessionId: "wire-session", cwd, prompt: "Reply briefly", model: index === 3 ? "default" : `${sharedId}/${model.id}`, effort: "default", permissionMode: "bypassPermissions", turnNumber: index + 1, ...(index < 3 ? { resumeProviderSessionId } : {}) }, providers: wireProviders, apiKeys: { [sharedId]: "fixture-secret-never-return" }, extraSkillPaths: [], gitBash: null, browserToolsEnabled: false, browserToolSpecs: {}, browserUsagePrompt: "", userSystemPrompt: "", agentDir: join(isolated, "agent") };
      child.stdin.write(`${JSON.stringify({ type: "call", id: turnId, call: { method: "startTurn", params } })}\n`);
      const result = await waitFor(turnId, 30000);
      if (!result.ok) throw new Error(`Pi wire turn failed: ${JSON.stringify(result)}`);
      const events = messages.filter((m) => m.type === "event" && m.turnId === turnId).map((m) => m.event);
      if (events.some((e) => e.type === "error") || !events.some((e) => e.type === "text.delta" && e.text?.includes(`fixture-ok:${model.id}`))) throw new Error(`Pi wire output missing: ${JSON.stringify(events)}`);
      const request = upstream.requests.at(-1);
      if (request.path !== `/${model.route}/v1${model.suffix}` || request.body.model !== model.id) throw new Error(`Pi model route incorrect: ${request.path}, model=${request.body.model}`);
      if (request.authorization !== "Bearer fixture-secret-never-return" && request.apiKey !== "fixture-secret-never-return") throw new Error("Pi runtime API key was not sent");
      resumeProviderSessionId = messages.find((m) => m.type === "providerSessionId" && m.turnId === turnId)?.value;
    }

    const exited = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("host stayed alive after stdin EOF")); }, 5000);
      child.once("exit", (code) => { clearTimeout(timer); resolvePromise(code); });
    });
    child.stdin.end();
    const code = await exited;
    if (code !== 0) throw new Error(`host exited ${code}`);
    return `${runtime.version}: ready/health/list/smoke/normalized-cost/validation/parallel/three-wire-APIs/EOF passed`;
  } finally {
    if (!child.killed) child.kill();
    await upstream.close();
    if (!resolve(isolated).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup target");
    await rm(isolated, { recursive: true, force: true });
  }
}

const runtimes = (await Promise.all(candidates.map(packageInfo))).filter(Boolean);
if (runtimes.length === 0) throw new Error("No project, global, or supplied Pi runtime is available");
for (const runtime of runtimes) console.log(await testRuntime(runtime));
