import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import {
  SharedProviderPublicSchema,
  SharedProviderSaveInputSchema,
  sharedProviderAddsOrigin,
  resolveSharedModelInterfaces,
  sharedRuntimeId,
  type SharedProviderProtocol,
  type SharedProviderPublic,
  type SharedProviderSaveInput,
} from "@contracts/sharedProvider";
import { BUILTIN_RELAY_ID, builtinRelayProvider, isBuiltinRelayId } from "@contracts/builtinRelay";
import { getDb } from "@main/store/db.js";
import { currentConfig as currentRelayConfig } from "@main/lib/relayConfigStore.js";

const META_KEY = "sharedProviders.meta";
const SECRET_KEY = "sharedProviders.keys";
type CipherMap = Record<string, string>;

function readSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function parseMeta(raw = readSetting(META_KEY)): SharedProviderPublic[] {
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Shared provider metadata is corrupt");
  const providers = parsed.map((value) => SharedProviderPublicSchema.parse(value));
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) throw new Error("Shared provider ids are not unique");
  return providers;
}

function parseKeys(raw = readSetting(SECRET_KEY)): CipherMap {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Shared provider key store is corrupt");
  const keys: CipherMap = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new Error("Shared provider key store is corrupt");
    keys[id] = value;
  }
  return keys;
}

function writeBoth(providers: SharedProviderPublic[], keys: CipherMap): void {
  const db = getDb();
  const upsert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.transaction(() => {
    upsert.run(META_KEY, JSON.stringify(providers));
    upsert.run(SECRET_KEY, JSON.stringify(keys));
  })();
}

function encryptRequired(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable; refusing to save an API key");
  return safeStorage.encryptString(value).toString("base64");
}

export function listPublic(): SharedProviderPublic[] {
  const keys = parseKeys();
  // The built-in relay (TODO-074) is prepended and NEVER persisted as a
  // provider row: its address/protocols/engines are constants in
  // @contracts/builtinRelay and its model list comes from the remote config.
  // Only the user's personal key is stored, under the reserved id.
  const builtin = builtinRelayProvider(currentRelayConfig(), decryptCipher(keys[BUILTIN_RELAY_ID]) !== null);
  const stored = parseMeta()
    .filter((provider) => !isBuiltinRelayId(provider.id))
    .map((provider) => ({ ...provider, hasApiKey: decryptCipher(keys[provider.id]) !== null }));
  return [builtin, ...stored];
}

export function getPublic(id: string): SharedProviderPublic | null {
  return listPublic().find((provider) => provider.id === id) ?? null;
}

export function resolveApiKey(id: string): string | null {
  return decryptCipher(parseKeys()[id]);
}

function decryptCipher(cipher: string | undefined): string | null {
  if (!cipher) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try { return safeStorage.decryptString(Buffer.from(cipher, "base64")); }
  catch { return null; }
}

export function resolveRuntimeId(runtimeId: string): SharedProviderPublic | null {
  return listPublic().find((provider) => sharedRuntimeId(provider.id) === runtimeId) ?? null;
}

export function endpointUrl(provider: SharedProviderPublic, protocol: SharedProviderProtocol): string {
  if (!provider.protocols.includes(protocol)) throw new Error(`Shared provider ${provider.id} does not enable protocol ${protocol}`);
  return provider.endpointOverrides?.[protocol] ?? provider.baseUrl;
}

/**
 * The built-in relay accepts exactly one edit: the user's own API key. The
 * address, protocols and engines are constants (`@contracts/builtinRelay`) and
 * the model list is delivered by the remote config, so a draft that carries a
 * different address is either a stale renderer or a hostile one. Refuse it
 * loudly instead of ignoring the field — a silently-dropped address would also
 * mean a key stored for a host the user did not intend.
 */
