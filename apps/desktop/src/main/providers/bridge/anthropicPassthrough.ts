/**
 * Pure helpers for the bridge's Anthropic pass-through mode.
 *
 * ## Why an Anthropic-protocol endpoint goes through the bridge at all
 *
 * The Claude binary appends a `system`-role message to the END of `messages[]`
 * every turn (environment block, deferred-tool notices, the per-turn
 * output-style reminder). It spells that message two ways:
 *
 *   - on the turn it is new:   `content: [{type:"text", text, cache_control}]`
 *   - replayed from the transcript on every later turn: `content: "text"`
 *
 * Same message, two different byte sequences. A gateway that keys its prefix
 * cache on the request bytes (or re-renders the prompt before hashing it)
 * misses at that message and re-sends everything after it cold. Measured on
 * production traffic: `claude-sonnet-5-5` on an Anthropic-protocol channel
 * froze at `cached_token ≈ 18.9k` (the system+tools head) while the prompt grew
 * past 25k, with `cache_write` growing every turn.
 *
 * The bytes come from the binary, not from us, so the only place to make them
 * constant is in between: normalise the string spelling to the array spelling
 * (the one that can carry `cache_control`, so the fresh tail message keeps its
 * breakpoint) and forward everything else untouched.
 */

/** Hop-by-hop / transport headers that must not be copied to the upstream
 *  request: undici owns framing, and `accept-encoding` is dropped so the
 *  upstream answers in a form `fetch()` decodes for us. */
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "upgrade",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
]);

/** Response headers that describe the upstream's transport framing. `fetch()`
 *  has already decoded the body, so they would be wrong on our response. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "upgrade",
]);

/** Rewrite every `system` message whose `content` is a non-empty string into a
 *  single-text-block array. Mutates `body` in place; returns whether anything
 *  changed so the caller can forward the original bytes when nothing did. */
export function normalizeSystemMessages(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as { role?: unknown; content?: unknown };
    if (m.role === "system" && typeof m.content === "string" && m.content.length > 0) {
      m.content = [{ type: "text", text: m.content }];
      changed = true;
    }
  }
  return changed;
}

/** The real upstream URL for an incoming request path (`/v1/messages?beta=true`).
 *
 *  The binary appends `/v1/messages` to `ANTHROPIC_BASE_URL`, so a configured
 *  base that already ends in `/v1` must lose it first — the same rule
 *  `buildCustomEnv` applies on the direct path, kept identical so the gateway
 *  sees the same URL either way. */
export function buildAnthropicUpstreamUrl(baseUrl: string, requestUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${trimmed}${requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`}`;
}

/** Copy the binary's request headers for the upstream call. The binary already
 *  carries the real credential (`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` is
 *  the endpoint's own token), `anthropic-version`, `anthropic-beta` and its
 *  `User-Agent`, so they pass through verbatim and the gateway keeps seeing the
 *  client it always saw. */
export function forwardRequestHeaders(
  incoming: Record<string, string | string[] | undefined>,
  extra: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  // `extra` fills gaps only. Header names compare case-insensitively.
  const have = new Set(Object.keys(out).map((k) => k.toLowerCase()));
  for (const [name, value] of Object.entries(extra)) {
    if (!have.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/** Upstream response headers safe to replay to the binary. */
export function forwardResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) out[name] = value;
  });
  return out;
}
