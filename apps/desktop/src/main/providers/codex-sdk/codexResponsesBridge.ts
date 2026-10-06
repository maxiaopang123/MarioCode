import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { engineFetch } from "@main/network/engineProxy.js";
import { resolveUpstreamHeaders } from "@main/providers/upstreamHeaders.js";
import { CodexResponsesStream, translateCodexRequest, type CodexUpstreamProtocol } from "./codexResponsesTranslation.js";

export interface CodexResponsesBridgeConfig {
  protocol: CodexUpstreamProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  sessionId: string;
  customHeaders?: Record<string, string>;
}
export interface CodexResponsesBridgeHandle {
  localUrl: string;
  routeToken: string;
  close(): void;
}

export function codexUpstreamUrl(base: string, protocol: CodexUpstreamProtocol): string {
  const url = new URL(base);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Codex upstream must use HTTP(S)");
  let pathname = url.pathname.replace(/\/+$/, "");
  const suffix = protocol === "anthropic" ? "/messages" : "/chat/completions";
  if (!pathname.endsWith(suffix)) {
    if (!pathname.endsWith("/v1") && !pathname.includes("/openai/deployments/")) pathname += "/v1";
    pathname += suffix;
  }
  url.pathname = pathname;
  if (/\.azure\.com$/i.test(url.hostname) && !url.searchParams.has("api-version")) url.searchParams.set("api-version", "2024-10-21");
  return url.toString();
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const value of req) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += buffer.length;
    if (size > 32 * 1024 * 1024) throw new Error("Codex bridge request exceeds 32 MB");
    buffers.push(buffer);
  }
  return JSON.parse(Buffer.concat(buffers).toString("utf8")) as unknown;
}
function errorResponse(res: ServerResponse, status: number, error: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { type: "codex_bridge_error", message: error instanceof Error ? error.message : String(error) } }));
}

/** Per-turn, authenticated loopback Responses endpoint; no keys or routes are persisted. */
export async function startCodexResponsesBridge(config: CodexResponsesBridgeConfig, fetchUpstream: typeof engineFetch = engineFetch): Promise<CodexResponsesBridgeHandle> {
  const upstreamUrl = codexUpstreamUrl(config.baseUrl, config.protocol);
  const routeToken = randomBytes(24).toString("hex");
  const active = new Set<AbortController>();
  const sockets = new Set<Socket>();
  let closed = false;
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.authorization !== `Bearer ${routeToken}`) { errorResponse(res, 401, new Error("Invalid Codex bridge credential")); return; }
    const pathname = (req.url ?? "").split("?", 1)[0];
    if (pathname.endsWith("/responses/compact")) {
      errorResponse(res, 400, new Error("Remote Responses compaction is not supported by the Chat/Messages bridge; no fabricated compaction is returned")); return;
    }
    if (req.method !== "POST" || !["/responses", "/v1/responses"].includes(pathname)) { errorResponse(res, 404, new Error("Unsupported Codex bridge route")); return; }
    const ac = new AbortController();
    active.add(ac);
    const timer = setTimeout(() => ac.abort(new Error("Codex upstream request timed out")), config.timeoutMs ?? 300_000);
    timer.unref();
    const disconnect = () => { if (!res.writableEnded) ac.abort(new Error("Codex client disconnected")); };
    req.once("aborted", disconnect);
    res.once("close", disconnect);
    let translator: CodexResponsesStream | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const translated = translateCodexRequest(await readBody(req), config.protocol, config.model, config.maxTokens);
      ac.signal.throwIfAborted();
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
      if (config.protocol === "anthropic") { headers["x-api-key"] = config.apiKey; headers["anthropic-version"] = "2023-06-01"; }
      else if (/\.azure\.com$/i.test(new URL(upstreamUrl).hostname)) headers["api-key"] = config.apiKey;
      else headers.Authorization = `Bearer ${config.apiKey}`;
      Object.assign(headers, resolveUpstreamHeaders(config.customHeaders, config.baseUrl, config.sessionId));
      const response = await fetchUpstream(upstreamUrl, { method: "POST", headers, body: JSON.stringify(translated.body), signal: ac.signal });
      if (!response.ok) throw new Error(`Codex upstream returned HTTP ${response.status}`);
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Codex upstream did not return an SSE stream");
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      translator = new CodexResponsesStream(config.protocol, config.model, translated.customTools, (event) => {
        if (!res.destroyed) res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      translator.start();
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const frame = (text: string) => {
        const lines = text.split(/\r?\n/);
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        if (data) translator!.feed(data, event);
      };
      const drain = () => {
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          frame(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
        }
        if (buffer.length > 8 * 1024 * 1024) throw new Error("Codex upstream SSE frame exceeds 8 MB");
      };
      for (;;) {
        ac.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }); drain();
      }
      buffer += decoder.decode(); drain();
      if (buffer.trim()) frame(buffer);
      ac.signal.throwIfAborted();
      translator.finish();
      res.end();
    } catch (error) {
      if (translator && !res.destroyed) { translator.fail(ac.signal.aborted ? ac.signal.reason : error); res.end(); }
      else if (!res.headersSent) errorResponse(res, 502, ac.signal.aborted ? ac.signal.reason : error);
      else res.destroy();
    } finally {
      clearTimeout(timer);
      ac.abort();
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      req.off("aborted", disconnect); res.off("close", disconnect);
      active.delete(ac);
    }
  };
  const server = createServer((req, res) => { void handle(req, res).catch((error: unknown) => errorResponse(res, 500, error)); });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("Could not bind Codex bridge")); }
      else resolve(address.port);
    });
  });
  return {
    localUrl: `http://127.0.0.1:${port}/v1`, routeToken,
    close: () => {
      if (closed) return;
      closed = true;
      for (const ac of active) ac.abort(new Error("Codex turn ended"));
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
