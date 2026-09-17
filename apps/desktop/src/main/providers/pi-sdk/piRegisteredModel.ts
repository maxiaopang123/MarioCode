import type { PiModelDefinition } from "@contracts/piModel";

export const PI_SDK_DEFAULT_CONTEXT_WINDOW = 128_000;
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

/** Normalize the complete model shape required by extension registerProvider.
 * models.json applies these defaults while parsing; the extension path does not. */
export function normalizePiRegisteredModel(model: PiModelDefinition): PiRegisteredModel {
  return {
    ...model,
    name: model.name ?? model.id,
    reasoning: model.reasoning ?? false,
    input: model.input ?? ["text"],
    cost: (model.cost as PiRegisteredModelCost | undefined) ?? { ...ZERO_COST },
    contextWindow: model.contextWindow ?? PI_SDK_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? PI_SDK_DEFAULT_MAX_TOKENS,
  };
}
