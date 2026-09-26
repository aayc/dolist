import type { AgentPlacementStatus, AgentReadiness, AgentRunsOn } from "@ddl/core";
import { describe, expect, it } from "vitest";
import {
  locationLine,
  PLACEMENT_LOCKED,
  PLACEMENT_MOVING,
  readOnlyReason,
  runsOnText,
  toggleState,
} from "./placement";

const HERE: AgentRunsOn = {
  deviceId: "dev_laptop",
  name: "Laptop",
  thisDevice: true,
  alwaysOnMachine: false,
};
const MACHINE: AgentRunsOn = {
  deviceId: "dev_vm",
  name: "vm-1",
  thisDevice: false,
  alwaysOnMachine: true,
};
const OTHER: AgentRunsOn = {
  deviceId: "dev_work",
  name: "Work laptop",
  thisDevice: false,
  alwaysOnMachine: false,
};

function status(patch: Partial<AgentPlacementStatus> = {}): AgentPlacementStatus {
  return { placement: "this_device", runsOn: HERE, relay: "off", ...patch };
}

const READY: AgentReadiness = {
  harness: { kind: "pi", ready: true },
  modelCredential: true,
  browser: true,
  computer: "available",
  connectors: { configured: 2, connected: 2 },
};

describe("the Remote switch", () => {
  const unlocked = { locked: false, pending: null };

  it("isn't there when the daemon doesn't report placement, or on the always-on machine", () => {
    expect(toggleState(undefined, unlocked)).toBeNull();
    expect(toggleState(status({ placement: "always_on_host" }), unlocked)).toBeNull();
  });

  it("shows the stored choice, enabled: on for the always-on machine", () => {
    expect(toggleState(status(), unlocked)).toEqual({ remote: false, disabled: null });
    expect(toggleState(status({ placement: "always_on_machine" }), unlocked)).toEqual({
      remote: true,
      disabled: null,
    });
  });

  it("is disabled while held here, saying why, and keeps the stored choice", () => {
    expect(toggleState(status({ heldHere: "no_machine" }), unlocked)).toEqual({
      remote: false,
      disabled: "Set up an always-on machine in Settings",
    });
    expect(
      toggleState(status({ placement: "always_on_machine", heldHere: "no_sync" }), unlocked),
    ).toEqual({ remote: true, disabled: "This device doesn't sync" });
  });

  it("is disabled when an environment variable sets the placement", () => {
    expect(toggleState(status(), { locked: true, pending: null })).toMatchObject({
      disabled: PLACEMENT_LOCKED,
    });
  });

  it("shows a choice being saved, disabled until the daemon answers", () => {
    expect(toggleState(status(), { locked: false, pending: "always_on_machine" })).toEqual({
      remote: true,
      disabled: PLACEMENT_MOVING,
    });
  });
});

