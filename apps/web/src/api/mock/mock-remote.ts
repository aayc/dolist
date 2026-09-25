import {
  type AgentPlacement,
  type AgentPlacementStatus,
  type AgentReadiness,
  type AgentRunsOn,
  type AlwaysOnMachine,
  type AppSettings,
  type ComputerAccess,
  type DeviceSettingsPatch,
  type DeviceSettingsResponse,
  type DeviceSyncSetup,
  type DeviceSyncSetupRequest,
  defaultMachineName,
  isSecureServiceUrl,
  type MachinePairRequest,
  type MachineStatusResponse,
  normalizeDeviceName,
  normalizeMachineUrl,
  normalizePairingCode,
  normalizeRemoteHost,
  type PairedDevicesResponse,
  type PairingCodeRequest,
  type PairingCodeResponse,
  REMOTE_LIMITS,
  type RelayState,
  SYNC_ID_PATTERN,
  type SyncStatusResponse,
} from "@ddl/core";
import { readJson, STORAGE_KEYS, writeJson } from "../../lib/storage";
import { HttpError } from "../errors";
import type { MockPairing } from "./mock-pairing";

/**
 * Starting points for the mock daemon's device side, picked with `?mockRemote=`:
 * - `none` (default): no sync and no always-on machine, so the agent is held on this device;
 * - `no_machine`: syncs, no always-on machine;
 * - `ready`: syncs, paired with the always-on machine, the agent runs here;
 * - `relayed`: the agent runs on the always-on machine, relayed here;
 * - `unreachable` / `not_paired`: set to the always-on machine, which can't be used from here;
 * - `elsewhere`: another laptop set to run the agent got there first;
 * - `host`: this is the always-on machine;
 * - `locked`: like `ready`, with every device setting set by environment variables;
 * - `unready`: like `ready`, and this device can't run the agent well (fix-it hints).
 */
export const MOCK_REMOTE_SCENARIOS = [
  "none",
  "no_machine",
  "ready",
  "relayed",
  "unreachable",
  "not_paired",
  "elsewhere",
  "host",
  "locked",
  "unready",
] as const;
export type MockRemoteScenario = (typeof MOCK_REMOTE_SCENARIOS)[number];

export function parseMockRemoteScenario(
  value: string | null | undefined,
): MockRemoteScenario | null {
  return MOCK_REMOTE_SCENARIOS.find((scenario) => scenario === value) ?? null;
}

/** The mock always-on machine, as a laptop's settings name it. */
export const MOCK_MACHINE: AlwaysOnMachine = {
  name: "vm-1",
  url: "https://vm-1.tailnet-name.ts.net",
};
const MOCK_MACHINE_DEVICE_ID = "dev_vm_1";
const MOCK_SYNC: DeviceSyncSetup = {
  url: "https://vm-1.tailnet-name.ts.net:8443",
  vault: "vault_demo",
  hasToken: true,
};
const NO_SYNC: DeviceSyncSetup = { url: null, vault: null, hasToken: false };

/**
 * Pairing codes the mock machine refuses, and a machine address that never answers, so every
 * error message can be tried (in the demo and the e2e tests).
 */
export const MOCK_MACHINE_TRIGGERS = {
  rejectedCode: "XXXXXXXX",
  rateLimitedCode: "YYYYYYYY",
  offlineHost: "offline",
} as const;

type LockedField = DeviceSettingsResponse["lockedByEnv"][number];

const LOCKED_MESSAGES: Record<LockedField, string> = {
  placement: "DDL_AGENT_PLACEMENT sets where the agent runs on this device",
  remoteHosts: "DDL_REMOTE_HOSTS sets the names this daemon answers to",
  sync: "DDL_SYNC_URL, DDL_SYNC_VAULT or DDL_SYNC_TOKEN set the sync setup of this device",
};

interface MockDeviceState {
  device: { id: string; name: string };
  placement: AgentPlacement;
  remoteHosts: string[];
  sync: DeviceSyncSetup;
  /** When sync was set up (the mock's "last synced"). */
  syncSince: number | null;
  lockedByEnv: LockedField[];
  machine: { paired: boolean; reachable: boolean; checkedAt: number | null; error?: string };
  /** Another laptop holding the agent lease at the same priority (first come, first served). */
  otherHolder: { deviceId: string; name: string } | null;
  /** This device can't run the agent well (for the readiness hints). */
  unready: boolean;
}

