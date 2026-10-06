import { sharedRuntimeId, SharedProviderSaveInputSchema, resolveSharedModelProtocol } from "@contracts/sharedProvider.js";
import { anthropicToOpenAI, translateReasoningEffort } from "@main/providers/bridge/requestTranslator.js";
import { anthropicToResponses } from "@main/providers/bridge/responsesRequestTranslator.js";
import { ResponsesToAnthropicSse } from "@main/providers/bridge/responsesResponseTranslator.js";
import { ContextPolicySchema, parseContextPolicy, resolveContextPolicy } from "@contracts/contextPolicy.js";
import { readContextPolicy } from "@main/lib/contextPolicy.js";
import { SettingRepo } from "./stub-db.js";
import { buildCodexContextCatalog } from "@main/providers/codex-sdk/codexContextCatalog.js";
import { buildCustomEnv } from "@main/providers/claude-sdk/customEnv.js";
import type { ApiConfig } from "@contracts/customModel.js";
import { unpackPiHostPath } from "@main/providers/pi-sdk/piHostPath.js";
import { normalizePiRegisteredModel } from "@main/providers/pi-sdk/piRegisteredModel.js";
import { SharedProviderStore } from "@main/lib/sharedProviderStore.js";
import { addSession, corruptSharedKey, rawSettings } from "./stub-db.js";
import { setEncryptionAvailable } from "./stub-electron.js";
import { CustomModelStore } from "@main/lib/secretStore.js";
import { CodexModelsStore } from "@main/lib/codexModelsStore.js";
import { PiModelsStore } from "@main/lib/piModelsStore.js";
import {
  discoverSharedProviderModels,
  parseSharedProviderModels,
  resolveSharedProviderModelsUrl,
  validateSharedProviderDiscoveryUrl,
} from "@main/lib/sharedProviderDiscovery.js";

