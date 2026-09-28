import { sharedRuntimeId, SharedProviderSaveInputSchema } from "@contracts/sharedProvider.js";
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
const saved = SharedProviderStore.save({ ...base, apiKey: "TEST_SECRET_DO_NOT_PERSIST" });
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
check("Claude only receives models with a Claude interface", JSON.stringify(scopedClaude?.models.map((model) => model.id)) === JSON.stringify(["chat-model"]));
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
  && piModel.contextWindow === 128_000 && piModel.maxTokens === 16_384
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
let publicHttpFetched = false;
let publicHttpBlocked = false;
try {
  await discoverSharedProviderModels({
    baseUrl: "http://192.168.1.20/v1", protocol: "responses", apiKey: "PLAINTEXT_SECRET",
  }, { fetch: async () => { publicHttpFetched = true; return new Response("{}"); } });
} catch (error) {
  publicHttpBlocked = error instanceof Error && error.message.includes("only permits HTTPS") && error.message.includes("manually");
}
check("HTTP LAN discovery is rejected before fetch", publicHttpBlocked && !publicHttpFetched);
let metadataBlocked = false;
try { validateSharedProviderDiscoveryUrl("https://169.254.169.254/latest/meta-data"); }
catch (error) { metadataBlocked = error instanceof Error && error.message.includes("metadata") && error.message.includes("manually"); }
check("explicit cloud metadata targets are rejected even over HTTPS", metadataBlocked);
let customHttpFetched = false;
try {
  await discoverSharedProviderModels({
    baseUrl: "https://safe.example.invalid/v1",
    modelsEndpoint: "http://public.example.invalid/models",
    protocol: "responses",
    apiKey: "CUSTOM_SECRET",
  }, { fetch: async () => { customHttpFetched = true; return new Response("{}"); } });
} catch { /* expected */ }
check("custom models endpoints use the same network boundary", !customHttpFetched);

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
  routeSaveBlocked = error instanceof Error && error.message.includes("enter the API key again");
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
  { modelsEndpoint: "https://example.invalid/v1/models" },
  { endpointOverrides: { ...base.endpointOverrides, responses: "https://new-codex.example.invalid/v1" } },
  {
    protocols: ["anthropic", "chat-completions"] as const,
    endpointOverrides: { anthropic: base.endpointOverrides.anthropic },
    enabledAgents: ["claude"] as const,
  },
];
let protectedRouteChanges = 0;
for (const mutation of protectedRouteMutations) {
  try { SharedProviderStore.save({ ...base, id: saved[0]!.id, ...mutation }); }
  catch (error) { if (error instanceof Error && error.message.includes("enter the API key again")) protectedRouteChanges++; }
}
check("models endpoint and endpoint override changes each require a new key", protectedRouteChanges === protectedRouteMutations.length);
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
process.stdout.write(`shared-provider smoke passed (${checks} checks)\n`);
