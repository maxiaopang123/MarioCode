/**
 * Settings for the built-in tools (Settings → 内置工具): the JSON config
 * blob, the encrypted search-API keys, and the per-turn flags the providers
 * read.
 *
 * mario_web_search defaults to keyless Bing / Baidu in a hidden window; the
 * optional keyed backends (博查 / 智谱 / Tavily / Exa / Brave) use the user's
 * key, stored through secretStore's safeStorage wrapper (DPAPI / Keychain /
 * libsecret) under `builtinTools.keys` — it never leaves the main process,
 * the renderer only learns which ones are present. mario_image_generate holds
 * no key of its own: it reuses a shared provider's endpoint + key. The on/off
 * switches are MCP management fields so the MCP panel's built-in rows stay
 * the one switch group for every built-in server.
 */
import {
  BUILTIN_TOOLS_CONFIG_SETTING_KEY,
  MCP_MANAGEMENT_SETTING_KEY,
  WEB_SEARCH_KEYED_BACKENDS,
  parseBuiltinToolsConfig,
  type BuiltinToolsConfig,
  type BuiltinToolsState,
  type ImageToolIssue,
  type McpManagementState,
  type WebSearchKeyedBackend,
} from "@contracts/ipc";
import { SettingRepo } from "@main/store/repositories.js";
import { decrypt, encrypt } from "@main/lib/secretStore.js";
import { getMcpManagement } from "@main/lib/mcpConfig.js";
import { SharedProviderStore } from "@main/lib/sharedProviderStore.js";
import type { ClawBotStatus } from "@contracts/clawbot";
import { clawBotService } from "@main/clawbot/ClawBotService.js";
import type { BuiltinToolFlags } from "./builtinToolSpecs.js";
import { wechatToolStatus } from "./wechatNotify.js";

/** Same settings key as before the custom image endpoint was removed, so
 *  stored 博查 / 智谱 / Tavily keys keep working. */
const KEYS_SETTING_KEY = "builtinTools.keys";
/** Entry of the removed custom image endpoint's key in that map. */
const LEGACY_IMAGE_KEY_ID = "image";
let legacyImageKeyDropped = false;

function parseCipherObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Drop the obsolete `image` entry (the removed custom image endpoint's key)
 *  from the key map once per process, keeping the search keys. Tolerates the
 *  DB not being ready yet (retries on the next call). */
function dropLegacyImageKey(): void {
  if (legacyImageKeyDropped) return;
  legacyImageKeyDropped = true;
  try {
    const map = parseCipherObject(SettingRepo.get(KEYS_SETTING_KEY));
    if (!map || !(LEGACY_IMAGE_KEY_ID in map)) return;
    delete map[LEGACY_IMAGE_KEY_ID];
    // SettingRepo has no delete; an empty value is the "unset" convention.
    SettingRepo.set(KEYS_SETTING_KEY, Object.keys(map).length ? JSON.stringify(map) : "");
  } catch {
    legacyImageKeyDropped = false; // DB not ready yet — try again next call
  }
}

export function readBuiltinToolsConfig(): BuiltinToolsConfig {
  return parseBuiltinToolsConfig(SettingRepo.get(BUILTIN_TOOLS_CONFIG_SETTING_KEY));
}

export function writeBuiltinToolsConfig(config: BuiltinToolsConfig): void {
  SettingRepo.set(BUILTIN_TOOLS_CONFIG_SETTING_KEY, JSON.stringify(config));
}

function readCipherMap(): Partial<Record<WebSearchKeyedBackend, string>> {
  const parsed = parseCipherObject(SettingRepo.get(KEYS_SETTING_KEY));
  if (!parsed) return {};
  const out: Partial<Record<WebSearchKeyedBackend, string>> = {};
  for (const id of WEB_SEARCH_KEYED_BACKENDS) {
    const v = parsed[id];
    if (typeof v === "string" && v) out[id] = v;
  }
  return out;
}

/** Cleartext key, or null when absent / undecryptable. Main-process only. */
export function readBuiltinToolSecret(id: WebSearchKeyedBackend): string | null {
  const cipher = readCipherMap()[id];
  if (!cipher) return null;
  return decrypt(cipher) || null;
}

/** Store (non-empty after trim) or delete (null) one key. */
export function writeBuiltinToolSecret(id: WebSearchKeyedBackend, value: string | null): void {
  dropLegacyImageKey();
  const map = readCipherMap();
  const trimmed = value?.trim() ?? "";
  if (trimmed) map[id] = encrypt(trimmed);
  else delete map[id];
  SettingRepo.set(KEYS_SETTING_KEY, JSON.stringify(map));
}

export type ImageEndpoint =
  | { ok: true; baseUrl: string; apiKey: string; model: string; size: string; label: string }
  | { ok: false; issue: ImageToolIssue };

/** Resolve where mario_image_generate posts: the chosen shared provider's
 *  OpenAI-compatible endpoint and key. */
export function resolveImageEndpoint(config: BuiltinToolsConfig = readBuiltinToolsConfig()): ImageEndpoint {
  const { source, model, size } = config.image;
  // "custom" was the removed custom-endpoint option; treat it as unset.
  if (!source || source === "custom") return { ok: false, issue: "noSource" };
  const provider = SharedProviderStore.getPublic(source);
  if (!provider) return { ok: false, issue: "providerMissing" };
  // The images API sits beside chat/completions on OpenAI-compatible
  // gateways, so prefer that protocol's endpoint (overrides included).
  const protocol = provider.protocols.includes("chat-completions")
    ? "chat-completions"
    : provider.protocols.includes("responses")
      ? "responses"
      : null;
  const endpoint = protocol ? SharedProviderStore.endpointUrl(provider, protocol) : provider.baseUrl;
  const apiKey = SharedProviderStore.resolveApiKey(provider.id);
  if (!model.trim()) return { ok: false, issue: "noModel" };
  if (!apiKey) return { ok: false, issue: "noKey" };
  return { ok: true, baseUrl: endpoint, apiKey, model: model.trim(), size, label: provider.name };
}

/** Which built-in tools this turn registers (read fresh per turn). */
export async function builtinToolFlags(): Promise<BuiltinToolFlags> {
  dropLegacyImageKey();
  const mcp = await getMcpManagement();
  return {
    web: !mcp.webToolsDisabled,
    image: !mcp.imageToolDisabled && resolveImageEndpoint().ok,
    schedule: !mcp.scheduleToolsDisabled,
    // Never-bound ClawBot → don't advertise the tool at all; readiness
    // (activation, credential expiry) is re-checked on every call.
    wechat: !mcp.wechatToolDisabled && clawBotStatus().state !== "unbound",
  };
}

/** ClawBot status, tolerating a credential store that can't be read yet. */
function clawBotStatus(): ClawBotStatus {
  try {
    return clawBotService.getStatus();
  } catch {
    return {
      state: "unbound",
      ready: false,
      accountId: null,
      userId: null,
      boundAt: null,
      lastInteractionAt: null,
      error: null,
    };
  }
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
  dropLegacyImageKey();
  const config = readBuiltinToolsConfig();
  const mcp = await getMcpManagement();
  const ciphers = readCipherMap();
  const image = resolveImageEndpoint(config);
  return {
    config,
    webToolsEnabled: !mcp.webToolsDisabled,
    imageToolEnabled: !mcp.imageToolDisabled,
    browserToolsEnabled: !mcp.browserDisabled,
    scheduleToolsEnabled: !mcp.scheduleToolsDisabled,
    wechatToolEnabled: !mcp.wechatToolDisabled,
    wechatStatus: wechatToolStatus(clawBotStatus()),
    keys: {
      bocha: !!ciphers.bocha,
      zhipu: !!ciphers.zhipu,
      tavily: !!ciphers.tavily,
      exa: !!ciphers.exa,
      brave: !!ciphers.brave,
    },
    imageIssue: image.ok ? null : image.issue,
  };
}
