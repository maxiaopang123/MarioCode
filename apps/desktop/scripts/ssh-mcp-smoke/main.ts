import assert from "node:assert/strict";
import { app } from "electron";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startSshFixture } from "../ssh-fixture.mjs";
import { initDb, closeDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories.js";
import { observeSshFingerprint, saveSshHost, sshCatalogState, removeSshHost } from "@main/mcp/sshStore.js";
import { syncSshCatalog } from "@main/mcp/sshCatalog.js";
import { bindSshTurn, stopSshBroker } from "@main/mcp/sshBroker.js";
import { McpToolSession } from "@main/mcp/McpToolSession.js";
import { executeSsh } from "@main/mcp/sshConnection.js";
import { readUserClaudeJson, writeUserClaudeJson } from "@main/lib/mcpConfig.js";
import { markBackgroundTurnStart, markBackgroundTurnEnd } from "@main/lib/backgroundTurnTracker.js";
import { ApprovalBridge } from "@main/claude/ApprovalBridge.js";
import type { ProviderContext, ApprovalRequest } from "@contracts/provider";
import { SSH_MCP_SERVER_NAME } from "@contracts/ssh";
app.setPath("userData", process.env.SSH_TEST_DATA!);
const desktop = process.env.SSH_TEST_DESKTOP!;
let count = 0;
function pass(name: string) { console.log(`PASS ${++count}: ${name}`); }
function genericServer() {
  const server = new Server({ name: "http-fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }));
  server.setRequestHandler(CallToolRequestSchema, async req => ({ content: [{ type: "text", text: String(req.params.arguments?.text) }] }));
  return server;
}
async function main() {
await app.whenReady(); await initDb();
const fixture = await startSshFixture();
const transports: Array<StreamableHTTPServerTransport | SSEServerTransport> = [];
const http = createServer(async (req, res) => {
  try {
    if (req.url === "/sse" && req.method === "GET") { const transport = new SSEServerTransport("/messages", res); transports.push(transport); await genericServer().connect(transport); }
    else if (req.url?.startsWith("/messages")) { const transport = transports.find(t => t instanceof SSEServerTransport && req.url!.includes(t.sessionId)); if (!(transport instanceof SSEServerTransport)) { res.writeHead(404); res.end(); } else await transport.handlePostMessage(req, res); }
    else { const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }); transports.push(transport); await genericServer().connect(transport); await transport.handleRequest(req, res); }
  } catch { res.writeHead(500); res.end(); }
});
await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
const httpPort = (http.address() as { port: number }).port;
const approvalRequests: ApprovalRequest[] = []; let allow = true;
const sessionId = randomUUID();
const ctx: ProviderContext = { emit: () => {}, log: { info: () => {}, warn: console.warn, error: console.error }, getPermissionMode: () => "bypassPermissions", isToolAlwaysAllowed: () => true,
  requestApproval: async req => { approvalRequests.push(req); return { allow, persist: true }; } };
let binding: Awaited<ReturnType<typeof bindSshTurn>> | undefined;
let mcp: McpToolSession | undefined;
try {
  assert.equal(sshCatalogState().enabled, false); pass("catalog disabled by default");
  const address = { host: "127.0.0.1", port: fixture.port };
  const observed = await observeSshFingerprint(address);
  assert.equal(observed.fingerprint, fixture.fingerprint); assert.equal(fixture.authentications.length, 0); pass("probe reads host key before authentication");
  assert.throws(() => saveSshHost({ ...address, alias: "test", username: "fixture", authentication: "password", fingerprint: `SHA256:${"A".repeat(43)}`, password: "ssh-test-password" }), /SSH_CONFIRM_FINGERPRINT/);
  saveSshHost({ ...address, alias: "test", username: "fixture", authentication: "password", fingerprint: observed.fingerprint, password: "ssh-test-password" });
  const host = sshCatalogState().hosts[0]!;
  assert.ok(host.hasCredential); assert.ok(!JSON.stringify(sshCatalogState()).includes("ssh-test-password"));
  assert.ok(!SettingRepo.get("mcp.catalog.ssh.keys")!.includes("ssh-test-password")); pass("credentials encrypted and excluded from public state");
  await writeUserClaudeJson({ preserved: "yes", mcpServers: {} });
  await syncSshCatalog(true);
  const config = await readUserClaudeJson(); assert.equal(config.preserved, "yes"); assert.ok(JSON.stringify(config).includes(SSH_MCP_SERVER_NAME)); assert.ok(!JSON.stringify(config).includes("ssh-test-password")); pass("enable preserves config and excludes secrets");
  binding = await bindSshTurn(sessionId, ctx);
  const serverConfig = await readUserClaudeJson();
  const fixtureScript = join(desktop, "scripts/ssh-mcp-smoke/stdio-fixture.mjs");
  const launcher = join(process.env.SSH_TEST_DATA!, "fixture launcher.cmd");
  await writeFile(launcher, `@echo off\r\n"${process.execPath}" %*\r\n`);
  await writeUserClaudeJson({ ...serverConfig, mcpServers: { ...(serverConfig.mcpServers as object), stdio: { command: process.platform === "win32" ? launcher : process.execPath, args: [fixtureScript], env: { ELECTRON_RUN_AS_NODE: "1" } }, http: { type: "http", url: `http://127.0.0.1:${httpPort}/mcp` }, sse: { type: "sse", url: `http://127.0.0.1:${httpPort}/sse` } } });
  await writeFile(join(process.env.SSH_TEST_DATA!, ".mcp.json"), JSON.stringify({ mcpServers: { project: { command: process.execPath, args: [fixtureScript], env: { ELECTRON_RUN_AS_NODE: "1" } } } }));
  SettingRepo.set("mcp.management", JSON.stringify({ projectEnabled: [{ projectPath: process.env.SSH_TEST_DATA!, name: "project" }] }));
  mcp = await McpToolSession.connect(process.env.SSH_TEST_DATA!, ctx, binding.env);
  assert.equal(mcp.specs.length, 6, JSON.stringify(mcp.specs));
  for (const name of ["stdio", "http", "sse", "project"]) {
    const result = await mcp.invoke(`mcp__${name}__echo`, { text: "hello" });
    assert.ok(result.content.some(b => b.type === "text" && b.text.includes("hello")));
    if (name === "stdio") assert.equal(JSON.parse((result.content[0] as { text: string }).text).leakedSshToken, false);
  } pass("Pi MCP stdio (.cmd), HTTP, SSE and allowed project tools; scoped secrets");
  const prefix = `mcp__${SSH_MCP_SERVER_NAME}__`;
  const listed = await mcp.invoke(prefix + "ssh_hosts", {}); assert.ok(JSON.stringify(listed).includes("test")); assert.equal(approvalRequests.length, 0); pass("host listing is read-only");
  const result = await mcp.invoke(prefix + "ssh_exec", { host: "test", command: "uptime" }); assert.ok(JSON.stringify(result).includes("executed: uptime")); assert.equal(approvalRequests.length, 1); assert.equal(approvalRequests[0]!.oneShotOnly, true);
  await mcp.invoke(prefix + "ssh_exec", { host: "test", command: "pwd" }); assert.equal(approvalRequests.length, 2); pass("each command requires approval even with bypass and always-allow");
  const bridge = new ApprovalBridge(); const handler = bridge.makeApprovalHandler(sessionId, () => {}); const id = randomUUID(); const pending = handler({ requestId: id, toolName: "ssh_exec", input: {}, oneShotOnly: true }); bridge.resolveApproval(id, { allow: true, persist: true }, true); assert.equal((await pending).persist, false); assert.equal(bridge.isAlwaysAllowed(sessionId, "ssh_exec"), false); pass("one-shot approval cannot become a persistent grant");
  allow = false; const before = fixture.commands.length; const denied = await mcp.invoke(prefix + "ssh_exec", { host: "test", command: "denied" }); assert.equal(denied.isError, true); assert.equal(fixture.commands.length, before); allow = true; pass("denied command never reaches SSH server");
  markBackgroundTurnStart(sessionId); const unattended = await mcp.invoke(prefix + "ssh_exec", { host: "test", command: "unattended" }); markBackgroundTurnEnd(sessionId); assert.ok(JSON.stringify(unattended).includes("SSH_UNATTENDED_DENIED")); assert.equal(fixture.commands.length, before); pass("unattended commands blocked before approval");
  await assert.rejects(executeSsh({ ...host, fingerprint: `SHA256:${"A".repeat(43)}` }, { password: "ssh-test-password" }, { host: "test", command: "wrong-pin", timeoutSec: 2 }, new AbortController().signal), /SSH_FINGERPRINT_CHANGED/); assert.equal(fixture.commands.length, before); pass("changed fingerprint rejected before authentication and command");
  const large = await executeSsh(host, { password: "ssh-test-password" }, { host: "test", command: "large", timeoutSec: 2 }, new AbortController().signal); assert.equal(large.truncated, true); assert.equal(Buffer.byteLength(large.stdout) + Buffer.byteLength(large.stderr), 65536);
  const fail = await executeSsh(host, { privateKey: fixture.privateKey }, { host: "test", command: "fail", timeoutSec: 2 }, new AbortController().signal); assert.equal(fail.exitCode, 7); assert.ok(fail.stderr.includes("fixture stderr")); pass("password/private-key authentication, exit code, stderr and output limit");
  await assert.rejects(executeSsh(host, { password: "ssh-test-password" }, { host: "test", command: "hang", timeoutSec: 1 }, new AbortController().signal), /SSH_TIMEOUT/);
  const abort = new AbortController(); const hanging = executeSsh(host, { password: "ssh-test-password" }, { host: "test", command: "hang", timeoutSec: 10 }, abort.signal); setTimeout(() => abort.abort(), 100); await assert.rejects(hanging, /SSH_CANCELLED/); pass("timeout and cancellation close command connections");
  binding.dispose(); const revoked = await mcp.invoke(prefix + "ssh_exec", { host: "test", command: "revoked" }); assert.equal(revoked.isError, true); pass("turn capability revoked after stop");
  await mcp.close(); mcp = undefined;
  SettingRepo.set("mcp.management", JSON.stringify({ userDisabled: { stdio: {} }, projectEnabled: [] }));
  await syncSshCatalog(false); mcp = await McpToolSession.connect(process.env.SSH_TEST_DATA!, ctx, {}); assert.equal(mcp.specs.length, 2); pass("disabled user/project/catalog tools omitted next turn");
  const disabledCfg = await readUserClaudeJson(); assert.equal(disabledCfg.preserved, "yes"); assert.ok(!(SSH_MCP_SERVER_NAME in (disabledCfg.mcpServers as object)));
  removeSshHost(host.id); assert.equal(sshCatalogState().hosts.length, 0); assert.equal(SettingRepo.get("mcp.catalog.ssh.keys"), "{}"); pass("disable and delete remove catalog entry and encrypted credential");
  console.log(`SSH/MCP smoke passed: ${count} checks`);
} catch (error) { console.error(error); process.exitCode = 1; }
finally { binding?.dispose(); await mcp?.close(); stopSshBroker(); for (const transport of transports) await transport.close().catch(() => {}); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await fixture.close(); closeDb(); app.exit(process.exitCode ?? 0); }
}
void main().catch(error => { console.error(error); app.exit(1); });
