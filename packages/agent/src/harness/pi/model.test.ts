import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveOpenRouterModel, toPiThinkingLevel } from "./model";

describe("resolveOpenRouterModel", () => {
  let dir: string;
  let runtime: ModelRuntime;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ddl-model-"));
    runtime = await ModelRuntime.create({
      authPath: path.join(dir, "auth.json"),
      modelsPath: path.join(dir, "models.json"),
      allowModelNetwork: false,
    });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("uses Pi's catalog entry with our pricing, output cap and attribution", () => {
    const model = resolveOpenRouterModel("deepseek/deepseek-v4.1-flash", runtime, {
      appName: "Daily Do List",
      appUrl: "https://example.com",
    });
    expect(model).toMatchObject({
      id: "deepseek/deepseek-v4.1-flash",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      cost: { input: 0.14, output: 0.42, cacheRead: 0.0042, cacheWrite: 0 },
      headers: { "X-Title": "Daily Do List", "HTTP-Referer": "https://example.com" },
      compat: { thinkingFormat: "openrouter", sendSessionAffinityHeaders: true },
    });
    expect(model.thinkingLevelMap?.off).toBe("none");
  });

  it("builds a conservative OpenRouter model for ids missing from the catalog", () => {
    const model = resolveOpenRouterModel("acme/brand-new-model", runtime);
    expect(model).toMatchObject({
      id: "acme/brand-new-model",
      provider: "openrouter",
      api: "openai-completions",
      input: ["text"],
      headers: { "X-Title": "Daily Do List" },
      compat: { thinkingFormat: "openrouter" },
    });
    expect(model.headers).not.toHaveProperty("HTTP-Referer");
  });
});

describe("toPiThinkingLevel", () => {
  it("passes levels through and defaults to medium", () => {
    expect(toPiThinkingLevel("off")).toBe("off");
    expect(toPiThinkingLevel("high")).toBe("high");
    expect(toPiThinkingLevel(undefined)).toBe("medium");
  });
});
