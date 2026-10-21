/**
 * Remote config for the built-in 「中转站」(TODO-074).
 *
 * The relay's address is fixed in `@contracts/builtinRelay`; the only thing
 * that moves is its model list. That list lives in a document the relay server
 * publishes (`/relay-config.json`) and that the administrator panel pushes
 * (`POST /admin/relay-config`). This store owns both directions plus the local
 * cache, so `sharedProviderStore.listPublic()` can assemble the relay row
 * synchronously without any network work on the settings path.
 *
 * Three sources, in order of preference:
 *   remote  — freshly fetched (kept in the DB cache so a restart shows it)
 *   cache   — last fetched/pushed document
 *   bundled — `BUILTIN_RELAY_FALLBACK_CONFIG` (offline first run)
 *
 * Everything read from the wire or the DB goes through `RelayConfigSchema`,
 * a strict object that has no address fields at all. A tampered or future
 * document cannot redirect a user's key; it can only fail validation.
 */
import { safeStorage } from "electron";
import {
  BUILTIN_RELAY_BASE_URL,
  BUILTIN_RELAY_CONFIG_URL,
  BUILTIN_RELAY_FALLBACK_CONFIG,
  BUILTIN_RELAY_PUSH_URL,
  BuiltinRelayPushInputSchema,
  RelayConfigSchema,
  diffRelayConfigs,
  type BuiltinRelayPushResult,
  type BuiltinRelayStatus,
  type RelayConfig,
} from "@contracts/builtinRelay";
import { getDb } from "@main/store/db.js";

/** Settings key holding the cached document + its provenance. */
const CONFIG_KEY = "builtinRelay.config";
/** Settings key holding the encrypted admin token (never the plaintext). */
const ADMIN_TOKEN_KEY = "builtinRelay.adminToken";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RelayConfigDeps {
  /** Test seam; production uses the global fetch. */
  fetch?: FetchLike;
  /** Test seam; production uses REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

interface CachedConfig {
  config: RelayConfig;
  /** ISO timestamp the document was fetched from / accepted by the server. */
  fetchedAt: string;
  /** Source that produced this cache entry. */
  source: "remote" | "push";
}

function readSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

function deleteSetting(key: string): void {
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(key);
}

/** Parse the cached document. A corrupt or hand-edited row degrades to the
 *  bundled config instead of breaking the settings page. */
function readCache(): CachedConfig | null {
  const raw = readSetting(CONFIG_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { config?: unknown; fetchedAt?: unknown; source?: unknown };
    const config = RelayConfigSchema.parse(parsed.config);
    if (typeof parsed.fetchedAt !== "string") return null;
    const source = parsed.source === "push" ? "push" : "remote";
    return { config, fetchedAt: parsed.fetchedAt, source };
  } catch {
    return null;
  }
}

function writeCache(config: RelayConfig, source: "remote" | "push"): CachedConfig {
  const entry: CachedConfig = { config, fetchedAt: new Date().toISOString(), source };
  writeSetting(CONFIG_KEY, JSON.stringify(entry));
  return entry;
}

/** The config the app currently runs on. Never throws. */
export function currentConfig(): RelayConfig {
  return readCache()?.config ?? BUILTIN_RELAY_FALLBACK_CONFIG;
}

/** Full status for 设置 → 关于 and the shared-provider card. */
export function currentStatus(): BuiltinRelayStatus {
  const cache = readCache();
  return {
    baseUrl: BUILTIN_RELAY_BASE_URL,
    config: cache?.config ?? BUILTIN_RELAY_FALLBACK_CONFIG,
    source: cache ? "cache" : "bundled",
    updatedAt: cache?.fetchedAt ?? BUILTIN_RELAY_FALLBACK_CONFIG.updatedAt ?? null,
    hasAdminToken: hasAdminToken(),
  };
}

function encryptRequired(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("系统安全存储不可用，无法保存管理员令牌");
  }
  return safeStorage.encryptString(value).toString("base64");
}

/** Decrypt the stored admin token, or null. Never logged, never returned over
 *  IPC — only `hasAdminToken` leaves this process. */
function readAdminToken(): string | null {
  const cipher = readSetting(ADMIN_TOKEN_KEY);
  if (!cipher) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const token = safeStorage.decryptString(Buffer.from(cipher, "base64")).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function hasAdminToken(): boolean {
  return readAdminToken() !== null;
}

export function setAdminToken(token: string): BuiltinRelayStatus {
  writeSetting(ADMIN_TOKEN_KEY, encryptRequired(token.trim()));
  return currentStatus();
}

export function clearAdminToken(): BuiltinRelayStatus {
  deleteSetting(ADMIN_TOKEN_KEY);
  return currentStatus();
}

/** Read a response body with a hard byte cap, so a hostile or broken server
 *  cannot make the main process buffer unlimited JSON. */
async function readJsonCapped(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("配置文件过大，已中止读取");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("配置文件过大，已中止读取");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("配置文件不是合法的 JSON");
  }
}

/**
 * Fetch `/relay-config.json` and cache it. Failures leave the previous cache
 * untouched (an offline laptop keeps working on the last known model list).
 */
export async function refresh(deps: RelayConfigDeps = {}): Promise<BuiltinRelayStatus> {
  const fetchFn: FetchLike = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchFn(BUILTIN_RELAY_CONFIG_URL, {
      method: "GET",
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`中转站配置获取失败：HTTP ${response.status}`);
    const document = await readJsonCapped(response);
    const parsed = RelayConfigSchema.safeParse(document);
    if (!parsed.success) throw new Error("中转站配置格式无效");
    writeCache({ ...parsed.data, updatedAt: parsed.data.updatedAt ?? new Date().toISOString() }, "remote");
    return { ...currentStatus(), source: "remote" };
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort refresh used on app start and after the panel opens. Swallows
 *  every failure: the bundled/cached list stays in use. */
export async function refreshQuietly(deps: RelayConfigDeps = {}): Promise<BuiltinRelayStatus> {
  try {
    return await refresh(deps);
  } catch {
    return currentStatus();
  }
}

/**
 * Push the admin panel's draft to the relay server. The server is the source of
 * truth — the local cache is only updated from a config the server accepted, so
 * what the admin sees afterwards is what clients will fetch.
 */
export async function push(config: unknown, deps: RelayConfigDeps = {}): Promise<BuiltinRelayPushResult> {
  const { config: next } = BuiltinRelayPushInputSchema.parse({ config });
  const token = readAdminToken();
  if (!token) throw new Error("尚未配置管理员令牌，无法推送");
  const previous = currentConfig();
  const fetchFn: FetchLike = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchFn(BUILTIN_RELAY_PUSH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ...next, updatedAt: new Date().toISOString() }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (response.status === 401 || response.status === 403) throw new Error("管理员令牌无效或已过期");
    if (!response.ok) throw new Error(`推送失败：HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
  const accepted: RelayConfig = { ...next, updatedAt: new Date().toISOString() };
  writeCache(accepted, "push");
  const diff = diffRelayConfigs(previous, accepted);
  return {
    status: { ...currentStatus(), source: "remote" },
    added: diff.added.length,
    changed: diff.changed.length,
    removed: diff.removed.length,
  };
}

export const RelayConfigStore = {
  currentConfig,
  currentStatus,
  refresh,
  refreshQuietly,
  push,
  setAdminToken,
  clearAdminToken,
  hasAdminToken,
};
