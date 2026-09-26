import { describe, expect, it } from "vitest";
import {
  agentItem,
  agentModeLabel,
  computerItem,
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

  it("shows the connection only when it isn't connected", () => {
    expect(connectionItem("online")).toBeNull();
    expect(connectionItem("connecting")?.label).toBe("Connecting…");
    expect(connectionItem("reconnecting")?.label).toBe("Reconnecting…");
    expect(connectionItem("offline")?.label).toBe("Offline");
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

  it("says where the agent runs when it isn't here", () => {
    const vm = { deviceId: "dev_vm", name: "vm-1", thisDevice: false, alwaysOnMachine: true };
    const work = {
      deviceId: "dev_w",
      name: "Work laptop",
      thisDevice: false,
      alwaysOnMachine: false,
    };
    const here = { deviceId: "dev_l", name: "Laptop", thisDevice: true, alwaysOnMachine: false };
    const relayed = { placement: "always_on_machine" as const, runsOn: vm };
    expect(agentItem(true, false, null, { ...relayed, relay: "connected" })).toEqual({
      state: "on",
      label: "Agent on vm-1",
      title: "The agent runs on vm-1, the always-on machine — click to pause",
    });
    expect(agentItem(false, false, null, { ...relayed, relay: "connected" }).state).toBe("paused");
    expect(agentItem(true, false, "x", { ...relayed, relay: "unreachable" })).toMatchObject({
      state: "unavailable",
      label: "Agent unreachable",
      location: true,
    });
    expect(agentItem(true, false, "x", { ...relayed, relay: "not_paired" })).toMatchObject({
      label: "Agent not paired",
    });
    expect(
      agentItem(true, false, "The agent is running on Work laptop.", {
        placement: "this_device",
        runsOn: work,
        relay: "off",
      }),
    ).toMatchObject({ state: "elsewhere", label: "Agent on Work laptop", location: true });
    expect(
      agentItem(true, false, null, { placement: "this_device", runsOn: here, relay: "off" }),
    ).toMatchObject({ state: "on", label: "Agent on" });
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
      expect(connectionItem(state)?.title).toMatch(/daemon[^.]*$/);
    }
  });

  it("warns about missing computer access only while the agent is on", () => {
    const missing = {
      accessibility: false,
      screenRecording: false,
      appControl: true,
      hostApp: { name: "Terminal" },
    };
    expect(computerItem(missing, true)).toEqual({
      label: "Computer access",
      title:
        "Agents can't use your Mac's apps yet: allow Accessibility and Screen Recording for “Terminal”",
    });
    expect(computerItem({ ...missing, accessibility: true, hostApp: undefined }, true)?.title).toBe(
      "Agents can't use your Mac's apps yet: allow Screen Recording for the app running Daily Do List",
    );
    expect(computerItem(missing, false)).toBeNull();
    expect(
      computerItem({ ...missing, accessibility: true, screenRecording: true }, true),
    ).toBeNull();
    expect(computerItem(undefined, true)).toBeNull();
  });
});
