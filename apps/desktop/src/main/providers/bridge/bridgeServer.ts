/**
 * Local HTTP server that impersonates an Anthropic `/v1/messages` endpoint.
 *
 * The Claude binary is pointed at this server via `ANTHROPIC_BASE_URL`. It
 * receives Anthropic-formatted POST bodies, translates each to OpenAI's
 * `/v1/chat/completions` format, forwards to the real upstream, and streams
 * the OpenAI SSE response back re-translated into Anthropic SSE.
 *
 * ## Lifecycle
 *
 * Created lazily per upstream config and owned by {@link BridgeRegistry}
 * (which reference-counts so multiple sessions on the same config share one
 * server). `close()` stops listening and frees the port; outstanding requests
 * are left to finish or time out on their own (the registry only closes on
 * config release or app shutdown).
 *
 * ## Why a fresh port per server
 *
 * `listen(0)` lets the OS hand back a free ephemeral port, so we never clash
 * with anything the user is running, and never need a config knob.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { log } from "@main/lib/logger.js";
import { engineFetch } from "@main/network/engineProxy.js";
import {
  hasHeader,
  requiresSessionHeader,
  resolveUpstreamHeaders,
  SESSION_HEADER,
} from "@main/providers/upstreamHeaders.js";
import { anthropicToOpenAI } from "./requestTranslator.js";
import { OpenAiToAnthropicSse } from "./responseTranslator.js";
import { anthropicToResponses } from "./responsesRequestTranslator.js";
import { ResponsesToAnthropicSse } from "./responsesResponseTranslator.js";
import { SseDecoder } from "./sseDecoder.js";
import type {
  AnthropicRequest,
  AnthropicSseEvent,
  OpenAIChunk,
  OpenAIRequest,
  ResponsesSseChunk,
  UpstreamConfig,
} from "./types.js";

/** Transient upstream-transport status, surfaced to subscribers via
 *  {@link BridgeHandle.onStatus} so the UI can show "上游连接异常,正在重试…"
 *  instead of an unexplained spinner. */
export interface BridgeStatus {
  kind: "retry" | "ok";
  /** Readable transport cause (see describeFetchError); empty for "ok". */
  cause: string;
  attempt: number;
  attempts: number;
}

/** A handle to a running bridge server. */
export interface BridgeHandle {
  /** The local URL the Claude binary should use as ANTHROPIC_BASE_URL. */
  readonly localUrl: string;
  /** An opaque token the binary sends back; the server accepts any value —
   *  this exists only so the env-var contract (`ANTHROPIC_AUTH_TOKEN`) is
   *  satisfied. The real upstream credential is held inside the server. */
  readonly routeToken: string;
  /** Subscribe to transient upstream-transport status (retry loop). The
   *  returned function unsubscribes. Statuses are informational only — the
   *  bridge proceeds identically with or without subscribers. */
  onStatus(cb: (s: BridgeStatus) => void): () => void;
  /** Stop listening. Idempotent. */
  close(): void;
}

/** Whether an upstream base URL looks like an Azure OpenAI deployment.
 *  Azure uses a different path shape and the `api-key` header (not Bearer). */
function looksLikeAzure(baseUrl: string): boolean {
  return /azure\.com/i.test(baseUrl);
}

/** Pull a readable cause out of a Node/undici fetch failure.
 *
 * `fetch()` rejects with a `TypeError` whose `.message` is always the opaque
 * string `"fetch failed"` — useless for diagnosis. The real reason lives on
 * `.cause` as `{ code, message }` (e.g. `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`,
 * `ECONNRESET`). This unwraps it so logs and the error sent back to the user
 * name the actual failure instead of "fetch failed".
 *
 * Also collapses AbortController aborts (client disconnect or our timeout) into
 * a clear "aborted" string rather than surfacing undici's "aborted" / "The user
 * aborted a request" verbatim. */
function describeFetchError(err: unknown): string {
  const e = err as {
    name?: string;
    message?: string;
    cause?: { code?: string; name?: string; message?: string };
  };
  // AbortError surfaces directly (not nested under .cause) when the signal fires.
  if (e?.name === "AbortError" || /abort/i.test(e?.message ?? "")) {
    return "aborted (client disconnect or request timeout)";
  }
  const cause = e?.cause;
  const code = cause?.code || cause?.name;
  if (code) return `${code}: ${cause?.message ?? e?.message ?? "unknown"}`;
  return e?.message || String(err);
}

