/**
 * MarioCode relay config service (TODO-074).
 *
 * Deliberately a SEPARATE process from the model relay itself (mariogate on
 * 8090). Two reasons:
 *
 *   1. It publishes a document, not models. Coupling a write endpoint onto the
 *      gateway means patching an upstream Go project and restarting the thing
 *      every user's API keys flow through. This service can be restarted at
 *      any time with zero effect on inference.
 *
 *   2. Blast radius. This process holds no credential of its own: it stores one
 *      JSON file and has no database handle, no model credentials, no upstream
 *      client of its own. If it were ever compromised the worst outcome is a
 *      defaced model list.
 *
 * Routes
 *   GET  /relay-config.json     public, no auth — what every client reads
 *   POST /admin/relay-config    Bearer — replace the published document
 *   GET  /admin/relay-config    Bearer — the document currently published
 *   GET  /admin/models          Bearer — the gateway's own model inventory
 *   GET  /admin/verify          Bearer — 200/401, used by the unlock screen
 *   GET  /health                public liveness probe
 *
 * THE ADMIN PASSWORD IS THE GATEWAY'S OWN ADMIN PASSWORD. There is no second
 * secret to keep in sync: the operator types the password of the `admin`
 * account of the mariogate panel, and this service validates it by asking the
 * gateway to log in (`POST /api/v1/user/login`) and checking that the account
 * comes back with role `admin`. Changing the gateway password therefore
 * changes this panel's password, with nothing to re-deploy.
 *
 * Consequences worth knowing:
 *   - The password is never stored here, and never logged. The JWT the gateway
 *     hands back is cached in memory for a few minutes (keyed by the password's
 *     hash) so one panel action costs one bcrypt round-trip, not three.
 *   - `GET /admin/models` reuses that JWT as the gateway's `auth` cookie to read
 *     `/api/v1/group/list` — the inventory comes over HTTP from the gateway
 *     API, never by opening its database.
 *   - The gateway's own login throttle (5 failures / 15 min per ip+user) is
 *     stricter than ours; a 429 from it is passed through as `login_locked`.
 */
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8091);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_DIR = process.env.RELAY_DATA_DIR ?? "/opt/mariocode-relay/data";
const CONFIG_FILE = join(DATA_DIR, "relay-config.json");

/** The inference gateway on this host. Used for admin auth and inventory
 *  reads only — this service never forwards inference. */
const GATEWAY_BASE = (process.env.RELAY_GATEWAY_BASE ?? "http://127.0.0.1:8090").replace(/\/+$/, "");
/** Gateway account whose password unlocks this panel. */
const ADMIN_USER = (process.env.RELAY_ADMIN_USER ?? "admin").trim();

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 1000;
const ALLOWED_PROTOCOLS = ["anthropic", "chat-completions", "responses"];
const ALLOWED_ENGINES = ["claude", "codex", "pi"];

/** Routing preference per engine — mirrors AGENT_PROTOCOLS in sharedProvider.ts. */
const AGENT_PROTOCOLS = {
  claude: ["chat-completions", "anthropic", "responses"],
  codex: ["responses", "chat-completions", "anthropic"],
  pi: ["chat-completions", "anthropic", "responses"],
};

/** Exactly the keys `SharedProviderModelSchema` allows; it is `.strict()`, so a
 *  model carrying anything else is rejected by the client too. */
const ALLOWED_MODEL_KEYS = new Set([
  "id",
  "label",
  "interfaces",
  "contextWindow",
  "maxTokens",
  "reasoning",
  "input",
  "imageGeneration",
]);

/** Only these top-level keys may appear. Anything else — notably `baseUrl` —
 *  is a rejection, mirroring `RelayConfigSchema.strict()` on the client. This
 *  is the single most important check in the file: it is what stops a
 *  published document from ever steering a user's key somewhere else. */
const ALLOWED_ROOT_KEYS = new Set(["version", "updatedAt", "name", "models"]);

