import { z } from "zod";
import { SharedProviderAgentSchema } from "./sharedProvider.js";
export const LegacyProviderImportSchema = z.object({
  engine: SharedProviderAgentSchema,
  sourceId: z.string().min(1).max(512),
}).strict();
export type LegacyProviderImportInput = z.infer<typeof LegacyProviderImportSchema>;
export interface LegacyProviderEntry extends LegacyProviderImportInput {
  name: string;
  baseUrl: string;
  models: string[];
  issue?: "advanced" | "keyMissing" | "invalid";
  importedProviderId?: string;
}