/** Transport-layer error codes worth a single retry. These are transient by
 *  nature — the connection died mid-flight or a public-IP route flapped — so one
 *  short retry can self-heal without masking a real outage. HTTP status errors
 *  (4xx/5xx) are NOT retried: they carry endpoint semantics (auth, model, quota)
 *  and live on a different code path. */
const RETRYABLE_FETCH_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
]);

function isRetryableFetchError(err: unknown): boolean {
  const code = (err as { cause?: { code?: string; name?: string } })?.cause?.code;
  if (code && RETRYABLE_FETCH_CODES.has(code)) return true;
  // Fall back to a string match on the readable cause — covers variants that
  // only populate .name or surface the code in the message, and Chromium's
  // net::ERR_* names from proxied calls (see engineFetch).
  return /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|CONNECT_TIMEOUT|SOCKET|UND_ERR_CLOSED|ERR_CONNECTION_(RESET|CLOSED|REFUSED)|ERR_TIMED_OUT|ERR_NETWORK_CHANGED|ERR_PROXY_CONNECTION_FAILED/i.test(
    describeFetchError(err),
  );
}

/** Fetch the upstream with one bounded retry on transient transport failures.
 *
 * Waits {@link backoffMs} before the second attempt; honors `signal` so a client
 * disconnect or timeout aborts immediately rather than sleeping pointlessly.
 * Returns the first successful Response, or throws the last error. Transport
 * retries are reported through `onStatus` (informational — the loop runs the
 * same with or without a subscriber) so the UI can explain a mid-turn stall. */
async function fetchUpstreamWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  onStatus?: (s: BridgeStatus) => void,
  attempts = 2,
  backoffMs = 500,
  fetchUpstream: typeof engineFetch = engineFetch,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal.aborted) throw new Error("aborted before fetch");
    try {
      const res = await fetchUpstream(url, { ...init, signal });
      // A request that needed retries finally went through — tell
      // subscribers the stall is over (they clear the retry hint).
      if (attempt > 1) onStatus?.({ kind: "ok", cause: "", attempt, attempts });
      return res;
    } catch (err) {
      lastErr = err;
      const cause = describeFetchError(err);
      if (attempt < attempts && isRetryableFetchError(err)) {
        log.warn(`bridge: upstream fetch attempt ${attempt}/${attempts} failed (${cause}); retrying in ${backoffMs}ms`);
        onStatus?.({ kind: "retry", cause, attempt, attempts });
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, backoffMs);
          // If the client disconnects mid-backoff, stop waiting immediately.
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        });
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Read and JSON-parse an incoming request body, with a size guard. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const LIMIT = 32 * 1024 * 1024; // 32 MB guard against runaway bodies
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > LIMIT) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Build the upstream request headers (auth differs between OpenAI & Azure),
 *  then layer the endpoint's own headers on top — the same set the direct
 *  (anthropic-protocol) path puts on `ANTHROPIC_CUSTOM_HEADERS`, so both paths
 *  are byte-identical from the gateway's point of view. See
 *  {@link ../../upstreamHeaders.ts} for the shared policy (sanitizing, and the
 *  auto session id for gateways that reject requests without one).
 *
 *  User headers are applied LAST and may therefore override the derived
 *  Content-Type / Authorization — deliberate: a gateway that wants a custom
 *  auth scheme is exactly the case this field exists for.
 *
 *  NOTE: we deliberately do NOT set `Content-Length`. When the body passed to
 *  `fetch()` is a string (or Buffer/TypedArray), undici computes it itself.
 *  Setting it manually triggers `UND_ERR_INVALID_ARG: invalid content-length
 *  header` on the undici 6.x bundled with Electron 33 (Node 20) — undici
 *  validates a user-supplied Content-Length against its own derivation and
 *  rejects the mismatch. Omitting it lets undici own the value, which is both
 *  correct and what every other caller does. */
function upstreamHeaders(upstream: UpstreamConfig, sessionId: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (looksLikeAzure(upstream.baseUrl)) {
    // Azure OpenAI: `api-key` header, and api-version comes as a query param
    // (added in buildUpstreamUrl).
    headers["api-key"] = upstream.authToken;
  } else {
    // Standard OpenAI / OpenAI-compatible: Bearer token. Both authMode values
    // (auth_token / api_key) map to Bearer here — the distinction only mattered
    // for the Anthropic env vars; on the OpenAI wire it's always Bearer.
    headers["Authorization"] = `Bearer ${upstream.authToken}`;
  }
  return { ...headers, ...resolveUpstreamHeaders(upstream.customHeaders, upstream.baseUrl, sessionId) };
}