let checks = 0;
function check(name: string, condition: boolean): void {
  checks++;
  if (!condition) throw new Error(`FAILED: ${name}`);
  process.stdout.write(`  ✓ ${name}\n`);
}
const base = {
  name: "Synthetic Provider",
  baseUrl: "https://example.invalid/api",
  protocols: ["anthropic", "chat-completions", "responses"] as const,
  endpointOverrides: { anthropic: "https://claude.example.invalid/v1", responses: "https://codex.example.invalid/v1" },
  models: [{ id: "synthetic-model", input: ["text"] as const }],
  enabledAgents: ["claude", "codex"] as const,
};
const claudeConfig: ApiConfig = { baseUrl: "https://example.invalid/api/v1/", protocol: "anthropic", authMode: "api_key", authToken: "test-only", selectedModel: "test-model", models: [{ id: "test-model", contextWindow: 1_000_000 }], disableNonEssentialTraffic: true };
check("Claude Messages appends the SDK version path once", buildCustomEnv(claudeConfig).ANTHROPIC_BASE_URL === "https://example.invalid/api");
check("Claude does not add a gateway model suffix for numeric capacity", buildCustomEnv(claudeConfig).ANTHROPIC_MODEL === "test-model");
check("Claude preserves a hostname named v1", buildCustomEnv({ ...claudeConfig, baseUrl: "http://v1" }).ANTHROPIC_BASE_URL === "http://v1");
check("OpenAI bridge preserves its upstream version path", buildCustomEnv({ ...claudeConfig, protocol: "openai" }).ANTHROPIC_BASE_URL === claudeConfig.baseUrl);
check("unset policy defaults to 1M and 800K compaction", JSON.stringify(resolveContextPolicy()) === JSON.stringify({ contextWindow: 1_000_000, autoCompactTokenLimit: 800_000, reserveTokens: 200_000 }));
check("explicit smaller capacity controls compaction", resolveContextPolicy(128_000, { autoCompactPercent: 60 }).autoCompactTokenLimit === 76_800);
check("malformed stored policy falls back safely", parseContextPolicy("invalid").autoCompactPercent === 80 && parseContextPolicy('{"autoCompactPercent":101}').autoCompactPercent === 80);
check("out-of-range and fractional percentages are rejected", [0, 9, 91, 100, 60.5].every((autoCompactPercent) => !ContextPolicySchema.safeParse({ autoCompactPercent }).success));
const unknownCatalog = buildCodexContextCatalog("test-unknown", 1_000_000, 800_000).models[0]!;
check("Codex catalog lifts unknown-model cap and reserves compaction headroom", unknownCatalog.context_window === 1_000_000 && unknownCatalog.max_context_window === 1_000_000 && unknownCatalog.auto_compact_token_limit === 800_000 && unknownCatalog.effective_context_window_percent === 100);
const knownCatalog = buildCodexContextCatalog("custom/gpt-6-astra", 200_000, 120_000).models[0]!;
check("Codex known models retain native instructions and capabilities", "model_messages" in knownCatalog && knownCatalog.model_messages !== null && knownCatalog.slug === "custom/gpt-6-astra" && knownCatalog.context_window === 200_000);
SettingRepo.set("context.policy", '{"autoCompactPercent":60}');
check("policy is reread between turns", readContextPolicy().autoCompactPercent === 60);
SettingRepo.set("context.policy", '{"autoCompactPercent":90}');
check("changed persisted policy applies without restart", readContextPolicy().autoCompactPercent === 90);
check("development Pi host stays on disk", unpackPiHostPath("C:\\repo\\out\\pi-host\\piHost.mjs") === "C:\\repo\\out\\pi-host\\piHost.mjs");
check("packaged Windows Pi host uses unpacked tree", unpackPiHostPath("C:\\App\\resources\\app.asar\\out\\pi-host\\piHost.mjs") === "C:\\App\\resources\\app.asar.unpacked\\out\\pi-host\\piHost.mjs");
check("packaged Unix Pi host uses unpacked tree", unpackPiHostPath("/App/resources/app.asar/out/pi-host/piHost.mjs") === "/App/resources/app.asar.unpacked/out/pi-host/piHost.mjs");
check("unpacked host is not unpacked twice", unpackPiHostPath("/App/resources/app.asar.unpacked/out/pi-host/piHost.mjs") === "/App/resources/app.asar.unpacked/out/pi-host/piHost.mjs");
for (const order of [["anthropic", "responses", "chat-completions"], ["responses", "chat-completions", "anthropic"]] as const) {
  check("Pi routing is independent of checkbox order", resolveSharedModelProtocol("pi", order, order) === "chat-completions");
  check("Claude routing agrees with Pi", resolveSharedModelProtocol("claude", order, order) === "chat-completions");
  check("Codex always selects Responses", resolveSharedModelProtocol("codex", order, order) === "responses");
}
check("Codex rejects a chat-only model on a Responses provider", resolveSharedModelProtocol("codex", base.protocols, ["chat-completions"]) === undefined);
check("Pi can select Messages-only models", resolveSharedModelProtocol("pi", base.protocols, ["anthropic"]) === "anthropic");
check("Claude can select Responses-only models", resolveSharedModelProtocol("claude", base.protocols, ["responses"]) === "responses");
check("disabled provider interface cannot be routed", resolveSharedModelProtocol("pi", ["anthropic"], ["responses"]) === undefined);
check("Pi Messages removes duplicate version prefix", normalizePiRegisteredModel({ id: "m", api: "anthropic-messages", baseUrl: "https://example.invalid/anthropic/v1/" }).baseUrl === "https://example.invalid/anthropic");
check("Pi Messages preserves a hostname named v1", normalizePiRegisteredModel({ id: "m", api: "anthropic-messages", baseUrl: "http://v1" }).baseUrl === "http://v1");
check("Pi Chat preserves versioned API base", normalizePiRegisteredModel({ id: "m", api: "openai-completions", baseUrl: "https://example.invalid/v1" }).baseUrl === "https://example.invalid/v1");
check("Pi Responses preserves versioned API base", normalizePiRegisteredModel({ id: "m", api: "openai-responses", baseUrl: "https://example.invalid/v1" }).baseUrl === "https://example.invalid/v1");
const saved = SharedProviderStore.save({ ...base, apiKey: "TEST_SECRET_DO_NOT_PERSIST" });
check("saving freezes inherited model interfaces", JSON.stringify(saved[0]!.models[0]!.interfaces) === JSON.stringify(base.protocols));
check("duplicate per-model interfaces are rejected", !SharedProviderSaveInputSchema.safeParse({ ...base, models: [{ id: "duplicates", interfaces: ["responses", "responses"] }] }).success);
check("Codex cannot enable a chat-only endpoint", !SharedProviderSaveInputSchema.safeParse({ ...base, protocols: ["chat-completions"], endpointOverrides: {}, enabledAgents: ["codex"] }).success);
check("URL query secrets cannot enter public metadata", !SharedProviderSaveInputSchema.safeParse({ ...base, baseUrl: "https://example.invalid/v1?api_key=secret" }).success);
check("duplicate model IDs are rejected", !SharedProviderSaveInputSchema.safeParse({ ...base, models: [{ id: "same" }, { id: "same" }] }).success);
check("new provider is saved", saved.length === 1 && saved[0]!.hasApiKey);
check("metadata never contains plaintext key", !rawSettings().includes("TEST_SECRET_DO_NOT_PERSIST"));
check("runtime id is stable and slash-free", /^shared_[0-9a-f]{32}$/.test(sharedRuntimeId(saved[0]!.id)));
check("metadata API does not expose key", !("apiKey" in saved[0]!));
check("key resolves only in main store", SharedProviderStore.resolveApiKey(saved[0]!.id) === "TEST_SECRET_DO_NOT_PERSIST");
check("endpoint without override falls back to baseUrl", SharedProviderStore.endpointUrl(saved[0]!, "chat-completions") === base.baseUrl);
check("endpoint override wins", SharedProviderStore.endpointUrl(saved[0]!, "anthropic") === base.endpointOverrides.anthropic);
const runtimeId = sharedRuntimeId(saved[0]!.id);
const claudeProjection = CustomModelStore.listPublic().find((provider) => provider.id === runtimeId);
check("Claude projection prefers chat completions", claudeProjection?.protocol === "openai" && claudeProjection.baseUrl === base.baseUrl);
const codexProjection = (await CodexModelsStore.listPublic()).find((provider) => provider.id === runtimeId);
check("Codex projection uses responses override", codexProjection?.baseUrl === base.endpointOverrides.responses);
check("model interfaces must be enabled by the provider", !SharedProviderSaveInputSchema.safeParse({
  ...base,
  models: [{ id: "chat-model", interfaces: ["responses"] }],
  protocols: ["chat-completions"],
  endpointOverrides: {},
  enabledAgents: ["claude"],
}).success);
SharedProviderStore.save({
  ...base,
  id: saved[0]!.id,
  models: [
    { id: "chat-model", interfaces: ["chat-completions"] },
    { id: "responses-model", interfaces: ["responses"] },
  ],
  enabledAgents: ["claude", "codex", "pi"],
  apiKey: "TEST_SECRET_DO_NOT_PERSIST",
});
const scopedClaude = CustomModelStore.listPublic().find((provider) => provider.id === runtimeId);
const scopedCodex = (await CodexModelsStore.listPublic()).find((provider) => provider.id === runtimeId);
const scopedPi = (await PiModelsStore.listPublic())[runtimeId];
check("Claude receives models with compatible interfaces including Responses", JSON.stringify(scopedClaude?.models.map((model) => model.id)) === JSON.stringify(["chat-model", "responses-model"]));
check("Codex only receives models with a Responses interface", JSON.stringify(scopedCodex?.models.map((model) => model.id)) === JSON.stringify(["responses-model"]));
check("Pi keeps the interface on each projected model", scopedPi?.models?.find((model) => model.id === "responses-model")?.api === "openai-responses");
SharedProviderStore.save({ ...base, id: saved[0]!.id, apiKey: "TEST_SECRET_DO_NOT_PERSIST" });
let legacyWriteRefused = false;
try { CustomModelStore.remove(runtimeId); } catch { legacyWriteRefused = true; }
check("legacy Claude API cannot delete a shared provider", legacyWriteRefused && SharedProviderStore.listPublic().length === 1);

