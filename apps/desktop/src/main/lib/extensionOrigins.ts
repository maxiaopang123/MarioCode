import { z } from "zod";
import { awaitDb } from "@main/store/db.js";
import { SettingRepo } from "@main/store/repositories.js";
import type { ExtensionOrigin } from "@contracts/ipc";

const KEY = "extensions.origins";
const OriginSchema = z.object({ kind: z.enum(["market", "import", "manual"]), label: z.string(), id: z.string().optional() });
const RegistrySchema = z.object({ mcp: z.record(OriginSchema), skill: z.record(OriginSchema) });
type Registry = z.infer<typeof RegistrySchema>;
export async function readExtensionOrigins(): Promise<Registry> {
  await awaitDb();
  return readRegistry();
}
function readRegistry(): Registry {
  try { return RegistrySchema.parse(JSON.parse(SettingRepo.get(KEY) ?? "{}")); }
  catch { return { mcp: {}, skill: {} }; }
}
export async function setExtensionOrigin(type: "mcp" | "skill", name: string, origin: ExtensionOrigin | null): Promise<void> {
  await awaitDb();
  const registry = readRegistry();
  if (origin) registry[type][name] = origin;
  else delete registry[type][name];
  SettingRepo.set(KEY, JSON.stringify(registry));
}
