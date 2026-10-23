import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { engineFetch } from "@main/network/engineProxy.js";
import { SseDecoder } from "@main/providers/bridge/sseDecoder.js";
import { resolveUpstreamHeaders } from "@main/providers/upstreamHeaders.js";
import { CodexResponsesStream, translateCodexRequest, type CodexUpstreamProtocol } from "./codexResponsesTranslation.js";

export interface CodexResponsesBridgeConfig {
  protocol: CodexUpstreamProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  /** Absolute ceiling for one `/responses` call (default 12h). This is NOT an
   *  idle timeout — see the deadline policy above. */
  timeoutMs?: number;
  /** Overrides for the silence watchdogs; tests use these to run in ms. */
  idleTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  sessionId: string;
  customHeaders?: Record<string, string>;
}
export interface CodexResponsesBridgeHandle {
  localUrl: string;
  routeToken: string;
  close(): void;
}

/** Hosted Responses web_search cannot execute on Chat/Messages; MarioTool remains available. */
export const CODEX_BRIDGE_CONFIG_ARGS = ["-c", 'web_search="disabled"'] as const;

/* ── Deadline policy ──────────────────────────────────────────────────────
 * This bridge translates Codex's Responses calls into a third-party gateway's
 * Chat/Messages protocol, so the deadline is ours to choose — the gateway's
 * own HTTP timeout does not apply to the loopback hop Codex sees.
 *
 * A fixed TOTAL deadline is the wrong shape for a streaming turn: a healthy
 * reply that streams a long file can legitimately run past any per-request
 * budget, and aborting mid-stream turns a slow success into an error. What
 * actually needs bounding is SILENCE — how long the upstream may send nothing
 * at all. (Before this policy the budget was a flat 5 minutes per request,
 * which killed long-but-healthy turns with "Codex upstream request timed out".)
 *
 * Three bounds, checked by two timers:
 *   • first byte — the gateway's queueing + prompt prefill live here, so this
 *     one gets a larger budget than a mid-stream gap;
 *   • idle — re-armed on every byte received, including bare SSE comments;
 *   • absolute — never re-armed, and exists precisely because idle re-arms on
 *     heartbeats: an upstream that pings forever without ever sending a token
 *     would otherwise hold the request open indefinitely.
 */
/** Longest the gateway may stay silent once it has started streaming. */
export const CODEX_BRIDGE_IDLE_TIMEOUT_MS = 120_000;
/** Longest the gateway has to produce its first byte at all. */
export const CODEX_BRIDGE_FIRST_BYTE_TIMEOUT_MS = 180_000;
/** Absolute ceiling for one `/responses` call; only heartbeat-only ups hit it. */
export const CODEX_BRIDGE_ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60_000;

/** Budget label for timeout messages: 12h / 3min / 120ms — never "720min". */
function formatBudget(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}min`;
  if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
  return `${ms}ms`;
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
    const absoluteMs = config.timeoutMs ?? CODEX_BRIDGE_ABSOLUTE_TIMEOUT_MS;
    const idleMs = config.idleTimeoutMs ?? CODEX_BRIDGE_IDLE_TIMEOUT_MS;
    const firstByteMs = config.firstByteTimeoutMs ?? CODEX_BRIDGE_FIRST_BYTE_TIMEOUT_MS;
    // Absolute ceiling — deliberately never re-armed; see the deadline policy.
    const absoluteTimer = setTimeout(() => {
      ac.abort(new Error(`Codex upstream exceeded the ${formatBudget(absoluteMs)} absolute limit`));
    }, absoluteMs);
    absoluteTimer.unref();
    // Silence watchdog — starts on the first-byte budget and switches to the
    // (shorter) idle budget as soon as anything arrives, then re-arms per chunk.
    let sawFirstByte = false;
    let silenceTimer: ReturnType<typeof setTimeout> | undefined;
    const armSilence = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        ac.abort(new Error(
          sawFirstByte
            ? `Codex upstream went silent for ${formatBudget(idleMs)}`
            : `Codex upstream sent no response within ${formatBudget(firstByteMs)}`,
        ));
      }, sawFirstByte ? idleMs : firstByteMs);
      silenceTimer.unref();
    };
    armSilence();
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
      }, translated.toolNames);
      translator.start();
      reader = response.body.getReader();
      const decoder = new SseDecoder((data, event) => translator!.feed(data, event));
      for (;;) {
        ac.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        // Any byte proves the upstream is alive: promote to the idle budget
        // (if we were still waiting for the first byte) and restart the clock.
        sawFirstByte = true;
        armSilence();
        decoder.push(value);
      }
      decoder.finish();
      ac.signal.throwIfAborted();
      translator.finish();
      res.end();
    } catch (error) {
      if (translator && !res.destroyed) { translator.fail(ac.signal.aborted ? ac.signal.reason : error); res.end(); }
      else if (!res.headersSent) errorResponse(res, 502, ac.signal.aborted ? ac.signal.reason : error);
      else res.destroy();
    } finally {
      clearTimeout(absoluteTimer);
      if (silenceTimer) clearTimeout(silenceTimer);
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