SharedProviderStore.save({
  ...base,
  id: saved[0]!.id,
  enabledAgents: ["claude", "codex", "pi"],
  apiKey: "ROTATED_TEST_SECRET",
});
check("key rotation replaces rather than duplicates plaintext", SharedProviderStore.resolveApiKey(saved[0]!.id) === "ROTATED_TEST_SECRET"
  && !rawSettings().includes("TEST_SECRET_DO_NOT_PERSIST") && !rawSettings().includes("ROTATED_TEST_SECRET"));
const piProjection = (await PiModelsStore.listPublic())[runtimeId];
const piModel = piProjection?.models?.[0];
check("Pi projection supplies the extension-required model shape", piModel?.name === "synthetic-model"
  && piModel.reasoning === false && JSON.stringify(piModel.input) === JSON.stringify(["text"])
  && piModel.contextWindow === 1_000_000 && piModel.maxTokens === 16_384
  && JSON.stringify(piModel.cost) === JSON.stringify({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }));
check("shared public schema remains pricing-free", !("cost" in SharedProviderStore.listPublic()[0]!.models[0]!));

check("models URL appends /models to a versioned base", resolveSharedProviderModelsUrl({
  baseUrl: "https://gateway.example/v1", protocol: "chat-completions",
}).toString() === "https://gateway.example/v1/models");
check("models URL strips a request path before appending /models", resolveSharedProviderModelsUrl({
  baseUrl: "https://gateway.example/v1/chat/completions", protocol: "chat-completions",
}).toString() === "https://gateway.example/v1/models");
check("custom models endpoint wins", resolveSharedProviderModelsUrl({
  baseUrl: "https://gateway.example/v1", protocol: "anthropic", modelsEndpoint: "https://gateway.example/catalog/models",
}).toString() === "https://gateway.example/catalog/models");
check("Anthropic also attempts the conventional /models endpoint", resolveSharedProviderModelsUrl({
  baseUrl: "https://gateway.example/v1", protocol: "anthropic",
}).toString() === "https://gateway.example/v1/models");
const parsedModels = parseSharedProviderModels({
  data: [
    { id: "alpha", display_name: "Alpha Display" },
    { id: "alpha", name: "duplicate" },
    { id: "beta", name: "Beta Name" },
  ],
});
check("data[] parsing extracts labels and de-duplicates ids", JSON.stringify(parsedModels.models) === JSON.stringify([
  { id: "alpha", label: "Alpha Display" }, { id: "beta", label: "Beta Name" },
]));
check("models[] parsing accepts name as an id fallback", parseSharedProviderModels({ models: [{ name: "gamma" }] }).models[0]?.id === "gamma");
const paginatedModels = parseSharedProviderModels({ data: [{ id: "paged" }], has_more: true, next_cursor: "cursor-2" });
check("upstream pagination marks discovery results partial", paginatedModels.partial && !paginatedModels.truncated);
const cappedModels = parseSharedProviderModels({ models: Array.from({ length: 1_001 }, (_, index) => ({ id: `model-${index}` })) });
check("the local model cap reports truncated and partial", cappedModels.models.length === 1_000 && cappedModels.truncated && cappedModels.partial);