/** Gateway protocol bitmask (internal/model/channel.go). Bits 4..6 are the
 *  three image endpoints; they never stand in for a text protocol. */
const PROTOCOL_CHAT = 1 << 1;
const PROTOCOL_RESPONSES = 1 << 2;
const PROTOCOL_ANTHROPIC = 1 << 3;
const PROTOCOL_IMAGE = (1 << 4) | (1 << 5) | (1 << 6);

// ── auth ─────────────────────────────────────────────────────────────────────

/** Hex digest used as the login cache key: the cache must never hold a password. */
function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function bearerOf(req) {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}

/**
 * Failed-attempt throttling. Keyed by remote address, in memory only — a
 * restart clears it, which is fine: the goal is to make online guessing of a
 * password pointless, not to keep a permanent ledger.
 */
const FAILURES = new Map();
const MAX_FAILURES = 8;
const LOCKOUT_MS = 60_000;

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

function throttled(ip) {
  const rec = FAILURES.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.last > LOCKOUT_MS) {
    FAILURES.delete(ip);
    return false;
  }
  return rec.count >= MAX_FAILURES;
}

function noteFailure(ip) {
  const rec = FAILURES.get(ip);
  const now = Date.now();
  if (!rec || now - rec.last > LOCKOUT_MS) {
    FAILURES.set(ip, { count: 1, last: now });
    return;
  }
  rec.count += 1;
  rec.last = now;
  // Keep the map from growing without bound on a sprayed attack.
  if (FAILURES.size > 5000) {
    for (const [k, v] of FAILURES) {
      if (now - v.last > LOCKOUT_MS) FAILURES.delete(k);
    }
  }
}

const GATEWAY_TIMEOUT_MS = 10_000;
/** Gateway's own login throttle window (5 failures / 15 min per ip+user); we
 *  only report it, it is the gateway that enforces it. */
const LOGIN_LOCK_MS = 15 * 60_000;
/** A verified password is remembered briefly so one panel action (verify, then
 *  pull, then push) costs one bcrypt round-trip instead of three. Keyed by the
 *  password's hash — the password itself is never kept. */
const LOGIN_CACHE = new Map();
const LOGIN_TTL_MS = 5 * 60_000;
const LOGIN_CACHE_MAX = 32;

/** Pull the `auth` JWT out of the gateway's Set-Cookie header. */
function jwtFrom(response) {
  const cookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
  for (const cookie of cookies) {
    const m = /(?:^|,\s*)auth=([^;,\s]+)/.exec(cookie);
    if (m) return m[1];
  }
  return null;
}

/**
 * Validate an administrator password against the gateway itself.
 *
 * Returns `{ jwt, cacheKey }` on success, or `{ status, body }` to send back.
 * A non-admin account is reported exactly like a wrong password, so this
 * endpoint cannot be used to enumerate accounts.
 */
