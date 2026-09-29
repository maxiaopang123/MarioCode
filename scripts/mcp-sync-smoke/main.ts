/**
 * Standalone Electron driver for the REAL MCP IPC handler file. Own userData
 * dir so it does not contend with the running dev app. Boots: initDb ->
 * registerMcpHandlers -> hidden window with the REAL compiled preload ->
 * drives window.api.mcp.* exactly like the settings panel does.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { initDb, awaitDb } from "@main/store/db.js";
import { registerMcpHandlers } from "@main/ipc/mcp.js";

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mariocode-mcp-smoke-"));
  // Keep the smoke run completely isolated from the user's real ~/.mariocode and
  // from a concurrently running MarioCode instance. Both os.homedir() and
  // the provider config helpers resolve these environment variables lazily.
  process.env.USERPROFILE = userData;
  process.env.HOME = userData;
  app.setPath("userData", userData);
  await app.whenReady();

  await initDb();
  await awaitDb();
  registerMcpHandlers(ipcMain);

  const preload = path.resolve(process.cwd(), "out/preload/index.mjs");
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    process.stderr.write(`[preload-error] ${preloadPath}: ${error.stack || error.message}\n`);
  });
  await win.loadURL("data:text/html,<title>smoke</title>");

  win.webContents.on("console-message", (_e, _l, msg) =>
    process.stdout.write("[renderer] " + msg + "\n"));

  const target = path.join(os.homedir(), ".mariocode", ".claude.json");
  const codexFile = path.join(os.homedir(), ".codex", "config.toml");
  const cursorFile = path.join(os.homedir(), ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(codexFile, [
    "[mcp_servers.node_repl]",
    'command = "node"',
    'args = ["-e", "console.log(1)"]',
    "",
  ].join("\n"));
  fs.writeFileSync(cursorFile, JSON.stringify({
    mcpServers: {
      "cursor-fixture": { command: "node", args: ["-e", "console.log(2)"] },
    },
  }, null, 2));

  // Phase-by-phase, so main can assert the mirrored file after each step.
  const js = (body: string) => win.webContents.executeJavaScript(`(async () => { const mcp = window.api.mcp; ${body} })()`);
  const servers = () => {
    try { return Object.keys(JSON.parse(fs.readFileSync(target, "utf8")).mcpServers || {}); }
    catch (e) { return "READ_ERR:" + String(e); }
  };
  const r: Record<string, unknown> = {};
  r.serversBefore = servers();

  const waitFor = async (fn: () => unknown, want: (v: unknown) => boolean, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (want(v)) return v;
      if (Date.now() - t0 > ms) return v;
      await new Promise((r2) => setTimeout(r2, 120));
    }
  };

  r.addCodex = await js(`return mcp.syncAdd({ kind: "codex", file: ${JSON.stringify(codexFile)} });`);
  await js(`return mcp.syncRescan({});`);
  r.serversAfterCodex = await waitFor(servers, (v) => Array.isArray(v) && (v as string[]).length > 0);

  r.addCursor = await js(`return mcp.syncAdd({ kind: "cursor", file: ${JSON.stringify(cursorFile)} });`);
  await js(`return mcp.syncRescan({});`);
  r.serversAfterCursor = await waitFor(servers, (v) => Array.isArray(v) && (v as string[]).length >= 2);
  r.listAfterAdd = await js(`return (await mcp.syncList({})).sources.map((s) => ({ kind: s.kind, enabled: s.enabled, servers: s.status.serverCount, err: s.status.lastError || null }));`);

  const codexId = (r.addCodex as { id?: string }).id ?? null;
  r.codexId = codexId;
  if (codexId) {
    const codexNames = r.serversAfterCodex as string[];
    await js(`return mcp.syncSetEnabled({ id: ${JSON.stringify(codexId)}, enabled: false });`);
    r.serversAfterDisable = await waitFor(servers, (v) => Array.isArray(v) && !(v as string[]).some((n) => codexNames.includes(n)));
    await js(`return mcp.syncSetEnabled({ id: ${JSON.stringify(codexId)}, enabled: true });`);
    await js(`return mcp.syncRescan({});`);
    r.serversAfterReenable = await waitFor(servers, (v) => Array.isArray(v) && (v as string[]).some((n) => codexNames.includes(n)));
    await js(`return mcp.syncRemove({ id: ${JSON.stringify(codexId)} });`);
    r.serversAfterRemove = await waitFor(servers, (v) => Array.isArray(v) && !(v as string[]).some((n) => codexNames.includes(n)));
    r.listFinal = await js(`return (await mcp.syncList({})).sources.map((s) => ({ kind: s.kind, enabled: s.enabled }));`);
  }
  // Cleanup: remove every remaining source so the real target file returns to
  // its pre-smoke state (no leftover mirrored entries for the user's app).
  const remaining = await js(`return (await mcp.syncList({})).sources.map((s) => s.id);`);
  for (const id of remaining as string[]) {
    await js(`return mcp.syncRemove({ id: ${JSON.stringify(id)} });`);
  }
  r.serversAfterCleanup = await waitFor(servers, (v) => Array.isArray(v) && (v as string[]).length === 0);
  const includes = (value: unknown, name: string): boolean =>
    Array.isArray(value) && value.includes(name);
  const excludes = (value: unknown, name: string): boolean =>
    Array.isArray(value) && !value.includes(name);
  const checks: Record<string, boolean> = {
    codexMirrored: includes(r.serversAfterCodex, "node_repl"),
    bothSourcesCoexist: includes(r.serversAfterCursor, "node_repl") && includes(r.serversAfterCursor, "cursor-fixture"),
    disableRetractsOnlyCodex: excludes(r.serversAfterDisable, "node_repl") && includes(r.serversAfterDisable, "cursor-fixture"),
    reenablePreservesCursor: includes(r.serversAfterReenable, "node_repl") && includes(r.serversAfterReenable, "cursor-fixture"),
    removeRetractsOnlyCodex: excludes(r.serversAfterRemove, "node_repl") && includes(r.serversAfterRemove, "cursor-fixture"),
    cleanupLeavesMirrorEmpty: Array.isArray(r.serversAfterCleanup) && (r.serversAfterCleanup as string[]).length === 0,
  };
  const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  if (failedChecks.length > 0) {
    throw new Error(`MCP smoke checks failed: ${failedChecks.join(", ")}`);
  }
  r.checks = checks;
  const out = r;

  process.stdout.write("SMOKE_RESULT=" + JSON.stringify(out) + "\n");
  app.exit(0);
}

main().catch((err) => {
  process.stdout.write("SMOKE_FATAL=" + String((err && err.stack) || err) + "\n");
  app.exit(1);
});
