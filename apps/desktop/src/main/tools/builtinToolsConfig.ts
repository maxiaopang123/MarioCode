/**
 * Settings for the built-in tools (Settings → 内置工具): the JSON config
 * blob, the encrypted API keys, and the per-turn flags the providers read.
 *
 * Keys go through secretStore's safeStorage wrapper (DPAPI / Keychain /
 * libsecret) under `builtinTools.keys` and never leave the main process; the
 * renderer only learns which ones are present. The on/off switches are MCP
 * management fields so the MCP panel's built-in rows stay the one switch
 * group for every built-in server.
 */
import {
  BUILTIN_TOOLS_CONFIG_SETTING_KEY,
  IMAGE_SOURCE_CUSTOM,
  MCP_MANAGEMENT_SETTING_KEY,
  parseBuiltinToolsConfig,
  type BuiltinToolsConfig,
  type BuiltinToolsSecretId,
  type BuiltinToolsState,
  type ImageToolIssue,
  type McpManagementState,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { decrypt, encrypt } from "@main/lib/secretStore.js";
import { getMcpManagement } from "@main/lib/mcpConfig.js";
import { SharedProviderStore } from "@main/lib/sharedProviderStore.js";
import type { BuiltinToolFlags } from "./builtinToolSpecs.js";

const KEYS_SETTING_KEY = "builtinTools.keys";
const SECRET_IDS: readonly BuiltinToolsSecretId[] = ["bocha", "zhipu", "tavily", "image"];

export function readBuiltinToolsConfig(): BuiltinToolsConfig {
  return parseBuiltinToolsConfig(SettingRepo.get(BUILTIN_TOOLS_CONFIG_SETTING_KEY));
}

export function writeBuiltinToolsConfig(config: BuiltinToolsConfig): void {
  SettingRepo.set(BUILTIN_TOOLS_CONFIG_SETTING_KEY, JSON.stringify(config));
}

function readCipherMap(): Partial<Record<BuiltinToolsSecretId, string>> {
  const raw = SettingRepo.get(KEYS_SETTING_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Partial<Record<BuiltinToolsSecretId, string>> = {};
    for (const id of SECRET_IDS) {
      const v = (parsed as Record<string, unknown>)[id];
      if (typeof v === "string" && v) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Cleartext key, or null when absent / undecryptable. Main-process only. */
export function readBuiltinToolSecret(id: BuiltinToolsSecretId): string | null {
  const cipher = readCipherMap()[id];
  if (!cipher) return null;
  return decrypt(cipher) || null;
}

/** Store (non-empty after trim) or delete (null) one key. */
export function writeBuiltinToolSecret(id: BuiltinToolsSecretId, value: string | null): void {
  const map = readCipherMap();
  const trimmed = value?.trim() ?? "";
  if (trimmed) map[id] = encrypt(trimmed);
  else delete map[id];
  SettingRepo.set(KEYS_SETTING_KEY, JSON.stringify(map));
}

export type ImageEndpoint =
  | { ok: true; baseUrl: string; apiKey: string; model: string; size: string; label: string }
  | { ok: false; issue: ImageToolIssue };

/** Resolve where image_generate posts: a shared provider's OpenAI-compatible
 *  endpoint and key, or the custom endpoint + key saved on the page. */
export function resolveImageEndpoint(config: BuiltinToolsConfig = readBuiltinToolsConfig()): ImageEndpoint {
  const { source, baseUrl, model, size } = config.image;
  if (!source) return { ok: false, issue: "noSource" };
  let endpoint: string;
  let apiKey: string | null;
  let label: string;
  if (source === IMAGE_SOURCE_CUSTOM) {
    if (!baseUrl.trim()) return { ok: false, issue: "noBaseUrl" };
    endpoint = baseUrl.trim();
    apiKey = readBuiltinToolSecret("image");
    label = endpoint;
  } else {
    const provider = SharedProviderStore.getPublic(source);
    if (!provider) return { ok: false, issue: "providerMissing" };
    // The images API sits beside chat/completions on OpenAI-compatible
    // gateways, so prefer that protocol's endpoint (overrides included).
    const protocol = provider.protocols.includes("chat-completions")
      ? "chat-completions"
      : provider.protocols.includes("responses")
        ? "responses"
        : null;
    endpoint = protocol ? SharedProviderStore.endpointUrl(provider, protocol) : provider.baseUrl;
    apiKey = SharedProviderStore.resolveApiKey(provider.id);
    label = provider.name;
  }
  if (!model.trim()) return { ok: false, issue: "noModel" };
  if (!apiKey) return { ok: false, issue: "noKey" };
  return { ok: true, baseUrl: endpoint, apiKey, model: model.trim(), size, label };
}

/** Which built-in tools this turn registers (read fresh per turn). */
export async function builtinToolFlags(): Promise<BuiltinToolFlags> {
  const mcp = await getMcpManagement();
  return {
    web: !mcp.webToolsDisabled,
    image: !mcp.imageToolDisabled && resolveImageEndpoint().ok,
  };
}

/** Synchronous web-tools switch, for message text built in sync code paths
 *  (the browser tools' search-engine refusal). */
export function webToolsEnabledSync(): boolean {
  try {
    const raw = SettingRepo.get(MCP_MANAGEMENT_SETTING_KEY);
    const state = raw ? (JSON.parse(raw) as McpManagementState) : {};
    return !state.webToolsDisabled;
  } catch {
    return true;
  }
}

export async function builtinToolsState(): Promise<BuiltinToolsState> {
  const config = readBuiltinToolsConfig();
  const mcp = await getMcpManagement();
  const ciphers = readCipherMap();
  const image = resolveImageEndpoint(config);
  return {
    config,
    webToolsEnabled: !mcp.webToolsDisabled,
    imageToolEnabled: !mcp.imageToolDisabled,
    keys: {
      bocha: !!ciphers.bocha,
      zhipu: !!ciphers.zhipu,
      tavily: !!ciphers.tavily,
      image: !!ciphers.image,
    },
    imageIssue: image.ok ? null : image.issue,
  };
}
