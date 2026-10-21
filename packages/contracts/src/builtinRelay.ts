/**
 * 内置「中转站」— contracts (TODO-074).
 *
 * The relay is NOT a new provider system and not a local gateway: it is one
 * reserved 公用模型提供商 entry that ships with the app. Everything that
 * describes WHERE it points (base URL, protocols, engines) is fixed in this
 * file — locked in code, exactly like a user's own provider row, except the
 * address can never be edited, so a user's relay key can never be redirected
 * to another host (neither by the UI nor by a remote config file).
 *
 * What the remote config (`relay-config.json`) may deliver is the MODEL LIST
 * only. `RelayConfigSchema` is a strict object with no `baseUrl` /
 * `modelsEndpoint` / `endpointOverrides` key at all, so a config that tries to
 * do more than publish models fails validation instead of being honored.
 *
 * The administrator edits this config inside MarioCode (设置 → 关于) and pushes
 * it to the relay server; clients read the same document back. See
 * docs/MarioCode-TODO.md TODO-074.
 */
import { z } from "zod";
import {
  SharedProviderModelSchema,
  resolveSharedModelProtocol,
  type SharedProviderAgent,
  type SharedProviderModel,
  type SharedProviderProtocol,
  type SharedProviderPublic,
} from "./sharedProvider.js";

/**
 * Reserved provider id. A fixed, obviously-synthetic UUID v4 so it can never
 * collide with a `randomUUID()` provider and is instantly recognizable in a
 * settings dump. `sharedRuntimeId(BUILTIN_RELAY_ID) === "shared_0000...0001"`.
 */
export const BUILTIN_RELAY_ID = "00000000-0000-4000-8000-000000000001";

/** True for the reserved relay id. Accepts `string | undefined` so call
 *  callers can pass a draft id straight through. */
export function isBuiltinRelayId(id: string | undefined | null): boolean {
  return id === BUILTIN_RELAY_ID;
}

/**
 * Relay address — LOCKED IN CODE, never user-editable, never delivered by the
 * remote config. Changing the relay (or adding a second one) is a code change
 * plus a release, exactly by design: a "provider" whose address a remote
 * document could move is a credential-exfiltration primitive.
 */
export const BUILTIN_RELAY_BASE_URL = "https://ai.marioya.cc.cd";

/** Where clients read the published config from, and where the administrator
 *  panel pushes it to. */
export const BUILTIN_RELAY_CONFIG_PATH = "/relay-config.json";
export const BUILTIN_RELAY_PUSH_PATH = "/admin/relay-config";

/** Published config URL (GET, public, no auth). */
export const BUILTIN_RELAY_CONFIG_URL = `${BUILTIN_RELAY_BASE_URL}${BUILTIN_RELAY_CONFIG_PATH}`;

/** Admin push endpoint (POST, `Authorization: Bearer <管理员令牌>`). */
export const BUILTIN_RELAY_PUSH_URL = `${BUILTIN_RELAY_BASE_URL}${BUILTIN_RELAY_PUSH_PATH}`;

/** Protocols the relay speaks. All three, so all three engines can use it. */
export const BUILTIN_RELAY_PROTOCOLS: SharedProviderProtocol[] = [
  "anthropic",
  "chat-completions",
  "responses",
];

/** Engines the relay is offered to. */
export const BUILTIN_RELAY_AGENTS: SharedProviderAgent[] = ["claude", "codex", "pi"];

/** Default display name (the admin panel may rename it). */
export const BUILTIN_RELAY_NAME = "MarioCode 中转站";

/** Schema version of `relay-config.json`. Bumped only when the shape changes. */
export const RELAY_CONFIG_VERSION = 1;

/**
 * One published model. Same shape as a shared-provider model so the relay
 * entry can be assembled without any translation layer.
 */
export const RelayConfigModelSchema = SharedProviderModelSchema;
export type RelayConfigModel = SharedProviderModel;

/**
 * The published relay config — the ONLY thing the server (and the admin push)
 * may decide about the built-in provider.
 *
 * `.strict()` is the security boundary: an unknown key (a `baseUrl` added by
 * whoever can write the file, a typo'd `models_endpoint`, …) is a hard
 * validation error, not silently ignored.
 */
export const RelayConfigSchema = z
  .object({
    version: z.literal(RELAY_CONFIG_VERSION),
    /** ISO timestamp of the last admin push; display-only. */
    updatedAt: z.string().trim().min(1).max(64).optional(),
    /** Display name of the provider card. */
    name: z.string().trim().min(1).max(64).optional(),
    models: z.array(RelayConfigModelSchema).min(1).max(1_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.models.map((model) => model.id)).size !== value.models.length) {
      ctx.addIssue({ code: "custom", message: "model ids must be unique" });
    }
    for (const model of value.models) {
      if (model.interfaces && new Set(model.interfaces).size !== model.interfaces.length) {
        ctx.addIssue({ code: "custom", message: `model interfaces must be unique: ${model.id}` });
      }
      if (model.interfaces?.some((protocol) => !BUILTIN_RELAY_PROTOCOLS.includes(protocol))) {
        ctx.addIssue({ code: "custom", message: `model interfaces must be published by the relay: ${model.id}` });
      }
    }
    // Every enabled engine needs at least one model it can actually route to,
    // otherwise the card would be offered to an engine with nothing to run.
    for (const agent of BUILTIN_RELAY_AGENTS) {
      const usable = value.models.some(
        (model) => resolveSharedModelProtocol(agent, BUILTIN_RELAY_PROTOCOLS, model.interfaces) !== undefined,
      );
      if (!usable) ctx.addIssue({ code: "custom", message: `no model can serve ${agent}` });
    }
  });

