import { AGENT_HARNESS_KINDS, type AgentHarnessKind } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { HARNESS_OPTIONS, shownHarness } from "./agent-harness";

describe("agent harness choice", () => {
  it("offers every harness once", () => {
    expect(HARNESS_OPTIONS.map((option) => option.kind)).toEqual([...AGENT_HARNESS_KINDS]);
  });

  it("shows the configured harness", () => {
    expect(shownHarness({ harness: "pi" })).toBe("pi");
    expect(shownHarness({ harness: "cursor" })).toBe("cursor");
  });

  it("shows a harness it doesn't know (from a newer daemon) as Pi", () => {
    expect(shownHarness({ harness: "claude" as AgentHarnessKind })).toBe("pi");
  });
});
