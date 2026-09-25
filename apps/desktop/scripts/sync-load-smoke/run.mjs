// TODO-004 engine-loading smoke: lay out what skillSync / mcpSync / the Codex
// config materializer write, then ask the real Claude CLI, Codex app-server and
// Pi SDK what they loaded — with the options the MarioCode providers pass.
// No model call is made and nothing outside a temp dir is touched.
//
// The fixture layout mirrors skillSync.runSync + materializeSyncPlugin (mirror
// dir + synthesized `.claude-plugin` dir), mcpSync (normalized configs in
// `<CLAUDE_CONFIG_DIR>/.claude.json` mcpServers) and codexModelsStore
// mcpServerToml; keep them in step when those layouts change. Run after
// bumping any engine: `pnpm test:sync-load`.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(desktop, "package.json"));
const T = mkdtempSync(path.join(tmpdir(), "mariocode-sync-load-"));
const MCODE = path.join(T, "home", ".mcode");
const PROJECT = path.join(T, "project");
const BIN = path.join(T, "bin");
const SRC_SKILLS = path.join(T, "src-skills");
const SKILL = "mc-sync-marker";
const win = process.platform === "win32";
const failures = [];

function check(label, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

function codexBinary() {
  const triple = {
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
  }[`${process.platform}-${process.arch}`];
  const exe = win ? "codex.exe" : "codex";
  const wrapperDir = path.dirname(require.resolve("@openai/codex/package.json"));
  const candidates = [path.join(wrapperDir, "vendor", triple, "bin", exe)];
  try {
    const platformPkg = createRequire(path.join(wrapperDir, "package.json")).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
    candidates.unshift(path.join(path.dirname(platformPkg), "vendor", triple, "bin", exe));
  } catch { /* wrapper-only layout */ }
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`codex binary not found (tried ${candidates.join(", ")})`);
  return found;
}

function setup() {
  for (const d of [PROJECT, BIN, path.join(SRC_SKILLS, SKILL), MCODE]) mkdirSync(d, { recursive: true });
  const skillMd = `---\nname: ${SKILL}\ndescription: Marker skill that verifies MarioCode skill sync loading.\n---\nReply with MC-SYNC-MARKER-OK.\n`;
  writeFileSync(path.join(SRC_SKILLS, SKILL, "SKILL.md"), skillMd);

  const server = path.join(T, "mcp-server.mjs");
  writeFileSync(server, `
import readline from "node:readline";
const variant = process.argv[2] || "x";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mcsync-" + variant, version: "1.0.0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo_" + variant, description: "marker tool", inputSchema: { type: "object", properties: {} } }] } });
  else if (m.method === "ping") send({ jsonrpc: "2.0", id: m.id, result: {} });
  else send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
});
`);
  // A launcher shim on PATH — the shape `npx` has on Windows (npx.cmd), the
  // most common command in synced Cursor / Claude configs.
  if (win) {
    writeFileSync(path.join(BIN, "mcmarker.cmd"), `@node "%~dp0..\\mcp-server.mjs" %*\r\n`);
  } else {
    writeFileSync(path.join(BIN, "mcmarker"), `#!/bin/sh\nexec node "$(dirname "$0")/../mcp-server.mjs" "$@"\n`);
    chmodSync(path.join(BIN, "mcmarker"), 0o755);
  }
  const servers = {
    mcsync_node: { command: "node", args: [server, "node"] },
    mcsync_shim: { command: "mcmarker", args: ["shim"] },
  };
  writeFileSync(path.join(MCODE, ".claude.json"), JSON.stringify({ mcpServers: servers }, null, 2));

  const hash = createHash("sha1").update(path.resolve(SRC_SKILLS).toLowerCase()).digest("hex").slice(0, 10);
  const id = `${path.basename(SRC_SKILLS).replace(/[^\w.-]/g, "_").slice(0, 24)}-${hash}`;
  const mirror = path.join(MCODE, "skills-sync", id);
  mkdirSync(path.join(mirror, SKILL), { recursive: true });
  writeFileSync(path.join(mirror, SKILL, "SKILL.md"), skillMd);
  const pluginName = `mcode-sync-${id.replace(/[^\w.-]/g, "-").toLowerCase()}`;
  const pluginDir = path.join(MCODE, "skills-sync-plugins", pluginName);
  mkdirSync(path.join(pluginDir, "skills", SKILL), { recursive: true });
  mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(pluginDir, "skills", SKILL, "SKILL.md"), skillMd);
  writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: pluginName, version: "0.0.0", description: "Synced skills" }));

  const tomlStr = (v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\x00-\x1f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
  const toml = ["# Generated by Mcode", ""];
  for (const [name, cfg] of Object.entries(servers)) {
    toml.push(`[mcp_servers.${name}]`, `command = ${tomlStr(cfg.command)}`, `args = [${cfg.args.map(tomlStr).join(", ")}]`, "");
  }
  mkdirSync(path.join(MCODE, "codex"), { recursive: true });
  writeFileSync(path.join(MCODE, "codex", "config.toml"), toml.join("\n"));
  return { mirror, pluginDir, pluginName, servers: Object.keys(servers) };
}

