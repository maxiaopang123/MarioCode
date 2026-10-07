import type { LegacyProviderEntry, LegacyProviderImportInput } from "@contracts/legacyProvider";
import { SharedProviderSaveInputSchema, type SharedProviderSaveInput, type SharedProviderProtocol } from "@contracts/sharedProvider";
import { CustomModelStore } from "./secretStore.js";
import { PiModelsStore } from "./piModelsStore.js";
import { CodexModelsStore } from "./codexModelsStore.js";
import { SharedProviderStore } from "./sharedProviderStore.js";
import { SettingRepo } from "@main/store/repositories.js";
import { getDb } from "@main/store/db.js";

const IMPORTS_KEY = "sharedProviders.legacyImports";
interface Candidate { entry: LegacyProviderEntry; draft: SharedProviderSaveInput; key: string | null }
function imports(): Record<string, string> {
  const raw: unknown = JSON.parse(SettingRepo.get(IMPORTS_KEY) ?? "{}");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Legacy import history is corrupt");
  return Object.fromEntries(Object.entries(raw).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
}
function sourceKey(entry: LegacyProviderImportInput): string { return `${entry.engine}:${entry.sourceId}`; }
const piProtocol = (api?: string): SharedProviderProtocol | undefined =>
  api === "anthropic-messages" ? "anthropic" : api === "openai-completions" ? "chat-completions" : api === "openai-responses" ? "responses" : undefined;

/** Read only; credentials never leave main. Unrepresentable custom options
 *  block copying rather than silently dropping behavior. Originals survive. */
async function candidates(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const [pi, codex] = await Promise.all([PiModelsStore.listPublic(), CodexModelsStore.listPublic()]);
  const seen = imports();
  const sharedIds = new Set(SharedProviderStore.listPublic().map(p => p.id));
  const add = (entry: LegacyProviderEntry, draft: SharedProviderSaveInput, key: string | null, advanced: boolean): void => {
    if (advanced) entry.issue = "advanced";
    else if (!SharedProviderSaveInputSchema.safeParse(draft).success) entry.issue = "invalid";
    else if (!key) entry.issue = "keyMissing";
    const imported = seen[sourceKey(entry)];
    if (imported && sharedIds.has(imported)) entry.importedProviderId = imported;
    out.push({ entry, draft, key });
  };
  for (const p of CustomModelStore.listPublic()) {
    if (p.id.startsWith("shared_")) continue;
    const protocol = p.protocol === "openai" ? "chat-completions" : p.protocol;
    add({engine:"claude",sourceId:p.id,name:p.name,baseUrl:p.baseUrl,models:p.models.map(m=>m.id)}, {
      name:p.name,baseUrl:p.baseUrl,protocols:[protocol],enabledAgents:["claude"],
      models:p.models.map(m=>({id:m.id,interfaces:[protocol],contextWindow:m.contextWindow ?? 1_000_000})),
    }, CustomModelStore.resolveApiConfig(p.id)?.authToken ?? null,
    Boolean(p.subagentModel || p.timeoutMs || Object.keys(p.customHeaders ?? {}).length || (protocol === "anthropic" && p.authMode !== "api_key") || p.models.some(m=>m.supports1m)));
  }
  const piFields = new Set(["name","baseUrl","api","apiKey","authHeader","models","hasApiKey"]);
  const modelFields = new Set(["id","name","api","baseUrl","reasoning","input","contextWindow","maxTokens"]);
  for (const [id,p] of Object.entries(pi)) {
    if (id.startsWith("shared_")) continue;
    const protocol=piProtocol(p.api);
    const advanced=!protocol || p.authHeader === false || Object.keys(p).some(k=>!piFields.has(k))
      || (p.models ?? []).some(m=>Object.keys(m).some(k=>!modelFields.has(k)) || (m.api && m.api!==p.api) || (m.baseUrl && m.baseUrl!==p.baseUrl) || m.input?.some(i=>i!=="text"&&i!=="image"));
    add({engine:"pi",sourceId:id,name:p.name ?? id,baseUrl:p.baseUrl ?? "",models:(p.models ?? []).map(m=>m.id)}, {
      name:p.name ?? id,baseUrl:p.baseUrl ?? "",protocols:[protocol ?? "chat-completions"],enabledAgents:["pi"],
      models:(p.models ?? []).map(m=>({id:m.id,label:m.name,interfaces:[protocol ?? "chat-completions"],reasoning:m.reasoning,
        contextWindow:m.contextWindow,maxTokens:m.maxTokens,input:m.input?.includes("image") ? ["text","image"] : ["text"]})),
    },PiModelsStore.resolveApiKey(id),advanced);
  }
  for (const p of codex) {
    if (p.id.startsWith("shared_")) continue;
    const advanced=p.models.some(m=>m.protocol && m.protocol!=="responses" || m.baseUrl && m.baseUrl!==p.baseUrl);
    add({engine:"codex",sourceId:p.id,name:p.name,baseUrl:p.baseUrl,models:p.models.map(m=>m.id)}, {
      name:p.name,baseUrl:p.baseUrl,protocols:["responses"],enabledAgents:["codex"],
      models:p.models.map(m=>({id:m.id,label:m.label,contextWindow:m.contextWindow,maxTokens:m.maxTokens,interfaces:["responses"],imageGeneration:p.imageGeneration})),
    },CodexModelsStore.resolveApiKey(p.id),Boolean(advanced));
  }
  return out;
}
export async function listLegacyProviders(): Promise<LegacyProviderEntry[]> {
  return (await candidates()).map(c=>c.entry);
}
// Serialize imports so double clicks / two windows never make duplicates.
let queue: Promise<unknown> = Promise.resolve();
export function importLegacyProvider(input: LegacyProviderImportInput): Promise<{ providers: ReturnType<typeof SharedProviderStore.listPublic>; providerId: string }> {
  const task=queue.then(async()=>{
    const candidate=(await candidates()).find(c=>sourceKey(c.entry)===sourceKey(input));
    if (!candidate) throw new Error("Legacy provider no longer exists");
    if (candidate.entry.importedProviderId) return {providers:SharedProviderStore.listPublic(),providerId:candidate.entry.importedProviderId};
    if (candidate.entry.issue || !candidate.key) throw new Error(`Legacy provider cannot be copied: ${candidate.entry.issue}`);
    const key=candidate.key;
    return getDb().transaction(()=>{
      const known=new Set(SharedProviderStore.listPublic().map(p=>p.id));
      const providers=SharedProviderStore.save({...candidate.draft,apiKey:key});
      const provider=providers.find(p=>!known.has(p.id));
      if (!provider) throw new Error("Imported provider was not saved");
      SettingRepo.set(IMPORTS_KEY,JSON.stringify({...imports(),[sourceKey(input)]:provider.id}));
      return {providers,providerId:provider.id};
    })();
  });
  queue=task.catch(()=>{}); return task;
}
