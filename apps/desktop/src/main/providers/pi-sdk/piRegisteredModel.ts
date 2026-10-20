import type { PiModelDefinition } from "@contracts/piModel";
import { DEFAULT_CONTEXT_WINDOW } from "@contracts/contextPolicy";

export const PI_SDK_DEFAULT_CONTEXT_WINDOW = DEFAULT_CONTEXT_WINDOW;
export const PI_SDK_DEFAULT_MAX_TOKENS = 16_384;

export interface PiRegisteredModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  [key: string]: unknown;
}

export interface PiRegisteredModel extends PiModelDefinition {
  name: string;
  reasoning: boolean;
  input: string[];
  cost: PiRegisteredModelCost;
  contextWindow: number;
  maxTokens: number;
}

const ZERO_COST: PiRegisteredModelCost = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

function anthropicSdkBaseUrl(value: string): string {
  // Inspect only the path: a host literally named "v1" is not a version path.
  const parts = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(value);
  return parts ? `${parts[1]}${(parts[2] ?? "").replace(/\/v1\/?$/, "")}` : value;
}

/** Normalize the complete model shape required by extension registerProvider.
 * models.json applies these defaults while parsing; the extension path does not. */
export function normalizePiRegisteredModel(model: PiModelDefinition): PiRegisteredModel {
  return {
    ...model,
    // Anthropic's SDK adds /v1/messages itself, unlike OpenAI's SDK. Shared
    // provider URLs commonly end in /v1; passing that verbatim duplicates it.
    ...(model.api === "anthropic-messages" && model.baseUrl
      ? { baseUrl: anthropicSdkBaseUrl(model.baseUrl) }
      : {}),
    name: model.name ?? model.id,
    reasoning: model.reasoning ?? false,
    // The Pi SDK sends a reasoning model's system prompt as the OpenAI
    // `developer` role unless the model opts out. It decides that from the
    // base URL: anything it doesn't recognize as a non-standard vendor counts
    // as standard OpenAI, which includes every third-party gateway. Those
    // gateways usually front vLLM/DeepSeek/Kimi upstreams whose role
    // vocabulary stops at `system`, so the request dies with
    // `400 ... developer is not one of ['system', 'assistant', 'user', 'tool',
    // 'function']` — reported to the user as `upstream returned 400`. Shared
    // providers are always third-party endpoints, so pin the conservative
    // role; an explicit compat in the model definition still wins.
    compat: {
      supportsDeveloperRole: false,
      ...(model.compat as Record<string, unknown> | undefined),
    },
    input: model.input ?? ["text"],
    cost: (model.cost as PiRegisteredModelCost | undefined) ?? { ...ZERO_COST },
    contextWindow: model.contextWindow ?? PI_SDK_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? PI_SDK_DEFAULT_MAX_TOKENS,
  };
}
