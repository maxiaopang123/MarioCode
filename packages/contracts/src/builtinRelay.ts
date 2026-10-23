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
 *
 * Bare origin, no `/v1`: the per-protocol URL builders append the version and
 * path themselves (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`),
 * so a `…/v1` suffix here would only risk doubling it.
 */
export const BUILTIN_RELAY_BASE_URL = "http://39.109.58.6:8090";

/**
 * Origin that serves the PUBLISHED CONFIG — deliberately a different host:port
 * from `BUILTIN_RELAY_BASE_URL`.
 *
 * The two are separate processes: :8090 is the inference gateway every
 * request's API key flows through, :18505 is a ~300-line service that only
 * reads and writes one JSON file. Keeping the admin write endpoint off the
 * gateway means the whole publish path can be restarted, or even taken down,
 * without touching inference — and it gives the write endpoint its own, much
 * smaller blast radius.
 */
export const BUILTIN_RELAY_CONFIG_BASE_URL = "http://39.109.58.6:18505";

/** Where clients read the published config from, and where the administrator
 *  panel pushes it to. */
export const BUILTIN_RELAY_CONFIG_PATH = "/relay-config.json";
export const BUILTIN_RELAY_PUSH_PATH = "/admin/relay-config";
/**
 * Auth probe: 200 with the admin password, 401 without it. Lets the unlock
 * screen answer "is this the right password?" WITHOUT publishing anything.
 *
 * "The admin password" is the mariogate panel's `admin` account password — the
 * config service has no secret of its own and validates it by logging in to the
 * gateway. Changing the gateway password changes this one, nothing to re-deploy.
 */
export const BUILTIN_RELAY_VERIFY_PATH = "/admin/verify";

/**
 * The relay's own model inventory (GET, admin). One row per gateway group,
 * already reduced to what the panel needs: which protocols that group can serve
 * and whether it is listed/available.
 *
 * This exists so the panel can fill its model list from the relay instead of
 * having the administrator type it in. The read happens server-side, over the
 * gateway's HTTP API — the config service never opens the gateway's database.
 */
export const BUILTIN_RELAY_MODELS_PATH = "/admin/models";

/** Published config URL (GET, public, no auth). */
export const BUILTIN_RELAY_CONFIG_URL = `${BUILTIN_RELAY_CONFIG_BASE_URL}${BUILTIN_RELAY_CONFIG_PATH}`;

/** Admin push endpoint (POST, `Authorization: Bearer <管理员密码>`). */
export const BUILTIN_RELAY_PUSH_URL = `${BUILTIN_RELAY_CONFIG_BASE_URL}${BUILTIN_RELAY_PUSH_PATH}`;

/** Admin auth probe (GET, `Authorization: Bearer <管理员密码>`). */
export const BUILTIN_RELAY_VERIFY_URL = `${BUILTIN_RELAY_CONFIG_BASE_URL}${BUILTIN_RELAY_VERIFY_PATH}`;

/** Relay inventory (GET, `Authorization: Bearer <管理员密码>`). */
export const BUILTIN_RELAY_MODELS_URL = `${BUILTIN_RELAY_CONFIG_BASE_URL}${BUILTIN_RELAY_MODELS_PATH}`;

/**
 * Account endpoints — the gateway's own REST surface (the "mariogate" panel
 * served by the same process on :8090).
 *
 * These are a DIFFERENT service from the config endpoints above: :18505 only
 * holds a JSON file, whereas these read the gateway's database. Both are
 * reached with the user's own API key, never with an admin credential.
 *
 * Auth is `Authorization: Bearer <api key>` — in the gateway's API-key mode
 * the key IS the bearer token, so no separate session cookie is involved.
 *
 * The two `/api/v1/me` endpoints are NOT usable here, and that is not an
 * accident of this client: the gateway guards them with `UserAuth()`, which
 * reads **only its panel's `auth` cookie** (a JWT issued by the web console) and
 * never looks at the Authorization header. A per-user API key therefore gets a
 * 401 from `/api/v1/me` no matter how valid it is. Only the `/api/v1/apikey/*`
 * group (`APIKeyAuth`: `x-api-key` or `Authorization: Bearer`, hash lookup,
 * enabled/expiry/balance checks) and the `/v1/*` inference routes accept a key.
 * Balance and usage are read from that group instead.
 */
export const BUILTIN_RELAY_API_PREFIX = `${BUILTIN_RELAY_BASE_URL}/api/v1`;

/**
 * Balance of the key's owner **plus** this key's cumulative usage, in one call.
 *
 * Shape: `{ data: { balance, stats: { billed_nano, input_token, output_token,
 * cached_token, request_success, request_failed, … }, info: {…} } }` — `balance`
 * is nano-units (1 USD = 1e9) and is 0 for an admin-owned key (user_id 0), which
 * has no user balance of its own. `balance` is an addition to the upstream
 * gateway (upstream only returned `stats` + `info`); without it a key can never
 * see its own remaining money.
 */
export const BUILTIN_RELAY_ACCOUNT_STATS_URL = `${BUILTIN_RELAY_API_PREFIX}/apikey/stats`;

/** Protocols the relay speaks. All three, so all three engines can use it. */
export const BUILTIN_RELAY_PROTOCOLS: SharedProviderProtocol[] = [
  "anthropic",
  "chat-completions",
  "responses",
];

/** Same list, as a zod enum. Derived from the constant above so the two can
 *  never drift; the cast is only needed because the constant is an array. */
const RELAY_PROTOCOL_ENUM = z.enum(
  BUILTIN_RELAY_PROTOCOLS as [SharedProviderProtocol, ...SharedProviderProtocol[]],
);

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
 * first run, blocked network). Mirrors the model list currently published on
 * the relay; once `relay-config.json` is reachable the fetched list wins.
 *
 * Source of truth is the gateway's own published catalogue — `groups WHERE
 * listed = 1` — **not** `channel_models`. That table only says "some channel can
 * run this upstream name": those names are often unroutable (no group behind
 * them) or spelled differently (`qwen3.8-max-0902` there vs `qwen3.8-max` as the
 * group clients actually request). `interfaces` mirrors `channel_grants.protocols`
 * (2 = chat-completions, 4 = responses, 8 = anthropic) — over-claiming a protocol
 * here only surfaces later as a runtime error for that engine.
 *
 * ARRAY ORDER IS THE DISPLAY ORDER. Nothing in the app sorts this list — the
 * settings card, the admin table and the composer's model menu all render it
 * as published — so the order below IS the user-facing grouping:
 *   1. Claude (anthropic only)
 *   2. GPT 与同级国际模型 (chat-completions + responses: GPT / Gemini / Grok)
 *   3. 国产模型 (chat-completions: Kimi / GLM / DeepSeek / Minimax / Qwen)
 *   4. 生图模型 (image generation; they route through /images/*, not a chat protocol)
 * Keep the remote `relay-config.json` in this same order: it is the copy that
 * actually reaches users, and the two drifting apart makes the offline
 * fallback look like a different product.
 *
 * Refreshed 2026-10-24 from the live inventory (`GET /admin/models`): 24 groups,
 * all listed. The three `oc/…-free` entries that used to sit here were removed
 * with their groups — the gateway no longer publishes them, so keeping them
 * would only have offered users a model that answers 404.
 */
export const BUILTIN_RELAY_FALLBACK_CONFIG: RelayConfig = {
  version: RELAY_CONFIG_VERSION,
  name: BUILTIN_RELAY_NAME,
  models: [
    // 1 — Claude, anthropic protocol only.
    { id: "claude-opus-5-5", interfaces: ["anthropic"], reasoning: true, input: ["text", "image"] },
    { id: "claude-opus-5-5-MAX", interfaces: ["anthropic"], reasoning: true, input: ["text", "image"] },
    { id: "claude-sonnet-5-5", interfaces: ["anthropic"], reasoning: true, input: ["text", "image"] },
    { id: "claude-sonnet-5-5-MAX", interfaces: ["anthropic"], reasoning: true, input: ["text", "image"] },
    { id: "claude-haiku-5-5", interfaces: ["anthropic"], reasoning: true, input: ["text", "image"] },
    // 2 — GPT and the same-tier international models (chat + responses).
    { id: "gpt-5.6-sol", interfaces: ["chat-completions", "responses"], reasoning: true, input: ["text", "image"] },
    { id: "gpt-6-astra", interfaces: ["chat-completions", "responses"], reasoning: true, input: ["text", "image"] },
    { id: "gpt-6-sol", interfaces: ["chat-completions", "responses"], reasoning: true, input: ["text", "image"] },
    { id: "gpt-6.1-sol", interfaces: ["chat-completions", "responses"], reasoning: true, input: ["text", "image"] },
    { id: "gemini-3.8-flash-high", interfaces: ["chat-completions", "responses"], reasoning: true, input: ["text", "image"] },
    { id: "grok-4.7", interfaces: ["chat-completions", "responses", "anthropic"], reasoning: true, input: ["text", "image"] },
    { id: "grok-4.6", interfaces: ["chat-completions", "responses", "anthropic"], reasoning: true, input: ["text", "image"] },
    // 3 — 国产模型 (chat-completions).
    { id: "kimi-k3", interfaces: ["chat-completions"], reasoning: true, input: ["text", "image"] },
    { id: "glm-5.3", interfaces: ["chat-completions"], reasoning: true, input: ["text", "image"] },
    { id: "glm-5.3-flash", interfaces: ["chat-completions"], reasoning: true, input: ["text", "image"] },
    { id: "deepseek-v4.1-flash", interfaces: ["chat-completions"], reasoning: true, input: ["text", "image"] },
    { id: "minimax-m3.1-flash", interfaces: ["chat-completions"], reasoning: true, input: ["text", "image"] },
    { id: "qwen3.8-max", interfaces: ["chat-completions"], reasoning: true, input: ["text", "image"] },
    { id: "qwen3.8-flash", interfaces: ["chat-completions"], reasoning: true, input: ["text", "image"] },
    // 4 — 生图模型 (image generation only).
    { id: "gpt-image-2", interfaces: ["chat-completions"], input: ["text", "image"], imageGeneration: true },
    { id: "gpt-image-2.5-flare", interfaces: ["chat-completions"], input: ["text", "image"], imageGeneration: true },
    { id: "gpt-image-2.5-sunburst", interfaces: ["chat-completions"], input: ["text", "image"], imageGeneration: true },
    { id: "grok-imagine-image-2.0", interfaces: ["responses", "anthropic"], input: ["text", "image"], imageGeneration: true },
    { id: "grok-imagine-image-quality", interfaces: ["responses", "anthropic"], input: ["text", "image"], imageGeneration: true },
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
  /** Whether this machine holds a VERIFIED admin password (never the password
   *  itself). False means 设置 → 关于 shows the lock screen, not the editor. */
  hasAdminToken: boolean;
}

/** `builtinRelay.unlock` input: the administrator password, i.e. the mariogate
 *  panel's `admin` password. It is verified by the relay server (which checks it
 *  against the gateway's own login) before being stored — see
 *  `RelayConfigStore.unlock`. */
export const BuiltinRelayUnlockInputSchema = z
  .object({ token: z.string().trim().min(1).max(4_096) })
  .strict();
export type BuiltinRelayUnlockInput = z.infer<typeof BuiltinRelayUnlockInputSchema>;

/** `builtinRelay.account` input. Re-validated in main — a renderer is not a
 *  trust boundary; `force` only decides whether the snapshot cache is bypassed. */
export const BuiltinRelayAccountQuerySchema = z
  .object({ force: z.boolean().optional() })
  .strict()
  .optional();
export type BuiltinRelayAccountQuery = z.infer<typeof BuiltinRelayAccountQuerySchema>;

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

/**
 * One row of the relay's own inventory (`GET /admin/models`).
 *
 * `interfaces` is derived on the server from each group's channel-grant protocol
 * bitmask — the union over the members that can forward right now — so it is
 * already in this app's vocabulary and the panel re-derives nothing.
 */
export const RelayInventoryModelSchema = z
  .object({
    id: z.string().trim().min(1).max(256),
    /** Publishes to users (`groups.listed`). Unlisted groups are still returned,
     *  so the panel can report "this exists but is not published". */
    listed: z.boolean(),
    /** At least one member can forward right now. */
    available: z.boolean(),
    interfaces: z.array(RELAY_PROTOCOL_ENUM).min(1).max(3),
    imageGeneration: z.boolean(),
  })
  .strict();
export type RelayInventoryModel = z.infer<typeof RelayInventoryModelSchema>;

/** The relay's inventory as of `fetchedAt`. Read-only: it is not a config, and
 *  nothing about it is cached or published until the administrator pushes. */
export const RelayInventorySchema = z
  .object({
    fetchedAt: z.string().trim().min(1).max(64),
    models: z.array(RelayInventoryModelSchema).max(1_000),
  })
  .strict();
export type RelayInventory = z.infer<typeof RelayInventorySchema>;

/**
 * A snapshot of the current key's standing on the relay, as returned by
 * `builtinRelay.account`.
 *
 * Money is carried in **nano-units** (1e9 = one unit of the relay's currency),
 * because that is how the gateway's database stores it. Converting to a
 * human-readable amount is a display concern and happens in the renderer —
 * keeping the raw integer here means no rounding is baked into the contract.
 *
 * Every usage field is nullable: the profile endpoint and the usage endpoint
 * are separate calls, and the panel is more useful showing a balance with a
 * dash for usage than showing nothing at all when one of them fails.
 */
export const BuiltinRelayAccountSchema = z
  .object({
    /** Current balance in nano-units. May legitimately be negative. */
    balanceNano: z.number(),
    /** Cumulative spend for this key, or null when usage could not be read. */
    spentNano: z.number().nullable(),
    inputTokens: z.number().nullable(),
    cachedTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    /** Total requests (successful + failed) behind the usage figures. */
    requests: z.number().nullable(),
    /** When this snapshot was taken (ISO). */
    fetchedAt: z.string(),
  })
  .strict();
export type BuiltinRelayAccount = z.infer<typeof BuiltinRelayAccountSchema>;

/** Nano-units per whole currency unit. */
export const RELAY_NANO_PER_UNIT = 1_000_000_000;

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