function preset(scenario: MockRemoteScenario, now: number): MockDeviceState {
  const base: MockDeviceState = {
    device: { id: "dev_demo_macbook", name: "Demo MacBook" },
    placement: "this_device",
    remoteHosts: [],
    sync: NO_SYNC,
    syncSince: null,
    lockedByEnv: [],
    machine: { paired: false, reachable: true, checkedAt: null },
    otherHolder: null,
    unready: false,
  };
  const synced = { ...base, sync: MOCK_SYNC, syncSince: now - 40_000 };
  const paired = { ...synced, machine: { paired: true, reachable: true, checkedAt: now - 20_000 } };
  switch (scenario) {
    case "none":
      return base;
    case "no_machine":
      return synced;
    case "ready":
      return paired;
    case "relayed":
      return { ...paired, placement: "always_on_machine" };
    case "unreachable":
      return {
        ...paired,
        placement: "always_on_machine",
        machine: {
          paired: true,
          reachable: false,
          checkedAt: now - 20_000,
          error: "The machine didn't answer in 5 s",
        },
      };
    case "not_paired":
      return { ...synced, placement: "always_on_machine" };
    case "elsewhere":
      return { ...paired, otherHolder: { deviceId: "dev_work_laptop", name: "Work laptop" } };
    case "host":
      return {
        ...synced,
        device: { id: MOCK_MACHINE_DEVICE_ID, name: MOCK_MACHINE.name },
        placement: "always_on_host",
        remoteHosts: [new URL(MOCK_MACHINE.url).host],
      };
    case "locked":
      return { ...paired, lockedByEnv: ["placement", "remoteHosts", "sync"] };
    case "unready":
      return { ...paired, unready: true };
  }
}

/** Scenarios whose vault settings name the always-on machine. */
function hasMachine(scenario: MockRemoteScenario): boolean {
  return scenario !== "none" && scenario !== "no_machine";
}

const MACHINE_READINESS: AgentReadiness = {
  harness: { kind: "cursor", ready: true },
  modelCredential: true,
  browser: true,
  computer: "unsupported",
  connectors: { configured: 2, connected: 2 },
};

/** How long a handover takes at speed 1 (the daemon's takes about half a minute). */
const HANDING_OVER_MS = 1_200;
const TAKING_OVER_MS = 1_800;

export interface MockRemoteHost {
  settings(): AppSettings;
  /** Names the vault's always-on machine (a synced setting). */
  setMachine(machine: AlwaysOnMachine | null): void;
  computerAccess(): ComputerAccess | undefined;
  /** Where the agent runs changed (the client pushes `agent.status`). */
  statusChanged(): void;
  pairing: MockPairing;
  speed: number;
  persist: boolean;
}

function failure(status: number, error: string, message: string): HttpError {
  return new HttpError(status, message, { error, message });
}

/** A validation failure worded like the daemon's (zod's `prettifyError`). */
function invalid(message: string, path: string): HttpError {
  return failure(400, "invalid_request", `✖ ${message}\n  → at ${path}`);
}

/**
 * The daemon's device side, in the browser: device-local settings (placement, remote hosts, sync),
 * the always-on machine link, pairing codes and paired devices, and where the agent runs, with
 * handovers that take a moment like the real lease's.
 */
export class MockRemote {
  private readonly host: MockRemoteHost;
  private state: MockDeviceState;
  private runsOn: AgentRunsOn | null = null;
  private relay: RelayState = "off";
  private note: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(host: MockRemoteHost, scenario: MockRemoteScenario | null) {
    this.host = host;
    const stored =
      host.persist && scenario === null ? readJson<MockDeviceState>(STORAGE_KEYS.mockDevice) : null;
    this.state = stored ?? preset(scenario ?? "none", Date.now());
    if (scenario !== null) {
      host.setMachine(hasMachine(scenario) ? MOCK_MACHINE : null);
      this.save();
    }
    this.settle();
  }

  // ── Where the agent runs ───────────────────────────────────────────────

  private machine(): AlwaysOnMachine | null {
    return this.host.settings().remote.alwaysOnMachine;
  }