check("HTTPS private/self-hosted discovery remains allowed", validateSharedProviderDiscoveryUrl("https://192.168.1.20/v1").hostname === "192.168.1.20");
check("HTTP explicit loopback targets remain allowed", [
  "http://localhost:11434/v1",
  "http://127.45.6.7:8080/v1",
  "http://[::1]:8080/v1",
].every((url) => validateSharedProviderDiscoveryUrl(url).protocol === "http:"));
for (const protocol of ["anthropic", "chat-completions", "responses"] as const) {
  let httpRequestMatched = false;
  const result = await discoverSharedProviderModels({
    baseUrl: "http://192.168.1.20:8080/v1", protocol, apiKey: "HTTP_TEST_SECRET",
  }, { fetch: async (url, init) => {
    const headers = new Headers(init?.headers);
    httpRequestMatched = String(url) === "http://192.168.1.20:8080/v1/models"
      && (protocol === "anthropic" ? headers.get("x-api-key") === "HTTP_TEST_SECRET"
        : headers.get("authorization") === "Bearer HTTP_TEST_SECRET");
    return new Response(JSON.stringify({ data: [{ id: "lan-model" }] }));
  } });
  check(`HTTP LAN discovery loads models with ${protocol} authentication`, httpRequestMatched && result.models[0]?.id === "lan-model");
}
let metadataBlocked = false;
try { validateSharedProviderDiscoveryUrl("https://169.254.169.254/latest/meta-data"); }
catch (error) { metadataBlocked = error instanceof Error && error.message.includes("metadata") && error.message.includes("manually"); }
check("explicit cloud metadata targets are rejected even over HTTPS", metadataBlocked);
let customHttpFetched = false;
const customHttpModels = await discoverSharedProviderModels({
    baseUrl: "https://safe.example.invalid/v1",
    modelsEndpoint: "http://public.example.invalid/models",
    protocol: "responses",
    apiKey: "CUSTOM_SECRET",
  }, { fetch: async (url) => {
    customHttpFetched = String(url) === "http://public.example.invalid/models";
    return new Response(JSON.stringify({ models: [{ id: "gateway-model" }] }));
  } });
