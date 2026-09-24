import { describe, expect, it } from "vitest";
import { estimateCostUsd, getModelPricing } from "./pricing";

describe("pricing", () => {
  it("knows the default model and nothing it has not been told about", () => {
    expect(getModelPricing("deepseek/deepseek-v4.1-flash")).toEqual({
      inputPerMTok: 0.14,
      outputPerMTok: 0.42,
      cacheReadPerMTok: 0.0042,
    });
    expect(getModelPricing("deepseek/deepseek-v4.1-flash:batch")).toBeUndefined();
    expect(getModelPricing("toString")).toBeUndefined();
  });

  it("prices cached input at the cache-read rate", () => {
    const cost = estimateCostUsd("deepseek/deepseek-v4.1-flash", {
      inputTokens: 2_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    expect(cost).toBeCloseTo(0.14 + 0.0042 + 0.21, 10);
  });

  it("clamps inconsistent usage and returns undefined for unknown models", () => {
    const cost = estimateCostUsd(
      "x",
      { inputTokens: 10, cachedInputTokens: 50, outputTokens: 0 },
      {
        inputPerMTok: 1,
        outputPerMTok: 1,
      },
    );
    expect(cost).toBeCloseTo(10 / 1_000_000, 12);
    expect(estimateCostUsd("unknown/model", { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
  });
});
