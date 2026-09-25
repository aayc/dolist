import type { AgentRuntime } from "@ddl/agent";
import type { ConnectorToolSource } from "@ddl/connectors";
import type { Logger, SyncStatusResponse } from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import type { DeviceSettings } from "./device-settings";
import type { MachineLink } from "./machine-link";
import type { PairedDeviceStore } from "./paired-devices";
import type { PairingCodes } from "./pairing";
import type { RemoteHosts } from "./remote-hosts";
import type { VaultSearch } from "./search";
import type { SecurityPolicy } from "./security";
import type { SettingsStore } from "./settings-store";
import type { SystemSettingsOpener } from "./system-settings";
import type { WriteTracker } from "./write-tracker";

/** Resolved dependencies shared by the route modules. */
export interface AppContext {
  storage: StorageProvider;
  runtime: AgentRuntime;
  settings: SettingsStore;
  policy: SecurityPolicy;
  /** The names this daemon answers to besides loopback; the policy reads it live. */
  remoteHosts: RemoteHosts;
  /** Devices paired with this daemon (their credentials count as bearer tokens). */
  devices: PairedDeviceStore;
  pairing: PairingCodes;
  token: string;
  logger: Logger;
  /** Built web UI directory, or null when static serving is disabled. */
  webDist: string | null;
  connectors: Pick<ConnectorToolSource, "status"> | undefined;
  writes: WriteTracker;
  search: VaultSearch;
  syncStatus: () => SyncStatusResponse;
  /** This device's name, placement, remote hosts and sync setup. */
  device: DeviceSettings;
  /** The always-on machine: pairing, checks, this device's credential. */
  machine: MachineLink;
  systemSettings: SystemSettingsOpener;
  now: () => Date;
  version: string;
}