async function gatewayLogin(password) {
  const cacheKey = sha256(password);
  const hit = LOGIN_CACHE.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return { jwt: hit.jwt, cacheKey };

  let response;
  try {
    response = await fetch(`${GATEWAY_BASE}/api/v1/user/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ username: ADMIN_USER, password }),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("gateway login unreachable", err && err.message ? err.message : err);
    return { status: 502, body: { error: "gateway_unavailable" } };
  }

  if (response.status === 429) {
    return { status: 429, body: { error: "login_locked", retryAfterMs: LOGIN_LOCK_MS } };
  }
  if (!response.ok) {
    // 401 for a wrong password, and for a disabled account. Both mean "this is
    // not a usable administrator as far as this panel is concerned".
    return { status: 401, body: { error: "unauthorized" } };
  }

  const payload = await response.json().catch(() => null);
  const role = payload && payload.data ? payload.data.role : undefined;
  if (role !== "admin") return { status: 401, body: { error: "unauthorized" } };

  const jwt = jwtFrom(response);
  if (!jwt) {
    console.error("gateway login succeeded but returned no auth cookie");
    return { status: 502, body: { error: "gateway_unavailable" } };
  }

  if (LOGIN_CACHE.size >= LOGIN_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of LOGIN_CACHE) if (v.expiresAt <= now) LOGIN_CACHE.delete(k);
    // Still full (all fresh): drop the oldest insertion, which Map preserves.
    if (LOGIN_CACHE.size >= LOGIN_CACHE_MAX) {
      const oldest = LOGIN_CACHE.keys().next();
      if (!oldest.done) LOGIN_CACHE.delete(oldest.value);
    }
  }
  LOGIN_CACHE.set(cacheKey, { jwt, expiresAt: Date.now() + LOGIN_TTL_MS });
  return { jwt, cacheKey };
}

/**
 * Returns `{ denied: { status, body } }` when the caller may not proceed, or
 * `{ jwt, cacheKey, password }` when it may. `password` is only carried so
 * `GET /admin/models` can re-login if the cached JWT turned out to be stale.
 */
async function authorize(req) {
  const ip = clientIp(req);
  if (throttled(ip)) {
    return { denied: { status: 429, body: { error: "too_many_attempts", retryAfterMs: LOCKOUT_MS } } };
  }
  const presented = bearerOf(req);
  if (!presented) {
    noteFailure(ip);
    // Identical reply for "no header" and "wrong password" so nothing is learned.
    return { denied: { status: 401, body: { error: "unauthorized" } } };
  }
  const session = await gatewayLogin(presented);
  if (!session.jwt) {
    // 502 is "we could not ask the gateway", not "the password is wrong" — a
    // gateway hiccup must not burn through the caller's attempt budget.
    if (session.status !== 502) noteFailure(ip);
    return { denied: session };
  }
  FAILURES.delete(ip);
  return { jwt: session.jwt, cacheKey: session.cacheKey, password: presented };
}

// ── inventory ────────────────────────────────────────────────────────────────

/**
 * One gateway group → one inventory row.
 *
 * A group is a client-facing model name with one or more channel grants behind
 * it, and each grant carries a protocol bitmask. The group's usable interfaces
 * are therefore the UNION of its members' bits — but only of the members that
 * can actually forward right now. When none can, every member is counted, so a
 * broken group still reports what it is meant to serve instead of vanishing.
 */
function toInventoryModel(group) {
  const id = typeof group.name === "string" ? group.name.trim() : "";
  if (!id) return null;
  const items = Array.isArray(group.items) ? group.items : [];
  const usable = items.some((item) => item && item.available === true);
  const chosen = usable ? items.filter((item) => item && item.available === true) : items;

  let bits = 0;
  for (const item of chosen) bits |= Number(item.protocols) || 0;

  const interfaces = [];
  if (bits & PROTOCOL_CHAT) interfaces.push("chat-completions");
  if (bits & PROTOCOL_RESPONSES) interfaces.push("responses");
  if (bits & PROTOCOL_ANTHROPIC) interfaces.push("anthropic");
  const imageGeneration = (bits & PROTOCOL_IMAGE) !== 0;
  if (interfaces.length === 0) {
    // No text protocol at all: only meaningful for an image model, and the app
    // sends those through its chat interface slot — which is how the published
    // list has always described them.
    if (!imageGeneration) return null;
    interfaces.push("chat-completions");
  }

  return { id, listed: group.listed === true, available: usable, interfaces, imageGeneration };
}

/** Read the gateway's own inventory. Throws `err.code === "SESSION"` when the
 *  JWT is no longer accepted, `"GATEWAY"` for anything else. */
async function fetchInventory(jwt) {
  const response = await fetch(`${GATEWAY_BASE}/api/v1/group/list`, {
    headers: { accept: "application/json", cookie: `auth=${jwt}` },
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error("gateway session rejected"), { code: "SESSION" });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`gateway returned ${response.status}`), { code: "GATEWAY" });
  }
  const payload = await response.json();
  const groups = payload && Array.isArray(payload.data) ? payload.data : [];
  const models = groups.map(toInventoryModel).filter((model) => model !== null);
  // Deterministic order: the client merges by id and only appends what is new,
  // so this only decides where newly discovered models land.
  models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return models;
}

// ── config validation ────────────────────────────────────────────────────────

/**
 * Structural check of a pushed document. Intentionally duplicated from the
 * client schema rather than shared: the server must not trust the client's
 * validation, and this half is the one that protects every OTHER user.
 */
function validateConfig(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "config must be an object";
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_ROOT_KEYS.has(key)) return `unexpected field "${key}"`;
  }
  if (input.version !== 1) return "version must be 1";
  if (!Array.isArray(input.models)) return "models must be an array";
  if (input.models.length < 1 || input.models.length > MAX_MODELS) {
    return `models must hold 1..${MAX_MODELS} entries`;
  }

  const ids = new Set();
  for (const [i, model] of input.models.entries()) {
    const where = `models[${i}]`;
    if (model === null || typeof model !== "object" || Array.isArray(model)) {
      return `${where} must be an object`;
    }
    for (const key of Object.keys(model)) {
      if (!ALLOWED_MODEL_KEYS.has(key)) return `${where} has unexpected field "${key}"`;
    }

    if (typeof model.id !== "string" || model.id.trim().length === 0) {
      return `${where}.id must be a non-empty string`;
    }
    if (model.id.length > 256) return `${where}.id is too long`;
    if (ids.has(model.id)) return `duplicate model id "${model.id}"`;
    ids.add(model.id);

    if (model.label !== undefined) {
      if (typeof model.label !== "string") return `${where}.label must be a string`;
      if (model.label.trim().length === 0 || model.label.length > 256) {
        return `${where}.label must be 1..256 characters`;
      }
    }

    if (model.interfaces !== undefined) {
      if (!Array.isArray(model.interfaces) || model.interfaces.length < 1 || model.interfaces.length > 3) {
        return `${where}.interfaces must hold 1..3 entries`;
      }
      if (new Set(model.interfaces).size !== model.interfaces.length) {
        return `${where}.interfaces must be unique`;
      }
      for (const protocol of model.interfaces) {
        if (!ALLOWED_PROTOCOLS.includes(protocol)) {
          return `${where}.interfaces may only use ${ALLOWED_PROTOCOLS.join("/")}`;
        }
      }
    }

    for (const key of ["contextWindow", "maxTokens"]) {
      const value = model[key];
      if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
        return `${where}.${key} must be a positive integer`;
      }
    }

    if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") {
      return `${where}.reasoning must be a boolean`;
    }
    if (model.imageGeneration !== undefined && typeof model.imageGeneration !== "boolean") {
      return `${where}.imageGeneration must be a boolean`;
    }

    if (model.input !== undefined) {
      if (!Array.isArray(model.input) || model.input.length < 1 || model.input.length > 2) {
        return `${where}.input must hold 1..2 entries`;
      }
      for (const kind of model.input) {
        if (kind !== "text" && kind !== "image") return `${where}.input may only use text/image`;
      }
    }
  }

  // Mirrors the client superRefine: every engine needs a model it can route to.
  // Effective interfaces default to all three protocols when omitted, so this
  // only bites when a list is genuinely unroutable.
  for (const engine of ALLOWED_ENGINES) {
    const usable = input.models.some((m) => {
      const list = m.interfaces ?? ALLOWED_PROTOCOLS;
      return AGENT_PROTOCOLS[engine].some((protocol) => list.includes(protocol));
    });
    if (!usable) return `no model can serve the "${engine}" engine`;
  }

  if (input.name !== undefined) {
    if (typeof input.name !== "string") return "name must be a string";
    if (input.name.trim().length === 0 || input.name.length > 64) return "name must be 1..64 characters";
  }
  if (input.updatedAt !== undefined) {
    if (typeof input.updatedAt !== "string") return "updatedAt must be a string";
    if (input.updatedAt.length > 64) return "updatedAt is too long";
  }
  return null;
}

// ── io ───────────────────────────────────────────────────────────────────────

async function readPublished() {
  try {
    const text = await readFile(CONFIG_FILE, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

/** Write-then-rename so a reader never observes a half-written document. */
async function writePublished(config) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(tmp, CONFIG_FILE);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(payload);
}

// ── routes ───────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (path === "/health" && req.method === "GET") {
      const published = await readPublished();
      return send(res, 200, { ok: true, hasConfig: published !== null });
    }

    if (path === "/relay-config.json" && req.method === "GET") {
      const published = await readPublished();
      if (!published) return send(res, 404, { error: "no_config_published" });
      return send(res, 200, published, {
        // Clients cache aggressively; a push must be visible on the next poll.
        "cache-control": "no-cache, max-age=0, must-revalidate",
      });
    }

    if (path === "/admin/verify" && req.method === "GET") {
      const auth = await authorize(req);
      if (auth.denied) return send(res, auth.denied.status, auth.denied.body);
      const published = await readPublished();
      return send(res, 200, { ok: true, hasConfig: published !== null });
    }

    if (path === "/admin/relay-config" && req.method === "GET") {
      const auth = await authorize(req);
      if (auth.denied) return send(res, auth.denied.status, auth.denied.body);
      const published = await readPublished();
      if (!published) return send(res, 404, { error: "no_config_published" });
      return send(res, 200, published);
    }

    if (path === "/admin/models" && req.method === "GET") {
      const auth = await authorize(req);
      if (auth.denied) return send(res, auth.denied.status, auth.denied.body);

      let models;
      try {
        models = await fetchInventory(auth.jwt);
      } catch (err) {
        if (err && err.code !== "SESSION") {
          console.error("inventory read failed", err && err.message ? err.message : err);
          return send(res, 502, { error: "gateway_unavailable" });
        }
        // The cached JWT went stale — the gateway rotates `session_version` on
        // a password change. Drop it and log in again, exactly once.
        LOGIN_CACHE.delete(auth.cacheKey);
        const retry = await gatewayLogin(auth.password);
        if (!retry.jwt) {
          return send(res, retry.status ?? 502, retry.body ?? { error: "gateway_unavailable" });
        }
        try {
          models = await fetchInventory(retry.jwt);
        } catch (retryErr) {
          console.error("inventory read failed", retryErr && retryErr.message ? retryErr.message : retryErr);
          return send(res, 502, { error: "gateway_unavailable" });
        }
      }

      const listed = models.filter((model) => model.listed).length;
      console.log(
        `[${new Date().toISOString()}] inventory: ${models.length} models (${listed} listed) for ${clientIp(req)}`,
      );
      return send(res, 200, { fetchedAt: new Date().toISOString(), models });
    }

    if (path === "/admin/relay-config" && req.method === "POST") {
      const auth = await authorize(req);
      if (auth.denied) return send(res, auth.denied.status, auth.denied.body);

      const raw = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "invalid_json" });
      }
      const problem = validateConfig(parsed);
      if (problem) return send(res, 400, { error: "invalid_config", detail: problem });

      // Server owns the timestamp so "when was this last published" cannot be
      // forged by whoever holds the password.
      const next = { ...parsed, updatedAt: new Date().toISOString() };
      await writePublished(next);
      console.log(
        `[${new Date().toISOString()}] published ${next.models.length} models from ${clientIp(req)}`,
      );
      return send(res, 200, { ok: true, updatedAt: next.updatedAt, models: next.models.length });
    }

    send(res, 404, { error: "not_found" });
  } catch (err) {
    const status = err && typeof err.status === "number" ? err.status : 500;
    if (status === 500) console.error("unhandled error", err);
    if (!res.headersSent) send(res, status, { error: status === 500 ? "internal" : "request" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `mariocode-relay listening on ${HOST}:${PORT}, data in ${DATA_DIR}, ` +
      `admin = gateway account "${ADMIN_USER}" at ${GATEWAY_BASE}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
