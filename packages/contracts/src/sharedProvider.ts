import { z } from "zod";

export const SharedProviderProtocolSchema = z.enum(["anthropic", "chat-completions", "responses"]);
export type SharedProviderProtocol = z.infer<typeof SharedProviderProtocolSchema>;
export const SharedProviderAgentSchema = z.enum(["claude", "codex", "pi"]);
export type SharedProviderAgent = z.infer<typeof SharedProviderAgentSchema>;

const HttpUrlSchema = z.string().max(2_048).url().refine((value) => {
  const match = /^https?:\/\/([^/?#]*)(?:[/?#]|$)/i.exec(value);
  return Boolean(match && !match[1]?.includes("@") && !value.includes("?") && !value.includes("#"));
}, "must be an http(s) URL without embedded credentials, query, or fragment");

export const SharedProviderModelSchema = z.object({
  id: z.string().trim().min(1).max(256),
  label: z.string().trim().min(1).max(256).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.enum(["text", "image"])).min(1).max(2).optional(),
}).strict();

const EndpointOverridesSchema = z.object({
  anthropic: HttpUrlSchema.optional(),
  "chat-completions": HttpUrlSchema.optional(),
  responses: HttpUrlSchema.optional(),
}).strict().optional();

function compatible(value: { protocols: SharedProviderProtocol[]; enabledAgents: SharedProviderAgent[] }): boolean {
  const protocols = new Set(value.protocols);
  return value.enabledAgents.every((agent) =>
    agent === "claude" ? protocols.has("anthropic") || protocols.has("chat-completions")
      : agent === "codex" ? protocols.has("responses")
        : value.protocols.length > 0);
}

const SharedProviderCoreShape = {
  name: z.string().trim().min(1).max(256),
  baseUrl: HttpUrlSchema,
  protocols: z.array(SharedProviderProtocolSchema).min(1).max(3),
  endpointOverrides: EndpointOverridesSchema,
  models: z.array(SharedProviderModelSchema).min(1).max(1_000),
  enabledAgents: z.array(SharedProviderAgentSchema).min(1).max(3),
};

function validateCore(value: { protocols: SharedProviderProtocol[]; enabledAgents: SharedProviderAgent[]; models: Array<{ id: string }>; endpointOverrides?: Partial<Record<SharedProviderProtocol, string>> }, ctx: z.RefinementCtx): void {
  if (new Set(value.protocols).size !== value.protocols.length) ctx.addIssue({ code: "custom", message: "protocols must be unique" });
  if (new Set(value.enabledAgents).size !== value.enabledAgents.length) ctx.addIssue({ code: "custom", message: "enabledAgents must be unique" });
  if (new Set(value.models.map((model) => model.id)).size !== value.models.length) ctx.addIssue({ code: "custom", message: "model ids must be unique" });
  if (!compatible(value)) ctx.addIssue({ code: "custom", message: "enabled agent has no compatible protocol" });
  for (const protocol of Object.keys(value.endpointOverrides ?? {})) {
    if (!value.protocols.includes(protocol as SharedProviderProtocol)) ctx.addIssue({ code: "custom", message: `endpoint override requires enabled protocol: ${protocol}` });
  }
}

export const SharedProviderPublicSchema = z.object({
  ...SharedProviderCoreShape,
  id: z.string().uuid(),
  hasApiKey: z.boolean(),
}).strict().superRefine(validateCore);
export type SharedProviderPublic = z.infer<typeof SharedProviderPublicSchema>;

export const SharedProviderSaveInputSchema = z.object({
  ...SharedProviderCoreShape,
  id: z.string().uuid().optional(),
  apiKey: z.string().max(65_536).optional(),
}).strict().superRefine(validateCore);
export type SharedProviderSaveInput = z.infer<typeof SharedProviderSaveInputSchema>;

export const SharedProviderRemoveInputSchema = z.object({ id: z.string().uuid() }).strict();
export type SharedProviderRemoveInput = z.infer<typeof SharedProviderRemoveInputSchema>;

export function sharedRuntimeId(id: string): string {
  const parsed = z.string().uuid().parse(id);
  return `shared_${parsed.replaceAll("-", "")}`;
}
