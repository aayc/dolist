import { describe, expect, it } from "vitest";
import {
  agentItem,
  agentModeLabel,
  connectionItem,
  runningItem,
  visibleSaveState,
} from "./status-items";

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

  it("never says the agent is on while it can't act, and says what a click does", () => {
    expect(agentItem(true, false, null)).toEqual({
      state: "on",
      label: "Agent on",
      title: "The agent is watching your daily notes — click to pause",
    });
    expect(agentItem(false, false, null).title).toBe("The agent is paused — click to resume");
    expect(agentItem(true, false, "Set OPENROUTER_API_KEY")).toMatchObject({
      state: "unavailable",
      title: "Set OPENROUTER_API_KEY",
    });
    expect(agentItem(true, true, null)).toMatchObject({
      state: "off",
      title: "The agent is turned off for this daemon",
    });
    expect(agentItem(null, false, null).state).toBe("unknown");
  });

  it("counts running work, and names what's queued when nothing runs yet", () => {
    expect(runningItem(0, 0)).toBeNull();
    expect(runningItem(2, 0)).toEqual({ label: "2 running", title: "2 agent tasks running" });
    expect(runningItem(1, 3)).toEqual({
      label: "1 running",
      title: "1 agent task running · 3 queued",
    });
    expect(runningItem(0, 3)).toEqual({ label: "3 queued", title: "3 agent tasks queued" });
  });

  it("explains connection problems without a trailing period", () => {
    for (const state of ["connecting", "reconnecting", "offline"] as const) {
      expect(connectionItem(state, "http")?.title).toMatch(/daemon[^.]*$/);
    }
  });
});