check("explicit HTTP gateway models endpoints are supported", customHttpFetched && customHttpModels.models[0]?.id === "gateway-model");

let storedAuth = "";
const discoveredWithStoredKey = await discoverSharedProviderModels({
  id: saved[0]!.id,
  baseUrl: base.baseUrl,
  protocol: "chat-completions",
}, {
  fetch: async (_url, init) => {
    storedAuth = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ data: [{ id: "server-model", name: "Server Model" }] }), {
      headers: { "content-type": "application/json" },
    });
  },
});
check("unchanged saved provider may reuse its encrypted key in main only", storedAuth === "Bearer ROTATED_TEST_SECRET");
check("discovery result never returns an API key", discoveredWithStoredKey.models[0]?.id === "server-model"
  && !JSON.stringify(discoveredWithStoredKey).includes("ROTATED_TEST_SECRET"));

let changedEndpointFetched = false;
let changedEndpointBlocked = false;
try {
  await discoverSharedProviderModels({
    id: saved[0]!.id,
    baseUrl: "https://changed.example.invalid/v1",
    protocol: "chat-completions",
  }, { fetch: async () => { changedEndpointFetched = true; return new Response("{}"); } });
} catch (error) {
  changedEndpointBlocked = error instanceof Error && error.message.includes("unsaved changes");
}
check("saved key is not reused after an unsaved base URL change", changedEndpointBlocked && !changedEndpointFetched);
let changedModelsEndpointBlocked = false;
try {
  await discoverSharedProviderModels({
    id: saved[0]!.id,
    baseUrl: base.baseUrl,
    protocol: "chat-completions",
    modelsEndpoint: "https://example.invalid/different-models",
  }, { fetch: async () => new Response("{}") });
} catch (error) {
  changedModelsEndpointBlocked = error instanceof Error && error.message.includes("unsaved changes");
}
check("saved key is not reused after an unsaved models endpoint change", changedModelsEndpointBlocked);

let routeSaveBlocked = false;
try {
  SharedProviderStore.save({
    ...base,
    id: saved[0]!.id,
    baseUrl: "https://changed.example.invalid/v1",
  });
} catch (error) {
  routeSaveBlocked = error instanceof Error && error.message.includes("API Key");
}
check("saving a changed route cannot retain the old encrypted key", routeSaveBlocked
  && SharedProviderStore.getPublic(saved[0]!.id)?.baseUrl === base.baseUrl
  && SharedProviderStore.resolveApiKey(saved[0]!.id) === "ROTATED_TEST_SECRET");
let rejectedSaveDiscoveryFetched = false;
try {
  await discoverSharedProviderModels({
    id: saved[0]!.id,
    baseUrl: "https://changed.example.invalid/v1",
    protocol: "chat-completions",
  }, { fetch: async () => { rejectedSaveDiscoveryFetched = true; return new Response("{}"); } });
} catch { /* expected: persisted route stayed unchanged */ }
check("the rejected save cannot be followed by discovery with the old key", !rejectedSaveDiscoveryFetched);
SharedProviderStore.save({
  ...base,
  id: saved[0]!.id,
  baseUrl: "https://changed.example.invalid/v1",
  apiKey: "NEW_ROUTE_SECRET",
});
check("saving a changed route succeeds with an explicitly re-entered key", SharedProviderStore.getPublic(saved[0]!.id)?.baseUrl === "https://changed.example.invalid/v1"
  && SharedProviderStore.resolveApiKey(saved[0]!.id) === "NEW_ROUTE_SECRET");
