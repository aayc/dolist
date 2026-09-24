import { silentLogger } from "@ddl/core";
import { describe, expect, it, vi } from "vitest";
import { type HarnessSetupContext, setupHarness } from "./registry";

const context = (overrides: Partial<HarnessSetupContext> = {}): HarnessSetupContext => ({
  home: "/tmp/ddl-registry-test",
  logger: silentLogger,
  env: {},
  ...overrides,
});

describe("setupHarness", () => {
  it("pi: needs an OpenRouter key that OpenRouter accepts", async () => {
    expect(await setupHarness("pi", context())).toEqual({
      problem: expect.stringContaining("OPENROUTER_API_KEY is not set"),
    });
    const invalid = await setupHarness(
      "pi",
      context({
        env: { OPENROUTER_API_KEY: "sk-or-x" },
        checkOpenRouterKey: async () => ({
          status: "invalid",
          httpStatus: 401,
          message: "No auth",
        }),
      }),
    );
    expect(invalid).toEqual({
      problem: expect.stringMatching(/OpenRouter rejected OPENROUTER_API_KEY \(401/),
    });
    const ready = await setupHarness(
      "pi",
      context({
        openRouter: { apiKey: "sk-or-x" },
        checkOpenRouterKey: async () => ({ status: "valid" }),
      }),
    );
    expect("harness" in ready && ready.harness.name).toBe("pi");
  });

  it("cursor: needs the CLI installed and signed in, and no OpenRouter key", async () => {
    const checkOpenRouterKey = vi.fn();
    const problem = async (
      status: Awaited<ReturnType<NonNullable<HarnessSetupContext["checkCursorCli"]>>>,
    ) =>
      setupHarness("cursor", context({ checkOpenRouterKey, checkCursorCli: async () => status }));
    expect(await problem({ state: "missing" })).toEqual({
      problem: expect.stringContaining("curl https://cursor.com/install -fsS | bash"),
    });
    expect(await problem({ state: "signed_out", binary: "/b/agent" })).toEqual({
      problem: expect.stringContaining("`agent login`"),
    });
    expect(await problem({ state: "error", binary: "/b/agent", message: "timed out" })).toEqual({
      problem: expect.stringContaining("timed out"),
    });
    const ready = await problem({ state: "ready", binary: "/b/agent" });
    expect("harness" in ready && ready.harness.name).toBe("cursor");
    expect(checkOpenRouterKey).not.toHaveBeenCalled();
  });

  it("explains unknown harness kinds", async () => {
    expect(await setupHarness("other" as never, context())).toEqual({
      problem: 'Unknown agent harness "other".',
    });
  });
});
