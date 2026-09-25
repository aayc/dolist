/**
 * The sync service fences agent-owned paths (`AGENT_OWNED_PREFIXES` in @ddl/core): every format the
 * agent persists must fall under them, and what other devices may change must not.
 */
import { isAgentOwnedPath } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { PERSISTED_FORMATS, PERSISTED_PATHS } from "../../src/persisted";

describe("agent-owned sidecar paths", () => {
  it.each(PERSISTED_FORMATS.map((format) => [format.name, format] as const))(
    "%s is agent-owned exactly when the agent owns it",
    (_name, format) => {
      expect(isAgentOwnedPath(format.path)).toBe(format.owner.startsWith("packages/agent/"));
    },
  );

  it("leaves settings, corrupt copies and the sync engine's state to every device", () => {
    for (const path of [PERSISTED_PATHS.settings, PERSISTED_PATHS.corrupt, PERSISTED_PATHS.sync]) {
      expect(isAgentOwnedPath(path), path).toBe(false);
    }
    for (const path of [
      PERSISTED_PATHS.threads,
      PERSISTED_PATHS.artifacts,
      PERSISTED_PATHS.taskState,
      PERSISTED_PATHS.records,
      PERSISTED_PATHS.approvals,
    ]) {
      expect(isAgentOwnedPath(path), path).toBe(true);
    }
  });
});