/** Build the full upstream URL, normalizing the path and adding Azure's
 *  api-version query param when applicable. */
function buildUpstreamUrl(baseUrl: string, protocol?: "chat-completions" | "responses"): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (protocol === "responses") {
    if (/\/responses\/?$/i.test(trimmed)) {
      return trimmed.replace(/\/+$/, "");
    }
    if (/\/v1\/?$/i.test(trimmed)) {
      return `${trimmed.replace(/\/+$/, "")}/responses`;
    }
    return `${trimmed}/v1/responses`;
  }
  if (looksLikeAzure(baseUrl)) {
    // Azure deployments are addressed as {base}/openai/deployments/{deployment}
    // and require `?api-version=`. We assume the user's baseUrl already points
    // at a chat completions path (or the deployment root); we just ensure the
    // version is present and the path ends in /chat/completions.
    const sep = trimmed.includes("?") ? "&" : "?";
    const withVersion = trimmed.includes("api-version=")
      ? trimmed
      : `${trimmed}${sep}api-version=2024-10-21`;
    return withVersion.replace(/\/?$/, "/chat/completions");
  }
  // OpenAI-compatible: ensure it ends at /v1/chat/completions. If the user
  // already included the full path, leave it; if they stopped at /v1, append
  // the rest; otherwise add the whole /v1/chat/completions suffix.
  if (/\/v1\/chat\/completions\/?$/i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  if (/\/v1\/?$/i.test(trimmed)) {
    return `${trimmed.replace(/\/+$/, "")}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

/** Write one Anthropic SSE event to the response, framed as
 *  `event: <type>\ndata: <json>\n\n`. */
function writeSseEvent(res: ServerResponse, ev: AnthropicSseEvent): void {
  res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

/** Send a minimal Anthropic-shaped error back to the binary. We use a 400 with
 *  an `error` JSON body so the SDK surfaces a readable message. */
function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    writeSseEvent(res, { type: "error", error: { type: "api_error", message } });
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      type: "error",
      error: { type: "bridge_error", message },
    }),
  );
}

/** Handle a single `/v1/messages` POST: translate → forward → stream back.
 *
 *  `sessionId` names the upstream's required session header when it wants one
 *  (see {@link startBridge} for why it is the bridge's id and not a session's). */
async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: UpstreamConfig,
  sessionId: string,
  onStatus?: (s: BridgeStatus) => void,
  fetchUpstream: typeof engineFetch = engineFetch,
): Promise<void> {
  const ac = new AbortController();
  const timer = upstream.timeoutMs ? setTimeout(() => ac.abort(new Error("Upstream request timed out")), upstream.timeoutMs) : undefined;
  timer?.unref();
  const disconnect = () => { if (!res.writableEnded) ac.abort(new Error("Claude client disconnected")); };
  req.once("aborted", disconnect);
  res.once("close", disconnect);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    let body: AnthropicRequest;
    try { body = await readJsonBody(req) as AnthropicRequest; }
    catch (error) { sendError(res, 400, `invalid request body: ${describeFetchError(error)}`); return; }
    ac.signal.throwIfAborted();
    const isResponses = upstream.protocol === "responses";
    const upstreamUrl = buildUpstreamUrl(upstream.baseUrl, upstream.protocol);
    const translated = isResponses ? anthropicToResponses(body) : anthropicToOpenAI(body);
    translated.stream = true;
    if (!isResponses) (translated as OpenAIRequest).stream_options = { include_usage: true };
    const response = await fetchUpstreamWithRetry(upstreamUrl, {
      method: "POST", headers: upstreamHeaders(upstream, sessionId), body: JSON.stringify(translated),
    }, ac.signal, onStatus, 2, 500, fetchUpstream);
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      sendError(res, response.status || 502, detail.slice(0, 1000) || `upstream ${response.status}`);
      return;
    }
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("Upstream did not return an SSE stream");
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const translator = isResponses ? new ResponsesToAnthropicSse() : new OpenAiToAnthropicSse();
    const decoder = new SseDecoder((data, event) => {
      if (data === "[DONE]") return;
      const chunk: unknown = JSON.parse(data);
      if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) throw new Error("Invalid upstream SSE payload");
      const events = translator instanceof ResponsesToAnthropicSse
        ? translator.feed(chunk as ResponsesSseChunk, event)
        : translator.feed(event === "error" ? { ...(chunk as OpenAIChunk), type: "error" } : chunk as OpenAIChunk);
      for (const ev of events) writeSseEvent(res, ev);
    });
    reader = response.body.getReader();
    for (;;) {
      ac.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      decoder.push(value);
    }
    decoder.finish();
    ac.signal.throwIfAborted();
    for (const ev of translator.finish()) writeSseEvent(res, ev);
    res.end();
  } catch (error) {
    const cause = describeFetchError(ac.signal.aborted ? ac.signal.reason : error);
    log.error(`bridge: upstream request failed: ${cause}`);
    sendError(res, 502, cause);
  } finally {
    if (timer) clearTimeout(timer);
    ac.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    req.off("aborted", disconnect);
    res.off("close", disconnect);
  }
}

/** Start a bridge server bound to a random local port. Resolves once listening. */
export async function startBridge(upstream: UpstreamConfig, fetchUpstream: typeof engineFetch = engineFetch): Promise<BridgeHandle> {
  // Status subscribers (RuntimeManager fans these out as `upstream.issue`
  // RuntimeEvents per session using this bridge). Listener errors are
  // swallowed — status is best-effort observability, never control flow.
  const statusListeners = new Set<(s: BridgeStatus) => void>();
  const notifyStatus = (s: BridgeStatus) => {
    for (const cb of statusListeners) {
      try {
        cb(s);
      } catch {
        // ignore — a broken subscriber must not break the bridge
      }
    }
  };
  // Session id for gateways that require one (see upstreamHeaders). The bridge
  // is shared per config across sessions, and by the time it is built the
  // config's baseUrl has already been rewritten to this local URL — so the
  // live-turn env builder can't supply a per-session id to this path. One
  // stable id per bridge it is: the gateway still sees a single, unchanging
  // conversation for this endpoint rather than a new one per request, which is
  // all its routing/prompt-cache contract asks for.
  const bridgeSessionId = `mariocode-${randomBytes(6).toString("hex")}`;
  if (requiresSessionHeader(upstream.baseUrl)) {
    log.info(
      hasHeader(upstream.customHeaders ?? {}, SESSION_HEADER)
        ? `bridge: upstream requires ${SESSION_HEADER}; using the configured value`
        : `bridge: upstream requires ${SESSION_HEADER}; injecting a stable id for this bridge (${bridgeSessionId})`,
    );
  }
  const server: Server = createServer((req, res) => {
    // The Claude binary POSTs to {baseUrl}/v1/messages. Accept either
    // /v1/messages or a bare /messages for robustness.
    //
    // IMPORTANT: strip the query string before matching. The binary appends
    // `?beta=true` to the path when ANTHROPIC_MODEL is a non-first-party name
    // (it negotiates the anthropic-beta capability via query instead of a
    // header on third-party routes). A bare `endsWith("/v1/messages")` fails
    // to match `/v1/messages?beta=true`, so the request fell through to the
    // 404 branch and the binary interpreted that 404 as "selected model may
    // not exist" - which is exactly the failure users saw with OpenAI-format
    // gateways (e.g. MiniMax-M3). Matching on the path alone fixes it.
    const rawUrl = req.url ?? "";
    const path = rawUrl.split("?", 2)[0];
    if (req.method === "POST" && (path.endsWith("/v1/messages") || path.endsWith("/messages"))) {
      handleMessages(req, res, upstream, bridgeSessionId, notifyStatus, fetchUpstream).catch((err) => {
        log.error(`bridge: handler threw: ${(err as Error).message}`);
        sendError(res, 500, "internal bridge error");
      });
      return;
    }
    // Anything else (health probes, GET) → 404. The binary only POSTs messages.
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { message: "not found" } }));
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("failed to bind bridge server"));
    });
  });

  const routeToken = randomBytes(12).toString("hex");
  log.info(`bridge: listening on 127.0.0.1:${port} → ${upstream.baseUrl}`);

  return {
    localUrl: `http://127.0.0.1:${port}`,
    routeToken,
    onStatus: (cb: (s: BridgeStatus) => void) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    close: () => {
      server.close(() => log.info(`bridge: closed 127.0.0.1:${port}`));
    },
  };
}