  private heldHere(): AgentPlacementStatus["heldHere"] {
    if (this.state.sync.url === null) return "no_sync";
    if (!this.machine()) return "no_machine";
    return undefined;
  }

  private effective(): AgentPlacement {
    return this.heldHere() ? "this_device" : this.state.placement;
  }

  private self(alwaysOnMachine: boolean): AgentRunsOn {
    const { id, name } = this.state.device;
    return { deviceId: id, name, thisDevice: true, alwaysOnMachine };
  }

  private machineHolder(): AgentRunsOn | null {
    const machine = this.machine();
    if (!machine || this.state.placement === "always_on_host") return null;
    return {
      deviceId: MOCK_MACHINE_DEVICE_ID,
      name: machine.name,
      thisDevice: false,
      alwaysOnMachine: true,
    };
  }

  private otherHolder(): AgentRunsOn | null {
    const other = this.state.otherHolder;
    return other ? { ...other, thisDevice: false, alwaysOnMachine: false } : null;
  }

  /** Who runs the agent and the relay state once nothing is moving. */
  private settle(): void {
    this.note = undefined;
    if (this.state.sync.url === null) {
      this.runsOn = this.self(false);
      this.relay = "off";
      return;
    }
    const effective = this.effective();
    if (effective === "always_on_machine") {
      const { paired, reachable } = this.state.machine;
      this.runsOn = this.otherHolder() ?? this.machineHolder();
      this.relay = !paired ? "not_paired" : reachable ? "connected" : "unreachable";
      return;
    }
    this.runsOn = this.otherHolder() ?? this.self(effective === "always_on_host");
    this.relay = "off";
  }

  /** Moves the agent like the lease would: a note while it's handed over, then the new holder. */
  private transition(from: AgentPlacement): void {
    clearTimeout(this.timer);
    const to = this.effective();
    const name = this.machine()?.name ?? "the always-on machine";
    const later = (ms: number) => {
      this.timer = setTimeout(() => {
        this.settle();
        this.host.statusChanged();
      }, ms / this.host.speed);
    };
    if (from !== to && to === "always_on_machine" && this.runsOn?.thisDevice) {
      this.note = `Handing the agent to ${name}…`;
      this.relay = "connecting";
      later(HANDING_OVER_MS);
    } else if (
      from === "always_on_machine" &&
      to !== "always_on_machine" &&
      this.runsOn?.alwaysOnMachine &&
      !this.state.otherHolder
    ) {
      this.note = `Taking over from ${name}…`;
      this.relay = "off";
      later(TAKING_OVER_MS);
    } else {
      this.settle();
    }
    this.host.statusChanged();
  }

  private update(mutate: () => void): void {
    const before = this.effective();
    mutate();
    this.save();
    this.transition(before);
  }

  private save(): void {
    if (this.host.persist) writeJson(STORAGE_KEYS.mockDevice, this.state);
  }

  /** The vault's settings changed (another device may have named or removed the machine). */
  settingsChanged(): void {
    this.update(() => {});
  }

  placementStatus(): AgentPlacementStatus {
    const heldHere = this.heldHere();
    return {
      placement: this.state.placement,
      ...(heldHere ? { heldHere } : {}),
      runsOn: this.runsOn,
      relay: this.relay,
      ...(this.note ? { note: this.note } : {}),
    };
  }

  readiness(): AgentReadiness {
    const harness = this.host.settings().agent.harness;
    if (this.state.unready) {
      return {
        harness: {
          kind: harness,
          ready: false,
          problem:
            harness === "cursor"
              ? "The Cursor CLI is not signed in. Run `agent login` in a terminal, then restart the daemon — or switch the agent harness back to Pi in Settings."
              : "OPENROUTER_API_KEY is not set on this machine.",
        },
        modelCredential: false,
        browser: false,
        computer: "needs_permissions",
        connectors: { configured: 3, connected: 1 },
      };
    }
    const access = this.host.computerAccess();
    return {
      harness: { kind: harness, ready: true },
      modelCredential: true,
      browser: true,
      computer: !access
        ? "unsupported"
        : access.accessibility && access.screenRecording
          ? "available"
          : "needs_permissions",
      connectors: { configured: 3, connected: 2 },
    };
  }