export type RelayConfig = z.infer<typeof RelayConfigSchema>;

/** Where the currently shown config came from. */
export type RelayConfigSource = "remote" | "cache" | "bundled";

/**
 * Shipped fallback. Used only before the first successful fetch (offline
 * first run, blocked network). Matches the initial model list published on the
 * relay; once `relay-config.json` is reachable the fetched list wins.
 */
export const BUILTIN_RELAY_FALLBACK_CONFIG: RelayConfig = {
  version: RELAY_CONFIG_VERSION,
  name: BUILTIN_RELAY_NAME,
  models: [
    {
      id: "claude-sonnet-5-5",
      label: "Claude Sonnet 5.5",
      interfaces: [...BUILTIN_RELAY_PROTOCOLS],
      contextWindow: 200_000,
      reasoning: true,
      input: ["text", "image"],
    },
    {
      id: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      interfaces: [...BUILTIN_RELAY_PROTOCOLS],
      contextWindow: 1_000_000,
      reasoning: true,
      input: ["text", "image"],
    },
    {
      id: "gpt-5-codex",
      label: "GPT-5 Codex",
      interfaces: [...BUILTIN_RELAY_PROTOCOLS],
      contextWindow: 400_000,
      reasoning: true,
      input: ["text", "image"],
    },
    {
      id: "deepseek-v4-pro",
      label: "DeepSeek V4 Pro",
      interfaces: [...BUILTIN_RELAY_PROTOCOLS],
      contextWindow: 256_000,
      reasoning: true,
      input: ["text"],
    },
  ],
};

/**
 * Assemble the provider row the shared-provider list shows for the relay.
 * Fixed fields come from this module; `models`/`name` come from the (validated)
 * config; `hasApiKey` answers "has this user entered their personal key yet".
 */
export function builtinRelayProvider(
  config: RelayConfig = BUILTIN_RELAY_FALLBACK_CONFIG,
  hasApiKey = false,
): SharedProviderPublic {
  return {
    id: BUILTIN_RELAY_ID,
    name: config.name ?? BUILTIN_RELAY_NAME,
    baseUrl: BUILTIN_RELAY_BASE_URL,
    protocols: [...BUILTIN_RELAY_PROTOCOLS],
    models: config.models.map((model) => ({
      ...model,
      interfaces: [...new Set(model.interfaces ?? BUILTIN_RELAY_PROTOCOLS)],
    })),
    enabledAgents: [...BUILTIN_RELAY_AGENTS],
    hasApiKey,
  };
}

/** Tolerant read used for anything that already came off the wire. Returns the
 *  shipped fallback when the document does not validate. */
export function parseRelayConfig(value: unknown): RelayConfig | null {
  const parsed = RelayConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Snapshot of the relay's config state, as shown in 设置 → 关于 and consumed
 *  by the shared-provider panel. */
export interface BuiltinRelayStatus {
  /** Address, locked in code (display only). */
  baseUrl: string;
  /** Currently effective config. */
  config: RelayConfig;
  source: RelayConfigSource;
  /** When the effective config was fetched/pushed (ISO), if known. */
  updatedAt: string | null;
  /** Whether this machine holds an admin token (never the token itself). */
  hasAdminToken: boolean;
}

export const BuiltinRelaySetAdminTokenInputSchema = z
  .object({ token: z.string().trim().min(1).max(4_096) })
  .strict();
export type BuiltinRelaySetAdminTokenInput = z.infer<typeof BuiltinRelaySetAdminTokenInputSchema>;

/** `builtinRelay.push` input: the config the admin panel built. Re-validated in
 *  main — a renderer is not a trust boundary. */
export const BuiltinRelayPushInputSchema = z.object({ config: RelayConfigSchema }).strict();
export type BuiltinRelayPushInput = z.infer<typeof BuiltinRelayPushInputSchema>;

export interface BuiltinRelayPushResult {
  /** Status after the push (cache updated from the accepted config). */
  status: BuiltinRelayStatus;
  /** Model-count diff the server accepted, for the toast. */
  added: number;
  changed: number;
  removed: number;
}

/** Minimal diff between two configs — drives the admin panel's preview and the
 *  post-push toast. Field-level comparison, id-keyed. */
export function diffRelayConfigs(previous: RelayConfig, next: RelayConfig): {
  added: RelayConfigModel[];
  changed: RelayConfigModel[];
  removed: RelayConfigModel[];
} {
  const before = new Map(previous.models.map((model) => [model.id, JSON.stringify(model)]));
  const after = new Map(next.models.map((model) => [model.id, JSON.stringify(model)]));
  const added = next.models.filter((model) => !before.has(model.id));
  const changed = next.models.filter((model) => {
    const old = before.get(model.id);
    return old !== undefined && old !== JSON.stringify(model);
  });
  const removed = previous.models.filter((model) => !after.has(model.id));
  return { added, changed, removed };
}

/** Engine availability for one model, mirroring `resolveSharedModelProtocol`
 *  but keyed off the fixed relay protocols. Display helper for the admin
 *  panel's diff table. */
export function relayModelAgents(model: RelayConfigModel): SharedProviderAgent[] {
  const interfaces = model.interfaces ?? BUILTIN_RELAY_PROTOCOLS;
  return BUILTIN_RELAY_AGENTS.filter((agent) => {
    const order: SharedProviderProtocol[] =
      agent === "codex"
        ? ["responses", "chat-completions", "anthropic"]
        : ["chat-completions", "anthropic", "responses"];
    return order.some((protocol) => interfaces.includes(protocol));
  });
}