SharedProviderStore.save({ ...base, id: saved[0]!.id, apiKey: "ROTATED_TEST_SECRET" });
const protectedRouteMutations = [
  { modelsEndpoint: "https://models.example.invalid/v1/models" },
  { endpointOverrides: { ...base.endpointOverrides, responses: "https://new-codex.example.invalid/v1" } },
  { baseUrl: "http://example.invalid/api" },
];
let protectedRouteChanges = 0;
for (const mutation of protectedRouteMutations) {
  try { SharedProviderStore.save({ ...base, id: saved[0]!.id, ...mutation }); }
  catch (error) { if (error instanceof Error && error.message.includes("API Key")) protectedRouteChanges++; }
}
check("new model hosts, override hosts and HTTPS-to-HTTP downgrades require a new key", protectedRouteChanges === protectedRouteMutations.length);
SharedProviderStore.save({
  ...base,
  id: saved[0]!.id,
  modelsEndpoint: "https://example.invalid/v1/models",
});
check("adding a models path on the existing origin keeps the stored key", SharedProviderStore.resolveApiKey(saved[0]!.id) === "ROTATED_TEST_SECRET");
SharedProviderStore.save({ ...base, id: saved[0]!.id });
const interfaceFingerprintProvider = SharedProviderStore.save({
  ...base,
  name: "Interface Fingerprint Provider",
  enabledAgents: ["claude"],
  apiKey: "INTERFACE_FINGERPRINT_SECRET",
}).find((provider) => provider.name === "Interface Fingerprint Provider")!;
SharedProviderStore.save({
  ...base,
  id: interfaceFingerprintProvider.id,
  enabledAgents: ["claude"],
  models: [{ id: "synthetic-model", interfaces: ["chat-completions"] }, { id: "added-model" }],
});
check("model and interface edits keep the saved key without re-entry", SharedProviderStore.resolveApiKey(interfaceFingerprintProvider.id) === "INTERFACE_FINGERPRINT_SECRET"
  && SharedProviderStore.getPublic(interfaceFingerprintProvider.id)?.models.length === 2);
SharedProviderStore.remove(interfaceFingerprintProvider.id);
SharedProviderStore.save({
  ...base,
  id: saved[0]!.id,
  protocols: ["responses", "chat-completions", "anthropic"],
  endpointOverrides: { responses: base.endpointOverrides.responses, anthropic: base.endpointOverrides.anthropic },
});
check("route comparison ignores protocol and override object ordering", SharedProviderStore.resolveApiKey(saved[0]!.id) === "ROTATED_TEST_SECRET");

let temporaryAuth = "";
const temporaryResult = await discoverSharedProviderModels({
  baseUrl: "https://new.example.invalid/v1",
  protocol: "responses",
  apiKey: "TEMPORARY_ONLY",
}, {
  fetch: async (_url, init) => {
    temporaryAuth = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ models: [{ id: "new-model", display_name: "New Model" }] }));
  },
});
check("unsaved draft can use a temporary key without echoing it", temporaryAuth === "Bearer TEMPORARY_ONLY"
  && temporaryResult.models[0]?.label === "New Model" && !JSON.stringify(temporaryResult).includes("TEMPORARY_ONLY"));

let redirectRequests = 0;
let crossOriginBlocked = false;
try {
  await discoverSharedProviderModels({
    baseUrl: "https://origin.example.invalid/v1", protocol: "responses", apiKey: "REDIRECT_SECRET",
  }, {
    fetch: async () => {
      redirectRequests++;
      return new Response(null, { status: 302, headers: { location: "https://other.example.invalid/v1/models" } });
    },
  });
} catch (error) {
  crossOriginBlocked = error instanceof Error && error.message.includes("cross-origin redirect");
}
check("cross-origin redirects are rejected before resending credentials", crossOriginBlocked && redirectRequests === 1);

let anthropicHinted = false;
let non2xxBodyCancelled = false;
try {
  await discoverSharedProviderModels({
    baseUrl: "https://anthropic.example.invalid/v1", protocol: "anthropic", apiKey: "ANTHROPIC_TEMP",
  }, { fetch: async () => new Response(new ReadableStream({ cancel() { non2xxBodyCancelled = true; } }), { status: 404 }) });
} catch (error) {
  anthropicHinted = error instanceof Error && error.message.includes("custom models endpoint") && error.message.includes("manually");
}
check("failed Anthropic discovery suggests a custom endpoint or manual entry", anthropicHinted);
check("non-2xx discovery responses cancel their unread body", non2xxBodyCancelled);

let metadataRedirectRequests = 0;
let metadataRedirectBlocked = false;
try {
  await discoverSharedProviderModels({
    baseUrl: "https://safe.example.invalid/v1", protocol: "responses", apiKey: "REDIRECT_METADATA_SECRET",
  }, {
    fetch: async () => {
      metadataRedirectRequests++;
      return new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/meta-data" } });
    },
  });
} catch (error) {
  metadataRedirectBlocked = error instanceof Error && error.message.includes("metadata");
}
check("redirect targets use the same metadata boundary before a second request", metadataRedirectBlocked && metadataRedirectRequests === 1);