  /**
   * Why this device can't act on the agent right now (its routes answer 503 with it), worded like
   * the daemon's read-only fallback: the handover while it happens, who runs the agent, or the
   * always-on machine not running it. Only "can't be reached" is the relay's (S3).
   */
  problem(): string | undefined {
    const name = this.machine()?.name ?? "the always-on machine";
    if (this.runsOn?.thisDevice) return undefined;
    if (this.relay === "connecting") return this.note ?? `Handing the agent to ${name}…`;
    if (this.relay === "unreachable") return `The always-on machine (${name}) can't be reached.`;
    if (this.relay === "connected" && this.runsOn?.alwaysOnMachine) return undefined;
    if (!this.runsOn) {
      return this.machine()
        ? `The agent runs on the always-on machine (${name}), which isn't running it right now.`
        : undefined;
    }
    return `The agent is running on ${this.runsOn.name}.`;
  }

  // ── Device settings ────────────────────────────────────────────────────

  deviceResponse(): DeviceSettingsResponse {
    const { device, placement, remoteHosts, sync, lockedByEnv } = this.state;
    return { device, placement, remoteHosts, sync, lockedByEnv };
  }

  private assertUnlocked(field: LockedField): void {
    if (this.state.lockedByEnv.includes(field)) {
      throw failure(409, "locked_by_env", `${LOCKED_MESSAGES[field]}; change it there`);
    }
  }

  patchDevice(patch: DeviceSettingsPatch): DeviceSettingsResponse {
    const name = patch.name === undefined ? undefined : normalizeDeviceName(patch.name);
    if (name === null) throw invalid("Too big: expected string to have <=64 characters", "name");
    if (
      patch.placement !== undefined &&
      !["this_device", "always_on_machine", "always_on_host"].includes(patch.placement)
    ) {
      throw invalid("Invalid option", "placement");
    }
    const hosts = patch.remoteHosts?.map((host) => host.trim().toLowerCase());
    if (hosts) {
      if (hosts.length > REMOTE_LIMITS.remoteHosts) {
        throw invalid(
          `Too big: expected array to have <=${REMOTE_LIMITS.remoteHosts} items`,
          "remoteHosts",
        );
      }
      const bad = hosts.findIndex((host) => normalizeRemoteHost(host) !== host);
      if (bad !== -1) {
        throw invalid(
          "must be a DNS name with an optional :port (no scheme, path, IP address or loopback name)",
          `remoteHosts[${bad}]`,
        );
      }
      if (new Set(hosts).size !== hosts.length)
        throw invalid("must not repeat a host", "remoteHosts");
    }
    if (patch.placement !== undefined) this.assertUnlocked("placement");
    if (hosts) this.assertUnlocked("remoteHosts");
    this.update(() => {
      if (name) this.state.device = { ...this.state.device, name };
      if (patch.placement !== undefined) this.state.placement = patch.placement;
      if (hosts) this.state.remoteHosts = hosts;
    });
    return this.deviceResponse();
  }

  setupSync(request: DeviceSyncSetupRequest): DeviceSettingsResponse {
    this.assertUnlocked("sync");
    if (!isSecureServiceUrl(request.url)) {
      throw invalid("must use https (plain http only to loopback), no credentials", "url");
    }
    if (!SYNC_ID_PATTERN.test(request.vault)) {
      throw invalid("must be 1-64 characters of A-Z a-z 0-9 _ -", "vault");
    }
    const token = request.token?.trim();
    if (token !== undefined && (token === "" || /\s/.test(token))) {
      throw failure(400, "invalid_request", "token must be one line without spaces");
    }
    if (token === undefined && !this.state.sync.hasToken) {
      throw failure(400, "invalid_request", "No vault token is saved yet: include `token`");
    }
    this.update(() => {
      this.state.sync = { url: request.url, vault: request.vault, hasToken: true };
      this.state.syncSince = Date.now();
    });
    return this.deviceResponse();
  }

  removeSync(): DeviceSettingsResponse {
    this.assertUnlocked("sync");
    this.update(() => {
      this.state.sync = NO_SYNC;
      this.state.syncSince = null;
    });
    return this.deviceResponse();
  }

  syncStatus(): SyncStatusResponse {
    const { sync, syncSince, device } = this.state;
    if (sync.url === null) {
      return {
        state: "disabled",
        target: "none",
        lastSyncedAt: null,
        pendingChanges: 0,
        conflicts: [],
      };
    }
    return {
      state: "idle",
      target: "remote",
      lastSyncedAt: syncSince,
      pendingChanges: 0,
      conflicts: [],
      remoteHost: new URL(sync.url).host,
      deviceName: device.name,
    };
  }

