import { sharedRuntimeId, SharedProviderSaveInputSchema } from "@contracts/sharedProvider.js";
import { SharedProviderStore } from "@main/lib/sharedProviderStore.js";
import { addSession, corruptSharedKey, rawSettings } from "./stub-db.js";
import { setEncryptionAvailable } from "./stub-electron.js";
import { CustomModelStore } from "@main/lib/secretStore.js";
import { CodexModelsStore } from "@main/lib/codexModelsStore.js";

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
check("Claude projection prefers anthropic", claudeProjection?.protocol === "anthropic" && claudeProjection.baseUrl === base.endpointOverrides.anthropic);
const codexProjection = (await CodexModelsStore.listPublic()).find((provider) => provider.id === runtimeId);
check("Codex projection uses responses override", codexProjection?.baseUrl === base.endpointOverrides.responses);
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

setEncryptionAvailable(false);
check("unavailable secure storage reports no usable key", SharedProviderStore.listPublic()[0]!.hasApiKey === false);
let refused = false;
try { SharedProviderStore.save({ ...base, name: "No keychain", apiKey: "plaintext" }); } catch { refused = true; }
check("unavailable encryption refuses new key", refused && !rawSettings().includes("plaintext"));
setEncryptionAvailable(true);

addSession("session-pi", null, `${runtimeId}/synthetic-model`);
addSession("session-codex", null, `${runtimeId}/synthetic-model`);
let blocked = false;
try { SharedProviderStore.remove(saved[0]!.id); } catch { blocked = true; }
check("Pi/Codex prefixed model references block removal", blocked);

let shrinkBlocked = false;
try {
  SharedProviderStore.save({
    ...base,
    id: saved[0]!.id,
    enabledAgents: ["claude"],
    models: [{ id: "replacement-model" }],
  });
} catch { shrinkBlocked = true; }
check("referenced provider blocks model shrink and agent disable", shrinkBlocked && SharedProviderStore.listPublic()[0]!.models[0]!.id === "synthetic-model");

corruptSharedKey(saved[0]!.id);
check("corrupt ciphertext reports no usable key", SharedProviderStore.listPublic()[0]!.hasApiKey === false);
let corruptSaveBlocked = false;
try { SharedProviderStore.save({ ...base, id: saved[0]!.id }); } catch { corruptSaveBlocked = true; }
check("corrupt saved key requires replacement on save", corruptSaveBlocked);
process.stdout.write(`shared-provider smoke passed (${checks} checks)\n`);