const childEnv = () => ({ ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what} timed out`); })]);

async function checkClaude(fx) {
  const { query } = await import(pathToFileURL(require.resolve("@anthropic-ai/claude-agent-sdk")).href);
  let release;
  const hold = new Promise((r) => (release = r));
  const abortController = new AbortController();
  // Same shape as ClaudeAgentSdkProvider: CLAUDE_CONFIG_DIR=~/.mcode (user
  // MCP servers load from its .claude.json) + one local plugin per sync source.
  const q = query({
    prompt: (async function* () { await hold; })(),
    options: {
      cwd: PROJECT,
      env: { ...childEnv(), CLAUDE_CONFIG_DIR: MCODE },
      plugins: [{ type: "local", path: fx.pluginDir, skipMcpDiscovery: true }],
      abortController,
    },
  });
  try {
    const commands = await withTimeout(q.supportedCommands(), 60_000, "supportedCommands");
    const skill = commands.map((c) => c.name).find((n) => n === `${fx.pluginName}:${SKILL}`);
    check("Claude loads the synced skill plugin", !!skill, skill);
    let status = [];
    for (let i = 0; i < 40; i++) {
      status = await withTimeout(q.mcpServerStatus(), 30_000, "mcpServerStatus");
      if (status.length && status.every((s) => s.status !== "pending")) break;
      await sleep(500);
    }
    for (const name of fx.servers) {
      const s = status.find((x) => x.name === name);
      check(`Claude connects synced MCP server ${name}`, s?.status === "connected" && (s.tools?.length ?? 0) > 0, s ? `${s.status} ${JSON.stringify((s.tools ?? []).map((t) => t.name))}` : "absent");
    }
  } finally {
    release();
    abortController.abort();
  }
}

async function checkCodex(fx) {
  // Same shape as CodexAgentSdkProvider: CODEX_HOME=~/.mcode/codex with the
  // materialized config.toml, mirror roots via skills/extraRoots/set.
  const child = spawn(codexBinary(), ["app-server"], { cwd: PROJECT, env: { ...childEnv(), CODEX_HOME: path.join(MCODE, "codex") }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let buf = "";
  let next = 1;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const p = msg.id !== undefined && !msg.method ? pending.get(msg.id) : undefined;
      if (!p) continue;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  });
  child.stderr.resume();
  const rpc = (method, params) => withTimeout(new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  }), 60_000, method);
  try {
    await rpc("initialize", { clientInfo: { name: "sync-load-smoke", title: "sync-load-smoke", version: "0.0.0" }, capabilities: { experimentalApi: true } });
    await rpc("skills/extraRoots/set", { extraRoots: [fx.mirror] });
    const skills = JSON.stringify(await rpc("skills/list", { cwds: [PROJECT], forceReload: true }));
    check("Codex lists the synced skill", skills.includes(`"name":"${SKILL}"`));
    let rows = [];
    for (let i = 0; i < 40; i++) {
      const st = await rpc("mcpServerStatus/list", {});
      rows = st?.data ?? [];
      if (fx.servers.every((n) => rows.some((r) => r.name === n && Object.keys(r.tools ?? {}).length > 0))) break;
      await sleep(500);
    }
    for (const name of fx.servers) {
      const r = rows.find((x) => x.name === name);
      check(`Codex starts synced MCP server ${name}`, !!r && Object.keys(r.tools ?? {}).length > 0, r ? JSON.stringify(Object.keys(r.tools ?? {})) : "absent");
    }
  } finally {
    const exited = new Promise((r) => child.once("exit", r));
    child.kill();
    await withTimeout(exited, 5_000, "codex exit").catch(() => {});
  }
}

async function checkPi(fx) {
  // The package's exports map hides package.json, so go by the install dir
  // (same lookup as scripts/test-pi-host.mjs).
  const pkgDir = path.join(desktop, "node_modules", "@earendil-works", "pi-coding-agent");
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const root = pkg.exports?.["."];
  const rel = typeof root === "string" ? root : root?.import || root?.default || "dist/index.js";
  const sdk = await import(pathToFileURL(path.join(pkgDir, rel)).href);
  const agentDir = path.join(T, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  // Same shape as buildPiSkillLoader: mirrors arrive as extraSkillPaths.
  const loader = new sdk.DefaultResourceLoader({ cwd: PROJECT, agentDir, extensionFactories: [], additionalSkillPaths: [fx.mirror] });
  await loader.reload();
  const hit = loader.getSkills().skills.find((s) => s.name === SKILL);
  check("Pi loads the synced skill from its mirror", !!hit, hit?.filePath);
}

try {
  const fx = setup();
  for (const [name, fn] of [["claude", checkClaude], ["codex", checkCodex], ["pi", checkPi]]) {
    try { await fn(fx); } catch (e) { check(`${name} check ran`, false, e instanceof Error ? e.message : String(e)); }
  }
} finally {
  // Engine-spawned MCP servers can hold the dir for a moment after their parent exits.
  await sleep(1_000);
  try {
    rmSync(T, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (e) {
    console.warn(`(temp dir left behind: ${T} — ${e instanceof Error ? e.message : e})`);
  }
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
