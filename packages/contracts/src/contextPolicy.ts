import { z } from "zod";

export const CONTEXT_POLICY_SETTING_KEY = "context.policy";
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export const ContextPolicySchema = z.object({
  autoCompactPercent: z.number().int().min(10).max(90),
});
export type ContextPolicy = z.infer<typeof ContextPolicySchema>;
export const DEFAULT_CONTEXT_POLICY: Readonly<ContextPolicy> = { autoCompactPercent: 80 };

export function parseContextPolicy(value: string | null | undefined): ContextPolicy {
  try {
    const result = ContextPolicySchema.safeParse(value ? JSON.parse(value) : null);
    if (result.success) return result.data;
  } catch { /* Invalid legacy settings fall back to the default. */ }
  return { ...DEFAULT_CONTEXT_POLICY };
}

/** An explicit model capacity takes precedence over the application default. */
export function resolveContextPolicy(modelWindow?: number, policy: ContextPolicy = DEFAULT_CONTEXT_POLICY) {
  const contextWindow = modelWindow && Number.isSafeInteger(modelWindow) && modelWindow > 0
    ? modelWindow : DEFAULT_CONTEXT_WINDOW;
  const autoCompactTokenLimit = Math.floor(contextWindow * policy.autoCompactPercent / 100);
  return { contextWindow, autoCompactTokenLimit, reserveTokens: contextWindow - autoCompactTokenLimit };
}
