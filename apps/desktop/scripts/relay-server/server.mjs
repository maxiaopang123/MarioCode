/**
 * MarioCode relay config service (TODO-074).
 *
 * Deliberately a SEPARATE process from the model relay itself (Octopus on
 * 8090). Two reasons:
 *
 *   1. It publishes a document, not models. Coupling a write endpoint onto the
 *      gateway means patching an upstream Go project and restarting the thing
 *      every user's API keys flow through. This service can be restarted at
 *      any time with zero effect on inference.
 *
 *   2. Blast radius. This process holds exactly one secret and one JSON file.
 *      It has no database handle, no model credentials, no upstream client.
 *      If it were ever compromised the worst outcome is a defaced model list.
 *
 * Routes
 *   GET  /relay-config.json     public, no auth — what every client reads
 *   POST /admin/relay-config    Bearer — replace the published document
 *   GET  /admin/verify          Bearer — 200/401, used by the unlock screen
 *   GET  /health                public liveness probe
 *
 * The token in `RELAY_ADMIN_TOKEN` IS the admin password shown to the operator.
 * There is no username, no session, no cookie: one shared bearer secret, the
 * same one the desktop app stores in safeStorage after a successful unlock.
 */
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 8091);
const HOST = process.env.HOST ?? "0.0.0.0";
const DATA_DIR = process.env.RELAY_DATA_DIR ?? "/opt/mariocode-relay/data";
const CONFIG_FILE = join(DATA_DIR, "relay-config.json");
const TOKEN = (process.env.RELAY_ADMIN_TOKEN ?? "").trim();

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

if (!TOKEN) {
  console.error("refusing to start: RELAY_ADMIN_TOKEN is empty");
  process.exit(1);
}
if (TOKEN.length < 16) {
  console.error("refusing to start: RELAY_ADMIN_TOKEN must be at least 16 characters");
  process.exit(1);
}

// ── auth ─────────────────────────────────────────────────────────────────────

/** Constant-time string compare that does not leak the expected length through
 *  an early `return false`. Both sides are hashed to a fixed 32 bytes first so
 *  `timingSafeEqual` can never throw on a length mismatch. */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ha = sha256(enc.encode(a));
  const hb = sha256(enc.encode(b));
  return timingSafeEqual(ha, hb);
}

function sha256(bytes) {
  // Lazy import would be async; node:crypto's createHash is sync and cheap.
  return createHash("sha256").update(bytes).digest();
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
 * 32-char random token pointless, not to keep a permanent ledger.
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

/** Returns null when authorized, or a `{ status, body }` reply to send. */
function authorize(req) {
  const ip = clientIp(req);
  if (throttled(ip)) {
    return { status: 429, body: { error: "too_many_attempts", retryAfterMs: LOCKOUT_MS } };
  }
  const presented = bearerOf(req);
  if (!presented || !safeEqual(presented, TOKEN)) {
    noteFailure(ip);
    // Identical reply for "no header" and "wrong token" so nothing is learned.
    return { status: 401, body: { error: "unauthorized" } };
  }
  FAILURES.delete(ip);
  return null;
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
      const denied = authorize(req);
      if (denied) return send(res, denied.status, denied.body);
      const published = await readPublished();
      return send(res, 200, { ok: true, hasConfig: published !== null });
    }

    if (path === "/admin/relay-config" && req.method === "GET") {
      const denied = authorize(req);
      if (denied) return send(res, denied.status, denied.body);
      const published = await readPublished();
      if (!published) return send(res, 404, { error: "no_config_published" });
      return send(res, 200, published);
    }

    if (path === "/admin/relay-config" && req.method === "POST") {
      const denied = authorize(req);
      if (denied) return send(res, denied.status, denied.body);

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
      // forged by whoever holds the token.
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
  console.log(`mariocode-relay listening on ${HOST}:${PORT}, data in ${DATA_DIR}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
