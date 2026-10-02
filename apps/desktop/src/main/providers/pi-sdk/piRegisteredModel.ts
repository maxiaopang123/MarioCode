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
    input: model.input ?? ["text"],
    cost: (model.cost as PiRegisteredModelCost | undefined) ?? { ...ZERO_COST },
    contextWindow: model.contextWindow ?? PI_SDK_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? PI_SDK_DEFAULT_MAX_TOKENS,
  };
}
