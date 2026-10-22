/**
 * Balance + usage for the key this machine holds on the built-in relay
 * (TODO-074 follow-up).
 *
 * Where this sits
 * ---------------
 * The relay is two processes: :8090 is the inference gateway (`octopus`) with
 * its own REST surface under `/api/v1`, and :18505 is our ~300-line config
 * service. This module talks to the **gateway**, not the config service: the
 * balance and the usage figures live in the gateway's database, and only the
 * gateway knows them.
 *
 * Authentication — the important part
 * -----------------------------------
 * Every request carries `Authorization: Bearer <the user's own relay API key>`.
 * In the gateway's API-key mode the key *is* the bearer token, so there is no
 * session cookie to juggle and no admin credential anywhere in this path. That
 * is deliberate: a per-user balance is readable with a per-user credential. A
 * *platform-wide* figure (how many users, total balance) would need an admin
 * token, and shipping an admin token inside the app would make one cracked
 * laptop equal one compromised relay. This module never asks for one.
 *
 * Which endpoints — and why not `/api/v1/me`
 * ------------------------------------------
 * `/api/v1/me` and `/api/v1/me/usage` are guarded by the gateway's `UserAuth()`,
 * which reads **only the panel's `auth` cookie** (a JWT from the web console)
 * and ignores the Authorization header entirely. With an API key they answer
 * 401 unconditionally, which read as "your key is invalid" on a perfectly good
 * key. Everything here therefore goes through `/api/v1/apikey/*`, the group that
 * actually authenticates keys via `APIKeyAuth()` (hash lookup + enabled /
 * expiry / balance checks). v0.2.59 shipped with the cookie-only pair and every
 * user saw 「API Key 无效或已失效」 — see docs/MarioCode-TODO.md TODO-077.
 *
 * Why plain `fetch` and not `engineFetch`
 * ---------------------------------------
 * The gateway rejects any request carrying a foreign `Origin` header with a
 * 403 and an empty body — including `Origin: null`, which is what Chromium's
 * network stack sends for a main-process request. `engineFetch` only uses Node's
 * fetch on a direct route; behind a proxy it goes through a Chromium session
 * and would be refused. Node's fetch sends no `Origin` at all, so it is the one
 * transport the gateway accepts unconditionally. (Verified against the live
 * server: no Origin → 401 "Authentication failed"; `Origin: null` → 403.)
 */
import { createHash } from "node:crypto";
import {
  BUILTIN_RELAY_ACCOUNT_STATS_URL,
  BuiltinRelayAccountSchema,
  type BuiltinRelayAccount,
} from "@contracts/builtinRelay";
import { BUILTIN_RELAY_ID } from "@contracts/builtinRelay";
import { resolveApiKey } from "@main/lib/sharedProviderStore.js";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** How long a snapshot is reused before the next call goes back to the wire.
 *  A balance is not a live ticker; reopening the settings page a few times in
 *  a minute should not mean five round trips. */
const CACHE_TTL_MS = 60_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RelayAccountDeps {
  /** Test seam; production uses the global fetch. */
  fetch?: FetchLike;
  /** Test seam; production uses REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Test seam; production reads the encrypted key store. */
  resolveKey?: () => string | null;
  /** Test seam: bypass the snapshot cache. */
  noCache?: boolean;
}

interface CacheEntry {
  account: BuiltinRelayAccount;
  at: number;
  /** Fingerprint of the key this snapshot belongs to. Kept so a key change
   *  cannot show the previous key's balance; a digest rather than the key
   *  itself, so no second copy of the credential sits in memory. */
  keyFingerprint: string;
}

let cache: CacheEntry | null = null;

/** Drop the snapshot (e.g. after the key is cleared). */
export function forgetAccount(): void {
  cache = null;
}

function fingerprint(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

class AccountError extends Error {}

/**
 * The gateway answers every endpoint with `{ code, message, data }`; its own
 * client returns `data` and ignores the rest. A future/older build might drop
 * the envelope, so both shapes are accepted.
 */
function unwrapEnvelope(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ("data" in record && ("code" in record || "message" in record)) return record.data;
  }
  return value;
}

