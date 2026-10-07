import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "@contracts/ipc";
import type { McpToolSpec, McpToolResult } from "@contracts/mcpTool";
import { SSH_MCP_SERVER_NAME } from "@contracts/ssh";
import { getMcpManagement, readUserClaudeJson, readProjectMcpServers, mcpServersOf, parseMcpConfig } from "@main/lib/mcpConfig.js";
import { samePath } from "@main/lib/pathGuard.js";
import { engineFetch, withEngineNetworkEnv } from "@main/network/engineProxy.js";
import type { ProviderContext } from "@contracts/provider";

/** One turn owns all clients. Only listed names can be invoked by the Pi host. */
export class McpToolSession {
  readonly specs: McpToolSpec[] = [];
  private clients = new Set<Client>();
  private tools = new Map<string, { client: Client; remoteName: string; timeout: number }>();
  private controller = new AbortController();

  static async connect(cwd: string, ctx: ProviderContext, sshEnv: Record<string, string>): Promise<McpToolSession> {
    const session = new McpToolSession();
    const management = await getMcpManagement();
    const servers = { ...mcpServersOf(await readUserClaudeJson()) };
    const allowed = new Set((management.projectEnabled ?? []).filter(e => samePath(e.projectPath, cwd)).map(e => e.name));
    for (const [name, raw] of Object.entries(await readProjectMcpServers(cwd))) {
      if (allowed.has(name) && name !== SSH_MCP_SERVER_NAME) servers[name] = raw;
    }
    // Config is already opt-in. Bound startup concurrency avoids spawning an
    // arbitrary number of local processes simultaneously.
    const entries = Object.entries(servers).filter(([name]) => !management.userDisabled?.[name]);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, entries.length) }, async () => {
      while (next < entries.length) {
        const [name, raw] = entries[next++]!;
        const config = parseMcpConfig(raw);
        if (!config || !/^[A-Za-z0-9_-]+$/.test(name)) continue;
        if (name === SSH_MCP_SERVER_NAME && (config["x-mariocode-catalog"] !== "ssh" || !sshEnv.MARIOCODE_MCP_SESSION_TOKEN)) continue;
        try { await session.add(name, config, cwd, name === SSH_MCP_SERVER_NAME ? sshEnv : {}); }
        catch { ctx.log.warn(`MCP connection failed: ${name}`); }
      }
    }));
    return session;
  }

  private async add(name: string, config: McpServerConfig, cwd: string, scopedEnv: Record<string, string>): Promise<void> {
    const client = new Client({ name: "MarioCode-Pi", version: "1.0.0" });
    this.clients.add(client);
    let transport: Transport;
    if (config.type === "http" || config.type === "sse") {
      const options = { requestInit: { headers: config.headers }, fetch: (url: string | URL | Request, init?: RequestInit) => engineFetch(typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url, init ?? {}) };
      transport = config.type === "http" ? new StreamableHTTPClientTransport(new URL(config.url), options) : new SSEClientTransport(new URL(config.url), options);
    } else {
      const inherited = getDefaultEnvironment();
      if (Array.isArray(config.env_vars)) for (const key of config.env_vars) {
        if (typeof key === "string" && process.env[key] !== undefined && !key.startsWith("MARIOCODE_MCP_") && key !== "MARIOCODE_SSH_BROKER_URL") inherited[key] = process.env[key]!;
      }
      const stdio = new StdioClientTransport({ command: config.command, args: config.args,
        env: await withEngineNetworkEnv({ ...inherited, ...config.env, ...scopedEnv }), cwd, stderr: "pipe" });
      // Do not echo server stderr: it may contain credential-bearing configs.
      stdio.stderr?.on("data", () => {});
      transport = stdio;
    }
    try {
      const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(12_000)]);
      await client.connect(transport, { timeout: 12_000, signal });
      let cursor: string | undefined;
      const listed: McpToolSpec[] = [];
      const timeout = typeof config.tool_timeout_sec === "number" ? Math.max(1000, Math.min(600_000, config.tool_timeout_sec * 1000)) : 60_000;
      do {
        const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 12_000, signal });
        for (const tool of result.tools) {
          if (!/^[A-Za-z0-9_-]+$/.test(tool.name) || listed.length >= 100) continue;
          const canonical = `mcp__${name}__${tool.name}`;
          if (this.tools.has(canonical) || listed.some(s => s.name === canonical)) continue;
          listed.push({ name: canonical, label: `${name} · ${tool.title ?? tool.name}`, description: tool.description ?? `${name}: ${tool.name}`, inputSchema: tool.inputSchema });
        }
        cursor = result.nextCursor;
      } while (cursor && listed.length < 100);
      for (const spec of listed) {
        this.tools.set(spec.name, { client, remoteName: spec.name.slice(`mcp__${name}__`.length), timeout });
        this.specs.push(spec);
      }
    } catch (error) {
      this.clients.delete(client);
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw error;
    }
  }

  async invoke(name: string, args: unknown): Promise<McpToolResult> {
    const tool = this.tools.get(name);
    if (!tool || this.controller.signal.aborted) throw new Error("MCP tool is unavailable for this turn");
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid MCP arguments");
    const result = await tool.client.callTool({ name: tool.remoteName, arguments: args as Record<string, unknown> }, undefined, { timeout: tool.timeout, signal: this.controller.signal });
    const blocks = "content" in result && Array.isArray(result.content) ? result.content : [];
    const content: McpToolResult["content"] = blocks.map(block => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "image") return { type: "image", data: block.data, mimeType: block.mimeType };
      return { type: "text", text: JSON.stringify(block) };
    });
    if (!content.length && "structuredContent" in result) content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
    return { content, isError: result.isError === true };
  }

  async close(): Promise<void> {
    this.controller.abort(); this.tools.clear();
    await Promise.allSettled([...this.clients].map(client => client.close()));
    this.clients.clear();
  }
}

const turns = new Map<string, McpToolSession>();
export function registerMcpTurn(turnId: string, session: McpToolSession): void { turns.set(turnId, session); }
export async function invokeMcpTurn(turnId: string, name: string, args: unknown): Promise<McpToolResult> {
  const session = turns.get(turnId);
  if (!session) throw new Error("MCP turn is no longer active");
  return session.invoke(name, args);
}
export async function closeMcpTurn(turnId: string): Promise<void> {
  const session = turns.get(turnId); turns.delete(turnId); await session?.close();
}
