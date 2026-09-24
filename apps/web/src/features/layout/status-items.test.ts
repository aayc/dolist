import { describe, expect, it } from "vitest";
import { agentModeLabel, connectionItem, visibleSaveState } from "./status-items";

describe("status bar items", () => {
  it("shows the save state only when the note isn't saved", () => {
    expect(visibleSaveState("saved")).toBeNull();
    expect(visibleSaveState(null)).toBeNull();
    expect(visibleSaveState("dirty")).toBe("dirty");
    expect(visibleSaveState("saving")).toBe("saving");
    expect(visibleSaveState("conflict")).toBe("conflict");
    expect(visibleSaveState("error")).toBe("error");
  });

  it("shows the connection only when it isn't connected, plus a demo marker", () => {
    expect(connectionItem("online", "http")).toBeNull();
    expect(connectionItem("online", null)).toBeNull();
    expect(connectionItem("online", "mock")?.label).toBe("Demo");
    expect(connectionItem("connecting", "http")?.label).toBe("Connecting…");
    expect(connectionItem("reconnecting", "http")?.label).toBe("Reconnecting…");
    expect(connectionItem("offline", "http")?.label).toBe("Offline");
    // A problem wins over the demo marker.
    expect(connectionItem("offline", "mock")?.label).toBe("Offline");
  });

  it("names the agent mode only when it isn't live", () => {
    expect(agentModeLabel("live")).toBeNull();
    expect(agentModeLabel(null)).toBeNull();
    expect(agentModeLabel("mock")).toBe("mock");
    expect(agentModeLabel("off")).toBe("off");
  });
});
