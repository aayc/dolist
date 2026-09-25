// @vitest-environment happy-dom
import type {
  AgentPlacementStatus,
  AgentStatusResponse,
  DeviceSettingsPatch,
  DeviceSettingsResponse,
} from "@ddl/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../../api/client";
import { HttpError } from "../../api/errors";
import { type Services, ServicesContext } from "../../app/services";
import { initialAgentState } from "../../state/agent-reducer";
import { useAgentStore } from "../../state/agent-store";
import { ui } from "../../state/ui-store";
import { AgentLocation } from "./AgentLocation";
import { useDeviceStore } from "./device-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DEVICE: DeviceSettingsResponse = {
  device: { id: "dev_laptop", name: "Laptop" },
  placement: "this_device",
  remoteHosts: [],
  sync: { url: "https://sync.example.com", vault: "v", hasToken: true },
  lockedByEnv: [],
};

let root: Root | null = null;
let container: HTMLElement;

function render(
  placement: AgentPlacementStatus,
  options: {
    device?: DeviceSettingsResponse;
    update?: (patch: DeviceSettingsPatch) => Promise<DeviceSettingsResponse>;
  } = {},
) {
  useAgentStore.setState(
    { ...initialAgentState, status: { enabled: true, placement } as AgentStatusResponse },
    true,
  );
  useDeviceStore.setState({
    device: options.device ?? DEVICE,
    loadError: null,
    pendingPlacement: null,
    placementError: null,
  });
  const updateDevice = vi.fn(
    options.update ??
      (async (patch: DeviceSettingsPatch) => ({ ...DEVICE, ...patch }) as DeviceSettingsResponse),
  );
  const client = { updateDevice, getDevice: vi.fn(async () => DEVICE) } as unknown as DaemonClient;
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  act(() => {
    root!.render(
      <ServicesContext value={{ client } as unknown as Services}>
        <AgentLocation />
      </ServicesContext>,
    );
  });
  return { updateDevice };
}

const q = <T extends Element = HTMLElement>(testId: string) =>
  container.querySelector<T>(`[data-testid="${testId}"]`);

const MACHINE = { deviceId: "dev_vm", name: "vm-1", thisDevice: false, alwaysOnMachine: true };
const HERE = { deviceId: "dev_laptop", name: "Laptop", thisDevice: true, alwaysOnMachine: false };

beforeEach(() => {
  ui.set({ overlay: null });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
});

describe("the agent panel's location header", () => {
  it("isn't shown for a daemon that doesn't report placement", () => {
    useAgentStore.setState(
      { ...initialAgentState, status: { enabled: true } as AgentStatusResponse },
      true,
    );
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
    act(() => root!.render(<AgentLocation />));
    expect(container.innerHTML).toBe("");
  });

  it("flips where the orchestrator runs with PATCH /api/device", async () => {
    const { updateDevice } = render({ placement: "this_device", runsOn: HERE, relay: "off" });
    const toggle = q("placement-toggle")!;
    expect(toggle.dataset.selected).toBe("this_device");
    expect(q("agent-location-line-text")?.textContent).toBe("Running on this device");
    await act(async () => q<HTMLButtonElement>("placement-toggle-always_on_machine")!.click());
    expect(updateDevice).toHaveBeenCalledWith({ placement: "always_on_machine" });
    expect(q("placement-toggle")!.dataset.selected).toBe("always_on_machine");
    expect(useAgentStore.getState().status?.placement?.placement).toBe("always_on_machine");
    // Clicking the chosen side again does nothing.
    await act(async () => q<HTMLButtonElement>("placement-toggle-always_on_machine")!.click());
    expect(updateDevice).toHaveBeenCalledTimes(1);
  });

  it("is disabled while held here, with a tooltip saying why and a link to the fix", () => {
    render({ placement: "this_device", heldHere: "no_machine", runsOn: HERE, relay: "off" });
    const toggle = q("placement-toggle")!;
    expect(toggle.dataset.tooltip).toBe("Set up an always-on machine in Settings");
    for (const button of toggle.querySelectorAll("button")) expect(button.disabled).toBe(true);
    const link = q<HTMLButtonElement>("agent-location-line-action")!;
    expect(link.textContent).toBe("Set up an always-on machine");
    act(() => link.click());
    expect(ui.get().overlay).toEqual({ kind: "settings", section: "machine" });
  });

  it("shows the handover note as it happens", () => {
    render({
      placement: "this_device",
      runsOn: MACHINE,
      relay: "off",
      note: "Taking over from vm-1…",
    });
    expect(q("agent-location-line")!.dataset.kind).toBe("note");
    expect(q("agent-location-line-text")!.textContent).toBe("Taking over from vm-1…");
  });

  it("offers running here when the machine can't be reached", async () => {
    const { updateDevice } = render({
      placement: "always_on_machine",
      runsOn: MACHINE,
      relay: "unreachable",
    });
    expect(q("agent-location-line-text")!.textContent).toBe(
      "The always-on machine can't be reached",
    );
    await act(async () => q<HTMLButtonElement>("agent-location-line-action")!.click());
    expect(updateDevice).toHaveBeenCalledWith({ placement: "this_device" });
  });

  it("says this is the always-on machine on the machine itself", () => {
    render({
      placement: "always_on_host",
      runsOn: { ...HERE, alwaysOnMachine: true },
      relay: "off",
    });
    expect(q("placement-toggle")).toBeNull();
    expect(q("placement-host")!.textContent).toBe("This is the always-on machine");
    expect(q("agent-location-line-text")!.textContent).toBe("Running here");
  });

  it("explains a refused change and keeps the stored choice", async () => {
    render(
      { placement: "this_device", runsOn: HERE, relay: "off" },
      {
        update: async () => {
          throw new HttpError(409, "locked", { error: "locked_by_env", message: "locked" });
        },
      },
    );
    await act(async () => q<HTMLButtonElement>("placement-toggle-always_on_machine")!.click());
    expect(q("placement-toggle")!.dataset.selected).toBe("this_device");
    expect(q("agent-location-line")!.dataset.kind).toBe("error");
    expect(q("agent-location-line-text")!.textContent).toContain("DDL_AGENT_PLACEMENT");
  });

  it("is disabled when an environment variable sets it", () => {
    render(
      { placement: "this_device", runsOn: HERE, relay: "off" },
      { device: { ...DEVICE, lockedByEnv: ["placement"] } },
    );
    expect(q("placement-toggle")!.dataset.tooltip).toContain("DDL_AGENT_PLACEMENT");
  });
});
