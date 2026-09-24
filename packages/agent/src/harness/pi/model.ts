import type { ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DEFAULT_APP_NAME, OPENROUTER_BASE_URL } from "../../llm/openrouter";
import { getModelPricing } from "../../llm/pricing";
import type { ThinkingLevel } from "../types";

export const OPENROUTER_PROVIDER = "openrouter";

/**
 * Max completion tokens OpenRouter accepts per model. Pi sends `model.maxTokens` as the completion
 * cap on every request, and its bundled catalog overstates it for some models.
 */
const MAX_OUTPUT_TOKENS: Readonly<Record<string, number>> = {
  "deepseek/deepseek-v4.1-flash": 131_072,
};

const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 32_768;

export interface ModelAttribution {
  appName?: string;
  appUrl?: string;
  /** OpenAI-compatible endpoint replacing OpenRouter's, e.g. a local fake of its API. */
  baseUrl?: string;
}

/**
 * Pi model for an OpenRouter id: Pi's catalog entry when present (it carries the right compat
 * flags, e.g. reasoning format), with our verified pricing and output cap layered on top.
 */
export function resolveOpenRouterModel(
  modelId: string,
  runtime: Pick<ModelRuntime, "getModel">,
  attribution: ModelAttribution = {},
): Model<Api> {
  const baseUrl = attribution.baseUrl?.trim().replace(/\/+$/, "") || undefined;
  const headers = {
    "X-Title": attribution.appName ?? DEFAULT_APP_NAME,
    ...(attribution.appUrl ? { "HTTP-Referer": attribution.appUrl } : {}),
  };
  const pricing = getModelPricing(modelId);
  const cost = pricing
    ? {
        input: pricing.inputPerMTok,
        output: pricing.outputPerMTok,
        cacheRead: pricing.cacheReadPerMTok ?? pricing.inputPerMTok,
        cacheWrite: pricing.cacheWritePerMTok ?? 0,
      }
    : undefined;
  const cap = MAX_OUTPUT_TOKENS[modelId];
  const base = runtime.getModel(OPENROUTER_PROVIDER, modelId);
  if (base) {
    return {
      ...base,
      ...(baseUrl ? { baseUrl } : {}),
      cost: cost ?? base.cost,
      maxTokens: cap === undefined ? base.maxTokens : Math.min(base.maxTokens, cap),
      headers: { ...base.headers, ...headers },
    };
  }
  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: OPENROUTER_PROVIDER,
    baseUrl: baseUrl ?? OPENROUTER_BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    maxTokens: cap ?? FALLBACK_MAX_TOKENS,
    headers,
    compat: {
      supportsDeveloperRole: false,
      thinkingFormat: "openrouter",
      sendSessionAffinityHeaders: true,
    },
  };
  return model;
}

/** Pi clamps levels a model does not support to the nearest supported one. */
export function toPiThinkingLevel(level: ThinkingLevel | undefined): PiThinkingLevel {
  return level ?? "medium";
}