/** Accept a JSON number or a numeric string; anything else is "unknown". */
function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Read a response body with a hard byte cap, so a hostile or broken server
 *  cannot make the main process buffer unlimited JSON. */
async function readJsonCapped(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new AccountError("中转站返回的数据过大，已中止读取");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new AccountError("中转站返回的数据过大，已中止读取");
  }
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AccountError("中转站返回的不是合法的 JSON");
  }
}

async function requestJson(
  url: string,
  key: string,
  deps: RelayAccountDeps,
): Promise<unknown> {
  const fetchFn: FetchLike = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${key}` },
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    throw new AccountError(
      err instanceof Error && err.name === "AbortError"
        ? "连接中转站超时，请检查网络后重试"
        : "无法连接中转站，请检查网络后重试",
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new AccountError("中转站 API Key 无效或已失效");
  }
  if (response.status === 429) throw new AccountError("请求过于频繁，请稍后再试");
  if (!response.ok) throw new AccountError(`中转站返回 HTTP ${response.status}`);
  return readJsonCapped(response);
}

/** `balance` is a nano-unit integer on the profile; the key's own usage rows
 *  carry `billed_nano` / `*_token` / `request_success` / `request_failed`. */
function parseUsage(raw: unknown): {
  spentNano: number | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  requests: number | null;
} {
  const body = unwrapEnvelope(raw);
  const rows = Array.isArray(body) ? body : body && typeof body === "object" ? [body] : [];

  let spent: number | null = null;
  let input: number | null = null;
  let cached: number | null = null;
  let output: number | null = null;
  let requests: number | null = null;

  const add = (current: number | null, next: number | null): number | null =>
    next === null ? current : (current ?? 0) + next;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    spent = add(spent, num(record.billed_nano));
    input = add(input, num(record.input_token));
    cached = add(cached, num(record.cached_token));
    output = add(output, num(record.output_token));
    const success = num(record.request_success);
    const failed = num(record.request_failed);
    if (success !== null || failed !== null) {
      requests = add(requests, (success ?? 0) + (failed ?? 0));
    }
  }

  return {
    spentNano: spent,
    inputTokens: input,
    cachedTokens: cached,
    outputTokens: output,
    requests,
  };
}

/**
 * Fetch the balance and usage for the stored key.
 *
 * ONE request. `GET /api/v1/apikey/stats` answers `{ balance, stats, info }`
 * inside the gateway's `{ code, message, data }` envelope, so the money and the
 * usage always carry the same timestamp — reading them from two endpoints could
 * show a balance that predates the spend printed next to it.
 *
 * There is no separate "is this key valid" probe any more: stats is itself
 * key-authenticated, so an unusable key fails here with exactly the same 401
 * and there is no second endpoint left to blame.
 */
export async function fetchAccount(deps: RelayAccountDeps = {}): Promise<BuiltinRelayAccount> {
  const key = (deps.resolveKey ?? (() => resolveApiKey(BUILTIN_RELAY_ID)))()?.trim();
  if (!key) throw new AccountError("尚未保存中转站 API Key");

  const keyFingerprint = fingerprint(key);
  if (!deps.noCache && cache && cache.keyFingerprint === keyFingerprint && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.account;
  }

  const raw = unwrapEnvelope(await requestJson(BUILTIN_RELAY_ACCOUNT_STATS_URL, key, deps));
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const balanceNano = num(body.balance);
  if (balanceNano === null) throw new AccountError("中转站没有返回余额");

  const account: BuiltinRelayAccount = BuiltinRelayAccountSchema.parse({
    balanceNano,
    // `stats` is a single aggregate row; `parseUsage` also sums arrays, which
    // keeps it usable if the gateway ever splits this per day.
    ...parseUsage(body.stats),
    fetchedAt: new Date().toISOString(),
  });
  cache = { account, at: Date.now(), keyFingerprint };
  return account;
}

export const RelayAccountStore = {
  fetchAccount,
  forgetAccount,
};