  // ── Pairing other devices with this daemon ─────────────────────────────

  createPairingCode(request: PairingCodeRequest): PairingCodeResponse {
    const name = request.name === undefined ? undefined : normalizeDeviceName(request.name);
    if (name === null) throw invalid("Too big: expected string to have <=64 characters", "name");
    const issued = this.host.pairing.issue(name);
    const first = this.state.remoteHosts[0];
    return { ...issued, url: first === undefined ? null : `https://${first.replace(/:443$/, "")}` };
  }

  listDevices(current: string | null): PairedDevicesResponse {
    return {
      devices: this.host.pairing
        .list()
        .map((device) => (device.id === current ? { ...device, current: true } : device)),
    };
  }

  // ── The always-on machine ──────────────────────────────────────────────

  machineStatus(): MachineStatusResponse {
    const machine = this.machine();
    const { paired, reachable, checkedAt, error } = this.state.machine;
    if (!machine) return { machine: null, paired: false, reachable: null, checkedAt: null };
    const answered = paired && reachable && checkedAt !== null;
    return {
      machine,
      paired,
      reachable: checkedAt === null ? null : reachable,
      checkedAt,
      ...(answered
        ? {
            version: `mock-${__APP_VERSION__}`,
            agent: { runsOn: this.machineView(machine) },
            readiness: MACHINE_READINESS,
          }
        : {}),
      ...(error && !reachable ? { error } : {}),
    };
  }

  /** Who runs the agent, as the machine sees it (`thisDevice` is the machine itself). */
  private machineView(machine: AlwaysOnMachine): AgentRunsOn | null {
    const holder = this.runsOn;
    if (!holder) return null;
    if (holder.deviceId === MOCK_MACHINE_DEVICE_ID) {
      return { ...holder, name: machine.name, thisDevice: true };
    }
    return { ...holder, thisDevice: false };
  }

  pairMachine(request: MachinePairRequest): MachineStatusResponse {
    const url = normalizeMachineUrl(request.url);
    if (!url) {
      throw invalid(
        "must be https://<host>[:port] without path, query or credentials (plain http only to loopback)",
        "url",
      );
    }
    const code = normalizePairingCode(request.code);
    if (!code) throw invalid("must be the 8-character pairing code (XXXX-XXXX)", "code");
    const name =
      request.name === undefined ? defaultMachineName(url) : normalizeDeviceName(request.name);
    if (!name) throw invalid("Too big: expected string to have <=64 characters", "name");
    const { hostname } = new URL(url);
    if (hostname.split(".")[0] === MOCK_MACHINE_TRIGGERS.offlineHost) {
      throw failure(502, "machine_unreachable", `${hostname} didn't answer in 5 s`);
    }
    if (code === MOCK_MACHINE_TRIGGERS.rejectedCode) {
      throw failure(401, "pairing_rejected", "The machine rejected the pairing code");
    }
    if (code === MOCK_MACHINE_TRIGGERS.rateLimitedCode) {
      throw failure(429, "rate_limited", "Too many pairing attempts: try again in a minute");
    }
    this.update(() => {
      this.host.setMachine({ name, url });
      this.state.machine = { paired: true, reachable: true, checkedAt: Date.now() };
    });
    return this.machineStatus();
  }

  checkMachine(): MachineStatusResponse {
    if (this.machine()) {
      this.update(() => {
        this.state.machine = { ...this.state.machine, checkedAt: Date.now() };
      });
    }
    return this.machineStatus();
  }

  /** The machine stops (or starts) answering, as its next check finds. */
  setMachineReachable(reachable: boolean): void {
    this.update(() => {
      const { paired } = this.state.machine;
      this.state.machine = reachable
        ? { paired, reachable, checkedAt: Date.now() }
        : { paired, reachable, checkedAt: Date.now(), error: "The machine didn't answer in 5 s" };
    });
  }

  forgetMachine(): MachineStatusResponse {
    this.update(() => {
      this.state.machine = { paired: false, reachable: true, checkedAt: null };
    });
    return this.machineStatus();
  }
}
