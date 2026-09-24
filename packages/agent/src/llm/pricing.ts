/**
 * USD prices per million tokens, as published by OpenRouter. Used to estimate cost when the
 * provider does not report it (OpenRouter reports actual cost with `usage: { include: true }`)
 * and to configure the Pi harness, which computes cost locally from these rates.
 */

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
}

export interface TokenUsage {
  /** Total prompt tokens, including cached ones (OpenAI/OpenRouter semantics). */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}

/** Exact OpenRouter ids only: variants such as `:batch` or `:nitro` are priced differently. */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "deepseek/deepseek-v4.1-flash": {
    inputPerMTok: 0.14,
    outputPerMTok: 0.42,
    cacheReadPerMTok: 0.0042,
  },
};

export function getModelPricing(model: string): ModelPricing | undefined {
  return Object.hasOwn(MODEL_PRICING, model) ? MODEL_PRICING[model] : undefined;
}

/** Estimated cost in USD, or `undefined` when the model is not in the price table. */
export function estimateCostUsd(
  model: string,
  usage: TokenUsage,
  pricing: ModelPricing | undefined = getModelPricing(model),
): number | undefined {
  if (!pricing) return undefined;
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const cacheWrite = Math.min(usage.cacheWriteTokens ?? 0, usage.inputTokens - cached);
  const uncached = usage.inputTokens - cached - cacheWrite;
  const cost =
    uncached * pricing.inputPerMTok +
    cached * (pricing.cacheReadPerMTok ?? pricing.inputPerMTok) +
    cacheWrite * (pricing.cacheWritePerMTok ?? pricing.inputPerMTok) +
    usage.outputTokens * pricing.outputPerMTok;
  return cost / 1_000_000;
}