let bodyTimeoutCovered = false;
try {
  await discoverSharedProviderModels({
    baseUrl: "https://slow.example.invalid/v1", protocol: "responses", apiKey: "SLOW_SECRET",
  }, {
    timeoutMs: 10,
    fetch: async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      },
    })),
  });
} catch (error) {
  bodyTimeoutCovered = error instanceof Error && error.message.includes("timed out");
}
check("discovery timeout remains active while reading the response body", bodyTimeoutCovered);

setEncryptionAvailable(false);
check("unavailable secure storage reports no usable key", SharedProviderStore.listPublic()[0]!.hasApiKey === false);
let refused = false;
try { SharedProviderStore.save({ ...base, name: "No keychain", apiKey: "plaintext" }); } catch { refused = true; }
check("unavailable encryption refuses new key", refused && !rawSettings().includes("plaintext"));
setEncryptionAvailable(true);

addSession("session-pi", null, `${runtimeId}/synthetic-model`);
addSession("session-codex", null, `${runtimeId}/synthetic-model`);
SharedProviderStore.save({
  ...base,
  id: saved[0]!.id,
  enabledAgents: ["claude"],
  models: [{ id: "replacement-model" }],
});
check("referenced provider can still drop models and agents", SharedProviderStore.getPublic(saved[0]!.id)?.models[0]?.id === "replacement-model");

corruptSharedKey(saved[0]!.id);
check("corrupt ciphertext reports no usable key", SharedProviderStore.listPublic()[0]!.hasApiKey === false);
let corruptSaveBlocked = false;
try { SharedProviderStore.save({ ...base, id: saved[0]!.id }); } catch { corruptSaveBlocked = true; }
check("corrupt saved key requires replacement on save", corruptSaveBlocked);
SharedProviderStore.remove(saved[0]!.id);
check("provider referenced by sessions can be removed", SharedProviderStore.getPublic(saved[0]!.id) === null);

// Bridge reasoning_effort translation
check("default request has no reasoning_effort", anthropicToOpenAI({ model: "test", messages: [], max_tokens: 1000 }).reasoning_effort === undefined);
check("effort=low maps to reasoning_effort=low", anthropicToOpenAI({ model: "test", messages: [], max_tokens: 1000, effort: "low" }).reasoning_effort === "low");
check("effort=medium maps to reasoning_effort=medium", anthropicToOpenAI({ model: "test", messages: [], max_tokens: 1000, effort: "medium" }).reasoning_effort === "medium");
check("effort=high/xhigh/max maps to reasoning_effort=high",
  anthropicToOpenAI({ model: "test", messages: [], max_tokens: 1000, effort: "high" }).reasoning_effort === "high" &&
  anthropicToOpenAI({ model: "test", messages: [], max_tokens: 1000, effort: "xhigh" }).reasoning_effort === "high" &&
  anthropicToOpenAI({ model: "test", messages: [], max_tokens: 1000, effort: "max" }).reasoning_effort === "high"
);
check("thinking enabled with budget <= 2048 maps to low", anthropicToOpenAI({ model: "test", messages: [], max_tokens: 1000, thinking: { type: "enabled", budget_tokens: 1024 } }).reasoning_effort === "low");
check("thinking enabled with budget <= 8192 maps to medium", anthropicToOpenAI({ model: "test", messages: [], max_tokens: 1000, thinking: { type: "enabled", budget_tokens: 4096 } }).reasoning_effort === "medium");
check("thinking enabled with budget > 8192 maps to high", anthropicToOpenAI({ model: "test", messages: [], max_tokens: 1000, thinking: { type: "enabled", budget_tokens: 16000 } }).reasoning_effort === "high");
check("thinking disabled maps to undefined", anthropicToOpenAI({ model: "test", messages: [], max_tokens: 1000, thinking: { type: "disabled" } }).reasoning_effort === undefined);

