import {
  type AgentStatusResponse,
  type AlwaysOnMachine,
  type AppSettings,
  DEFAULT_SETTINGS,
  mergeSettings,
  silentLogger,
} from "@ddl/core";
import { SyncServiceClient } from "@ddl/storage";
import { createSyncServer, type RunningSyncServer } from "@ddl/sync";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaseTimings } from "./agent-lease";
import type { MachineCredential } from "./agent-location";
import { AgentSupervisor, effectivePlacement } from "./agent-supervisor";
import { memoryDeviceSettings } from "./device-settings";
import { LeasedAgentRuntime } from "./leased-runtime";
import type { SyncController } from "./sync-controller";
import { FakeAgentRuntime } from "./test-helpers";

const TIMINGS: Partial<LeaseTimings> = {
  ttlMs: 5_000,
  renewEveryMs: 100,
  retryEveryMs: 50,
  takeoverRetryMs: 30,
  maxBackoffMs: 200,
  marginMs: 1_000,
};
const MACHINE: AlwaysOnMachine = { name: "vm-1", url: "https://vm-1.tailnet-name.ts.net" };

describe("effectivePlacement", () => {
  it("holds the agent here without sync or without an always-on machine", () => {
    const machine = MACHINE;
    expect(effectivePlacement("always_on_machine", { syncing: true, machine })).toEqual({
      effective: "always_on_machine",
    });
    expect(effectivePlacement("always_on_host", { syncing: true, machine })).toEqual({
      effective: "always_on_host",
    });
    expect(effectivePlacement("always_on_machine", { syncing: false, machine })).toEqual({
      effective: "this_device",
      heldHere: "no_sync",
    });
    expect(effectivePlacement("always_on_machine", { syncing: true, machine: null })).toEqual({
      effective: "this_device",
      heldHere: "no_machine",
    });
    expect(effectivePlacement("this_device", { syncing: false, machine: null })).toEqual({
      effective: "this_device",
      heldHere: "no_sync",
    });
  });
});