describe("where the agent runs", () => {
  it("names the device", () => {
    expect(runsOnText(HERE).text).toBe("Running on this device");
    expect(runsOnText({ ...HERE, alwaysOnMachine: true }).text).toBe("Running here");
    expect(runsOnText(MACHINE)).toMatchObject({
      text: "Running on vm-1",
      tone: "machine",
      detail: "vm-1 is the always-on machine",
    });
    expect(runsOnText(OTHER)).toMatchObject({ text: "Running on Work laptop", tone: "other" });
    expect(runsOnText(null)).toMatchObject({ text: "Not running right now", tone: "idle" });
  });

  it("shows the handover note while it happens, before anything else but an error", () => {
    const moving = status({ note: "Taking over from vm-1…", runsOn: MACHINE });
    expect(locationLine(moving, {})).toMatchObject({
      kind: "note",
      text: "Taking over from vm-1…",
    });
    expect(locationLine(moving, { error: "Couldn't reach Daily Do List." })).toMatchObject({
      kind: "error",
      tone: "danger",
    });
  });

  it("offers running here when the machine can't be reached, unless that's locked", () => {
    const down = status({ placement: "always_on_machine", relay: "unreachable", runsOn: MACHINE });
    expect(locationLine(down, { machineName: "vm-1" })).toEqual({
      kind: "unreachable",
      text: "vm-1 can't be reached",
      tone: "danger",
      action: { kind: "run_here", label: "Run it on this device instead" },
    });
    expect(locationLine(down, { machineName: "vm-1", locked: true }).action).toBeUndefined();
  });

  it("asks to pair again when the machine no longer accepts this device", () => {
    const line = locationLine(
      status({ placement: "always_on_machine", relay: "not_paired", runsOn: MACHINE }),
      { problem: "The always-on machine no longer accepts this device. Pair it again." },
    );
    expect(line).toMatchObject({
      text: "The always-on machine no longer accepts this device",
      action: { kind: "settings", section: "machine", label: "Pair it again" },
    });
  });

  it("links to pairing when this device isn't paired with the machine", () => {
    const line = locationLine(
      status({ placement: "always_on_machine", relay: "not_paired", runsOn: MACHINE }),
      {},
    );
    expect(line).toMatchObject({
      kind: "not_paired",
      action: { kind: "settings", section: "machine", label: "Pair it" },
    });
  });

  it("links to the Settings section that ends holding the agent here", () => {
    expect(locationLine(status({ heldHere: "no_machine" }), {})).toMatchObject({
      kind: "runs",
      text: "Running on this device",
      action: { kind: "settings", section: "machine", label: "Set up an always-on machine" },
    });
    expect(
      locationLine(status({ placement: "always_on_machine", heldHere: "no_sync" }), {}),
    ).toMatchObject({
      kind: "held",
      text: "Held on this device until it syncs",
      action: { kind: "settings", section: "sync", label: "Set up sync" },
    });
  });

  it("warns when this device runs the agent but can't", () => {
    const line = locationLine(status(), {
      readiness: { ...READY, modelCredential: false },
    });
    expect(line).toMatchObject({
      text: "Running on this device, which isn't ready",
      tone: "warning",
      detail: "It has no model credential",
      action: { kind: "settings", section: "location", label: "See why" },
    });
    expect(locationLine(status(), { readiness: READY })).toMatchObject({ tone: "here" });
  });
});

describe("the read-only reason", () => {
  it("is null where this device can act on the agent", () => {
    expect(readOnlyReason(undefined)).toBeNull();
    expect(readOnlyReason(status())).toBeNull();
    expect(readOnlyReason(status({ runsOn: null }))).toBeNull();
    expect(
      readOnlyReason(
        status({ placement: "always_on_machine", relay: "connected", runsOn: MACHINE }),
      ),
    ).toBeNull();
  });

  it("says why otherwise", () => {
    const relayed = { placement: "always_on_machine" as const, runsOn: MACHINE };
    expect(readOnlyReason(status({ ...relayed, relay: "unreachable" }))).toBe(
      "The always-on machine can't be reached",
    );
    expect(readOnlyReason(status({ ...relayed, relay: "not_paired" }))).toBe(
      "This device isn't paired with the always-on machine",
    );
    // Requests are already forwarded while the relay connects.
    expect(readOnlyReason(status({ ...relayed, relay: "connecting" }))).toBeNull();
    expect(
      readOnlyReason(
        status({ ...relayed, relay: "not_paired" }),
        "The always-on machine no longer accepts this device. Pair it again.",
      ),
    ).toBe("The always-on machine no longer accepts this device");
    expect(
      readOnlyReason(
        status({ ...relayed, relay: "not_paired" }),
        "This device isn't paired with the always-on machine.",
      ),
    ).toBe("This device isn't paired with the always-on machine");
    expect(readOnlyReason(status({ runsOn: OTHER }))).toBe("The agent is running on Work laptop");
    expect(readOnlyReason(status({ ...relayed, relay: "connected", runsOn: OTHER }))).toBe(
      "The agent is running on Work laptop",
    );
    // Relayed while the machine doesn't run the agent (the daemon answers 503 until it does).
    expect(readOnlyReason(status({ placement: "always_on_machine", runsOn: null }))).toBe(
      "The always-on machine isn't running the agent right now",
    );
    expect(
      readOnlyReason(status({ placement: "always_on_machine", runsOn: null, heldHere: "no_sync" })),
    ).toBeNull();
    // Taking over from the machine: read-only until this device holds the agent.
    expect(readOnlyReason(status({ runsOn: MACHINE, note: "Taking over from vm-1…" }))).toBe(
      "The agent is running on vm-1",
    );
  });
});