// Bridge Anthropic -> Responses request translation
const sampleAnthropicReq = {
  model: "gpt-4o-realtime[1m]",
  system: "You are a helpful assistant.",
  messages: [
    { role: "user" as const, content: [{ type: "text" as const, text: "Check files" }] },
    {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "I will check" },
        { type: "tool_use" as const, id: "tool_123", name: "read_file", input: { path: "a.txt" } },
      ],
    },
    {
      role: "user" as const,
      content: [
        { type: "tool_result" as const, tool_use_id: "tool_123", content: "hello world" },
      ],
    },
  ],
  max_tokens: 2048,
  effort: "high",
  tools: [
    { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
  ],
};
const translatedResponses = anthropicToResponses(sampleAnthropicReq);
check("anthropicToResponses strips [1m] model suffix", translatedResponses.model === "gpt-4o-realtime");
check("anthropicToResponses maps system to instructions", translatedResponses.instructions === "You are a helpful assistant.");
check("anthropicToResponses maps effort to reasoning.effort", translatedResponses.reasoning?.effort === "high");
check("anthropicToResponses maps tool_use to function_call", translatedResponses.input.some((item) => item.type === "function_call" && item.call_id === "tool_123" && item.name === "read_file"));
check("anthropicToResponses maps tool_result to function_call_output", translatedResponses.input.some((item) => item.type === "function_call_output" && item.call_id === "tool_123" && item.output === "hello world"));
check("anthropicToResponses maps tools definition", translatedResponses.tools?.[0]?.name === "read_file");
check("anthropicToResponses maps user text to input_text", translatedResponses.input.some((item) => item.type === "message" && item.role === "user" && Array.isArray(item.content) && item.content.some((c) => c.type === "input_text")));
check("anthropicToResponses maps assistant text to output_text", translatedResponses.input.some((item) => item.type === "message" && item.role === "assistant" && Array.isArray(item.content) && item.content.some((c) => c.type === "output_text")));
check("anthropicToResponses maps assistant string content to output_text", anthropicToResponses({ model: "test", messages: [{ role: "assistant", content: "Reply directly" }], max_tokens: 100 }).input.some((item) => item.type === "message" && item.role === "assistant" && Array.isArray(item.content) && item.content.some((c) => c.type === "output_text" && c.text === "Reply directly")));

// Bridge Responses -> Anthropic SSE streaming translation
const responsesTranslator = new ResponsesToAnthropicSse();
const ev1 = responsesTranslator.feed({ response: { id: "resp_1", model: "o3-mini" } }, "response.created");
check("ResponsesToAnthropicSse emits message_start", ev1.some((e) => e.type === "message_start" && e.message.model === "o3-mini"));

const ev2 = responsesTranslator.feed({ delta: "Let me ponder..." }, "response.reasoning_text.delta");
check("ResponsesToAnthropicSse emits thinking block for reasoning", ev2.some((e) => e.type === "content_block_delta" && e.delta.type === "thinking_delta" && e.delta.thinking === "Let me ponder..."));

const ev3 = responsesTranslator.feed({ delta: "Hello there!" }, "response.text.delta");
check("ResponsesToAnthropicSse emits text delta", ev3.some((e) => e.type === "content_block_delta" && e.delta.type === "text_delta" && e.delta.text === "Hello there!"));

const ev4 = responsesTranslator.feed({
  item: { type: "function_call", call_id: "call_abc", name: "bash" },
  output_index: 1,
}, "response.output_item.added");
check("ResponsesToAnthropicSse opens tool_use block on output_item.added", ev4.some((e) => e.type === "content_block_start" && e.content_block.type === "tool_use" && e.content_block.name === "bash"));

const ev5 = responsesTranslator.feed({
  output_index: 1,
  call_id: "call_abc",
  delta: '{"cmd":"ls"}',
}, "response.function_call_arguments.delta");
check("ResponsesToAnthropicSse emits input_json_delta for tool arguments", ev5.some((e) => e.type === "content_block_delta" && e.delta.type === "input_json_delta" && e.delta.partial_json === '{"cmd":"ls"}'));

const ev6 = responsesTranslator.feed({
  response: {
    status: "completed",
    usage: {
      input_tokens: 1500,
      output_tokens: 300,
      input_token_details: { cached_tokens: 1200 },
    },
  },
}, "response.completed");
const finishEvents = responsesTranslator.finish();
const messageDelta = finishEvents.find((e) => e.type === "message_delta");
check("ResponsesToAnthropicSse converts cached_tokens into cache_read_input_tokens",
  messageDelta?.type === "message_delta" &&
  messageDelta.usage.input_tokens === 300 &&
  messageDelta.usage.cache_read_input_tokens === 1200 &&
  messageDelta.usage.output_tokens === 300 &&
  messageDelta.delta.stop_reason === "tool_use"
);

process.stdout.write(`shared-provider smoke passed (${checks} checks)\n`);