describe("AgentSupervisor", () => {
  let server: RunningSyncServer;
  let vault: { id: string; token: string };
  const running: AgentSupervisor[] = [];

  beforeEach(async () => {
    server = await createSyncServer({ db: ":memory:", port: 0 });
    const created = server.store.createVault("Shared");
    vault = { id: created.vault.id, token: created.token };
  });

  afterEach(async () => {
    await Promise.all(running.splice(0).map((supervisor) => supervisor.stop()));
    await server.close();
  });

  const client = (deviceId: string) =>
    new SyncServiceClient({ url: server.url, vault: vault.id, token: vault.token, deviceId });

  /** A supervisor for device "Laptop" over a fake sync controller and a fake agent. */
  function setup(options: { syncing?: boolean; machine?: AlwaysOnMachine | null } = {}) {
    const device = { id: "dev_laptop", name: "Laptop" };
    let settings: AppSettings = mergeSettings(DEFAULT_SETTINGS, {
      remote: { alwaysOnMachine: options.machine === undefined ? MACHINE : options.machine },
    });
    const settingsListeners = new Set<(settings: AppSettings) => void>();
    const deviceSettings = memoryDeviceSettings({ device });
    let credential: MachineCredential | null = null;
    const credentialListeners = new Set<(credential: MachineCredential | null) => void>();
    const sync = {
      remote:
        options.syncing === false
          ? undefined
          : { host: "sync.example.com", device, client: client(device.id) },
      syncPass: async () => {},
      configure: async () => {},
    } as unknown as SyncController;
    let supervisor: AgentSupervisor | undefined;
    const runtime = new LeasedAgentRuntime({
      mode: "mock",
      settings,
      problem: "Checking…",
      createStack: async () => ({ runtime: new FakeAgentRuntime(), execution: null }),
      statusExtras: () => (supervisor ? { placement: supervisor.status() } : {}),
      logger: silentLogger,
    });
    const statuses: AgentStatusResponse[] = [];
    runtime.on("status", (status) => statuses.push(status));
    supervisor = new AgentSupervisor({
      runtime,
      sync,
      device: deviceSettings.device,
      agentMode: "mock",
      placement: deviceSettings,
      settings: {
        get: () => settings,
        onChange: (listener) => {
          settingsListeners.add(listener);
          return () => settingsListeners.delete(listener);
        },
      },
      credential: {
        current: () => credential,
        onChange: (listener) => {
          credentialListeners.add(listener);
          return () => credentialListeners.delete(listener);
        },
      },
      leaseTimings: TIMINGS,
      logger: silentLogger,
    });
    running.push(supervisor);
    return {
      supervisor,
      runtime,
      statuses,
      deviceSettings,
      setMachine(machine: AlwaysOnMachine | null) {
        settings = mergeSettings(settings, { remote: { alwaysOnMachine: machine } });
        for (const listener of settingsListeners) listener(settings);
      },
      setCredential(next: MachineCredential | null) {
        credential = next;
        for (const listener of credentialListeners) listener(next);
      },
    };
  }

  it("runs a standalone agent without sync, held here", async () => {
    const { supervisor, runtime } = setup({ syncing: false });
    await supervisor.start();
    expect(runtime.active).toBe(true);
    expect(supervisor.status()).toEqual({
      placement: "this_device",
      heldHere: "no_sync",
      runsOn: { deviceId: "dev_laptop", name: "Laptop", thisDevice: true, alwaysOnMachine: false },
      relay: "off",
    });
  });

  it("says it's taking over from the always-on machine, then runs the agent", async () => {
    const vm = client("dev_vm");
    const grant = await vm.acquireLease("agent", {
      deviceName: "vm-1",
      session: "s_vm",
      ttlMs: 60_000,
      priority: "host",
    });
    expect(grant.granted).toBe(true);
    const { supervisor, runtime, statuses } = setup();
    await supervisor.start();
    await vi.waitFor(() =>
      expect(supervisor.status()).toEqual({
        placement: "this_device",
        runsOn: { deviceId: "dev_vm", name: "vm-1", thisDevice: false, alwaysOnMachine: true },
        relay: "off",
        note: "Taking over from vm-1…",
      }),
    );
    expect(runtime.status().problem).toBe("The agent is running on vm-1.");
    expect(statuses.at(-1)?.placement?.note).toBe("Taking over from vm-1…");

    await vm.releaseLease("agent", "s_vm");
    await vi.waitFor(() => expect(runtime.active).toBe(true));
    expect(supervisor.status()).toEqual({
      placement: "this_device",
      runsOn: { deviceId: "dev_laptop", name: "Laptop", thisDevice: true, alwaysOnMachine: false },
      relay: "off",
    });
    expect(statuses.at(-1)?.placement?.note).toBeUndefined();
  });

  it("hands the agent to the always-on machine, and watches it pick it up", async () => {
    const { supervisor, runtime, statuses, deviceSettings, setCredential } = setup();
    await supervisor.start();
    await vi.waitFor(() => expect(runtime.active).toBe(true));
    const changes: string[] = [];
    supervisor.onChange((snapshot) => changes.push(snapshot.effective));

    await deviceSettings.patch({ placement: "always_on_machine" });
    await vi.waitFor(() => expect(runtime.active).toBe(false));
    expect(server.store.leaseHolder(vault.id, "agent")).toBeNull();
    await vi.waitFor(() =>
      expect(supervisor.status()).toMatchObject({
        placement: "always_on_machine",
        runsOn: null,
        relay: "not_paired",
        note: "Handing the agent to vm-1…",
      }),
    );
    expect(supervisor.current()).toMatchObject({ effective: "always_on_machine" });
    expect(changes).toContain("always_on_machine");
    expect(runtime.status().problem).toMatch(/always-on machine \(vm-1\)/);

    const vm = client("dev_vm");
    await vm.acquireLease("agent", {
      deviceName: "vm-1",
      session: "s_vm",
      ttlMs: 60_000,
      priority: "host",
    });
    await vi.waitFor(() =>
      expect(supervisor.status()).toEqual({
        placement: "always_on_machine",
        runsOn: { deviceId: "dev_vm", name: "vm-1", thisDevice: false, alwaysOnMachine: true },
        relay: "not_paired",
      }),
    );
    expect(runtime.status().problem).toBe("The agent is running on vm-1.");

    setCredential({ url: MACHINE.url, token: "x".repeat(43) });
    expect(supervisor.status().relay).toBe("off");
    supervisor.setRelay("connected");
    expect(supervisor.status().relay).toBe("connected");
    expect(statuses.at(-1)?.placement?.relay).toBe("connected");
  });

  it("holds the agent here until the vault has an always-on machine", async () => {
    const { supervisor, runtime, deviceSettings, setMachine } = setup({ machine: null });
    await deviceSettings.patch({ placement: "always_on_machine" });
    await supervisor.start();
    await vi.waitFor(() => expect(runtime.active).toBe(true));
    expect(supervisor.status()).toMatchObject({
      placement: "always_on_machine",
      heldHere: "no_machine",
      runsOn: { thisDevice: true },
    });

    setMachine(MACHINE);
    await vi.waitFor(() => expect(runtime.active).toBe(false));
    expect(supervisor.status().heldHere).toBeUndefined();
    expect(server.store.leaseHolder(vault.id, "agent")).toBeNull();

    setMachine(null);
    await vi.waitFor(() => expect(runtime.active).toBe(true));
    expect(supervisor.status().heldHere).toBe("no_machine");
  });

  it("changes the lease's priority without letting go of it", async () => {
    const { supervisor, runtime, deviceSettings } = setup();
    await supervisor.start();
    await vi.waitFor(() => expect(runtime.active).toBe(true));
    const epoch = server.store.leaseHolder(vault.id, "agent")?.epoch;
    await deviceSettings.patch({ placement: "always_on_host" });
    await vi.waitFor(() =>
      expect(server.store.leaseHolder(vault.id, "agent")).toMatchObject({
        priority: "host",
        epoch,
      }),
    );
    // The sync service records the new priority before the supervisor has read the answer.
    await vi.waitFor(() =>
      expect(supervisor.status().runsOn).toMatchObject({ thisDevice: true, alwaysOnMachine: true }),
    );
    expect(runtime.active).toBe(true);
  });
});
