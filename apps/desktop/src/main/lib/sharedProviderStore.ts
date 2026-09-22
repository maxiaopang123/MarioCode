import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import {
  SharedProviderPublicSchema,
  SharedProviderSaveInputSchema,
  sharedRuntimeId,
  type SharedProviderProtocol,
  type SharedProviderPublic,
  type SharedProviderSaveInput,
} from "@contracts/sharedProvider";
import { getDb } from "@main/store/db.js";

const META_KEY = "sharedProviders.meta";
const SECRET_KEY = "sharedProviders.keys";
type CipherMap = Record<string, string>;

function normalizedUrl(value: string): string {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

function routingFingerprint(value: Pick<SharedProviderSaveInput, "baseUrl" | "modelsEndpoint" | "endpointOverrides" | "protocols" | "models">): string {
  const endpointOverrides = Object.entries(value.endpointOverrides ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([protocol, url]) => [protocol, normalizedUrl(url)]);
  return JSON.stringify({
    baseUrl: normalizedUrl(value.baseUrl),
    modelsEndpoint: value.modelsEndpoint ? normalizedUrl(value.modelsEndpoint) : null,
    endpointOverrides,
    protocols: [...value.protocols].sort(),
    modelInterfaces: value.models
      .map((model) => ({ id: model.id, interfaces: model.interfaces ?? null }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
}

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

function referencedSession(runtimeId: string): { id: string } | undefined {
  return getDb().prepare(
    "SELECT id FROM sessions WHERE custom_model_id = ? OR model = ? OR substr(model, 1, length(?) + 1) = ? LIMIT 1",
  ).get(runtimeId, runtimeId, runtimeId, `${runtimeId}/`) as { id: string } | undefined;
}

export function listPublic(): SharedProviderPublic[] {
  const keys = parseKeys();
  return parseMeta().map((provider) => ({ ...provider, hasApiKey: decryptCipher(keys[provider.id]) !== null }));
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

export function save(input: SharedProviderSaveInput): SharedProviderPublic[] {
  const value = SharedProviderSaveInputSchema.parse(input);
  const providers = parseMeta();
  const keys = parseKeys();
  const id = value.id ?? randomUUID();
  const index = providers.findIndex((provider) => provider.id === id);
  if (value.id && index < 0) throw new Error(`Shared provider not found: ${id}`);
  if (!value.id && providers.some((provider) => provider.id === id)) throw new Error(`Shared provider id already exists: ${id}`);
  const apiKey = value.apiKey ?? "";
  if (apiKey.length > 0 && apiKey.trim().length === 0) throw new Error("API key cannot contain only whitespace");
  const previous = index >= 0 ? providers[index]! : null;
  if (previous && apiKey.length === 0 && routingFingerprint(previous) !== routingFingerprint(value)) {
    throw new Error("The provider endpoint or protocols changed; enter the API key again before saving so the saved key is never reused with a new destination");
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
    models: value.models,
    hasApiKey: Boolean(keys[id]),
    enabledAgents: value.enabledAgents,
  });
  if (index >= 0) {
    const removedModel = previous!.models.some((model) => !provider.models.some((next) => next.id === model.id));
    const disabledAgent = previous!.enabledAgents.some((agent) => !provider.enabledAgents.includes(agent));
    if ((removedModel || disabledAgent) && referencedSession(sharedRuntimeId(id))) {
      throw new Error("Shared provider is used by an existing session; its models and enabled agents cannot be removed");
    }
  }
  if (index >= 0) providers[index] = provider;
  else providers.push(provider);
  writeBoth(providers, keys);
  return listPublic();
}

export function remove(id: string): SharedProviderPublic[] {
  const providers = parseMeta();
  if (!providers.some((provider) => provider.id === id)) throw new Error(`Shared provider not found: ${id}`);
  const runtimeId = sharedRuntimeId(id);
  const referenced = referencedSession(runtimeId);
  if (referenced) throw new Error(`Shared provider is used by session ${referenced.id}; reassign that session before removing it`);
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
