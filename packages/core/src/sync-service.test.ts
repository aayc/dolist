import { describe, expect, it } from "vitest";
import {
  AGENT_OWNED_PREFIXES,
  folderHoldsAgentOwnedPaths,
  isAgentOwnedPath,
  LEASE_EPOCH_HEADER,
} from "./sync-service";

describe("agent-owned paths", () => {
  it("are the agent's threads, artifacts and state", () => {
    expect(AGENT_OWNED_PREFIXES).toEqual([
      ".daily-do-list/threads/",
      ".daily-do-list/artifacts/",
      ".daily-do-list/state/",
    ]);
    expect(LEASE_EPOCH_HEADER).toBe("X-DDL-Lease-Epoch");
  });

  it.each([
    ".daily-do-list/threads/thr_k3j9x0q2m1ab.json",
    ".daily-do-list/artifacts/thr_k3j9x0q2m1ab/art_plan01.md",
    ".daily-do-list/state/records.json",
    ".daily-do-list/state/approvals.json",
    ".daily-do-list/state/tasks/0a1b2c.json",
    ".daily-do-list/threads",
    ".daily-do-list/state",
  ])("%s is agent-owned", (path) => {
    expect(isAgentOwnedPath(path)).toBe(true);
    expect(folderHoldsAgentOwnedPaths(path)).toBe(true);
  });

  it.each([
    ".daily-do-list/settings.json",
    ".daily-do-list/corrupt/threads/thr_a.20260923T215800123Z.json",
    ".daily-do-list/threadsX/a.json",
    ".daily-do-list/statefile",
    "Daily/2026-09-25.md",
    "Notes/.daily-do-list/threads/a.json",
    ".Daily-Do-List/threads/a.json",
    "",
  ])("%j is not agent-owned", (path) => {
    expect(isAgentOwnedPath(path)).toBe(false);
  });

  it("counts the folders above them as holding agent-owned paths", () => {
    expect(folderHoldsAgentOwnedPaths(".daily-do-list")).toBe(true);
    expect(folderHoldsAgentOwnedPaths("")).toBe(true);
    expect(folderHoldsAgentOwnedPaths(".daily-do-list/corrupt")).toBe(false);
    expect(folderHoldsAgentOwnedPaths(".daily")).toBe(false);
    expect(folderHoldsAgentOwnedPaths("Daily")).toBe(false);
  });
});