function saveBuiltinRelayKey(value: SharedProviderSaveInput): SharedProviderPublic[] {
  const expected = builtinRelayProvider(currentRelayConfig(), false);
  if (value.baseUrl !== expected.baseUrl) {
    throw new Error("内置中转站的接口地址由程序固定，不能修改");
  }
  if (value.modelsEndpoint) throw new Error("内置中转站不支持自定义模型接口地址");
  if (value.endpointOverrides && Object.keys(value.endpointOverrides).length > 0) {
    throw new Error("内置中转站不支持按协议自定义接口地址");
  }
  const apiKey = (value.apiKey ?? "").trim();
  if (apiKey.length === 0) throw new Error("请填写你的中转站 API Key");
  const keys = parseKeys();
  keys[BUILTIN_RELAY_ID] = encryptRequired(apiKey);
  writeBoth(
    parseMeta().filter((provider) => !isBuiltinRelayId(provider.id)),
    keys,
  );
  return listPublic();
}

export function save(input: SharedProviderSaveInput): SharedProviderPublic[] {
  const value = SharedProviderSaveInputSchema.parse(input);
  if (isBuiltinRelayId(value.id)) return saveBuiltinRelayKey(value);
  const providers = parseMeta();
  const keys = parseKeys();
  const id = value.id ?? randomUUID();
  const index = providers.findIndex((provider) => provider.id === id);
  if (value.id && index < 0) throw new Error(`Shared provider not found: ${id}`);
  if (!value.id && providers.some((provider) => provider.id === id)) throw new Error(`Shared provider id already exists: ${id}`);
  const apiKey = value.apiKey ?? "";
  if (apiKey.length > 0 && apiKey.trim().length === 0) throw new Error("API key cannot contain only whitespace");
  const previous = index >= 0 ? providers[index]! : null;
  // A stored key may only go where it already went. Editing the PATH of an
  // already-trusted origin keeps it (the common "fix /v1" edit); pointing the
  // provider at a new host/port — or downgrading to http — needs it re-typed.
  if (previous && apiKey.length === 0 && sharedProviderAddsOrigin(previous, value)) {
    throw new Error("接口地址指向了新的服务器；为避免把已保存的密钥发往新目标，请重新填写 API Key 后保存");
  }
  if (apiKey.length > 0) keys[id] = encryptRequired(apiKey);
  if (index < 0 && !keys[id]) throw new Error("A new shared provider requires an API key");
  if (index >= 0 && apiKey.length === 0 && decryptCipher(keys[id]) === null) {
    throw new Error("The saved API key is unavailable or cannot be decrypted; enter it again before saving");
  }
  const provider = SharedProviderPublicSchema.parse({
    id,
    name: value.name,
    baseUrl: value.baseUrl,
    ...(value.modelsEndpoint ? { modelsEndpoint: value.modelsEndpoint } : {}),
    protocols: value.protocols,
    ...(value.endpointOverrides ? { endpointOverrides: value.endpointOverrides } : {}),
    // Freeze inherited capabilities when saving. Enabling a provider protocol
    // later must not silently expand an existing model's supported interfaces.
    models: value.models.map((model) => ({ ...model, interfaces: resolveSharedModelInterfaces(value.protocols, model.interfaces) })),
    hasApiKey: Boolean(keys[id]),
    enabledAgents: value.enabledAgents,
  });
  if (index >= 0) providers[index] = provider;
  else providers.push(provider);
  writeBoth(providers, keys);
  return listPublic();
}

export function remove(id: string): SharedProviderPublic[] {
  // The relay card is part of the app, not user data. Deleting it would just
  // resurrect on the next list() call, so say so instead of pretending.
  if (isBuiltinRelayId(id)) throw new Error("内置中转站不能删除");
  const providers = parseMeta();
  if (!providers.some((provider) => provider.id === id)) throw new Error(`Shared provider not found: ${id}`);
  // Sessions still pointing at a removed provider fail their next turn with
  // an explicit "provider not found" error in every engine; no silent fallback.
  const next = providers.filter((provider) => provider.id !== id);
  const keys = parseKeys();
  delete keys[id];
  writeBoth(next, keys);
  return listPublic();
}

export const SharedProviderStore = {
  listPublic,
  resolveApiKey,
  getPublic,
  resolveRuntimeId,
  endpointUrl,
  save,
  remove,
};
