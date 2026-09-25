import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConnectorToolSource } from "@ddl/connectors";
import {
  type AppSettings,
  createConsoleLogger,
  debounce,
  type Logger,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import { getRequestListener } from "@hono/node-server";
import { LEASE_CHECKING_PROBLEM, type LeaseTimings } from "./agent-lease";
import { AgentSupervisor } from "./agent-supervisor";
import { createApp } from "./app";
import { AttributedStorage } from "./attributed-storage";
import { type DaemonConfig, loadConfig, summarizeConfig } from "./config";
import { DeviceSettings, deviceSettingsFiles } from "./device-settings";
import { errorMessage } from "./errors";
import { secretFile } from "./home-files";
import { displayPath } from "./home-paths";
import { LeasedAgentRuntime } from "./leased-runtime";
import { MACHINE_TOKEN_FILE, MachineLink } from "./machine-link";
import { PairedDeviceStore } from "./paired-devices";
import { ReadinessMonitor, systemReadinessProbes } from "./readiness";
import type { LinkTimings } from "./relay/link";
import { AgentRelay } from "./relay/relay";
import { createRemoteHosts } from "./remote-hosts";
import { createSecurityPolicy } from "./security";
import { createSettingsStore, SETTINGS_PATH, type SettingsStore } from "./settings-store";
import { SyncController } from "./sync-controller";
import { loadOrCreateDevice } from "./sync-setup";
import { createSystemSettingsOpener } from "./system-settings";
import { loadOrCreateToken } from "./token";
import { DAEMON_VERSION } from "./version";
import {
  createAgentStack,
  createConnectors,
  createVaultStorage,
  resolveVaultSearch,
  settingsDefaults,
} from "./wiring";
import { WriteTracker } from "./write-tracker";
import { attachWebSocketHub, type WebSocketHub } from "./ws";

/**
 * Loopback only: agents can act on this machine. Other devices reach the daemon only through a
 * private-network proxy on this machine (`tailscale serve`), under a configured remote host.
 */
export const BIND_HOST = "127.0.0.1";
const HTTP_CLOSE_GRACE_MS = 2_000;
const SETTINGS_RELOAD_DEBOUNCE_MS = 100;

type FetchCallback = Parameters<typeof getRequestListener>[0];

export interface StartDaemonOptions {
  config?: DaemonConfig;
  /** Source of OPENROUTER_API_KEY etc. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  logger?: Logger;
  /** Agent lease timings (tests shorten them). */
  leaseTimings?: Partial<LeaseTimings>;
  /** The relay's link to the machine (tests shorten its backoff). */
  relayLinkTimings?: Partial<LinkTimings>;
}

export interface RunningDaemon {
  readonly url: string;
  readonly port: number;
  readonly config: DaemonConfig;
  close(): Promise<void>;
}

interface Resources {
  storage?: StorageProvider;
  connectors?: ConnectorToolSource;
  runtime?: LeasedAgentRuntime;
  readiness?: ReadinessMonitor;
  machine?: MachineLink;
  supervisor?: AgentSupervisor;
  relay?: AgentRelay;
  sync?: SyncController;
  server?: Server;
  hub?: WebSocketHub;
  devices?: PairedDeviceStore;
  unsubscribes: Unsubscribe[];
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<RunningDaemon> {
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfig({ env });
  const logger = options.logger ?? createConsoleLogger(config.logLevel);
  logger.info(`Daily Do List daemon ${DAEMON_VERSION}`, summarizeConfig(config));

  const resources: Resources = { unsubscribes: [] };
  try {
    const token = await loadOrCreateToken(config.tokenPath, logger);
    const devices = await PairedDeviceStore.open({
      path: config.pairedDevicesPath,
      logger: logger.child({ component: "pairing" }),
    });
    resources.devices = devices;
    const remoteHosts = createRemoteHosts(config.remoteHosts);
    const writes = new WriteTracker();

    const storage = await createVaultStorage(config, logger);
    resources.storage = storage;
    const settings = await createSettingsStore({
      storage,
      defaults: settingsDefaults(config),
      logger: logger.child({ component: "settings" }),
    });

    const connectors = await createConnectors(config, logger);
    resources.connectors = connectors;
    const device = await loadOrCreateDevice(config.devicePath, logger);
    const agentStorage = new AttributedStorage(storage, writes, { origin: "agent" });
    let supervisor: AgentSupervisor | undefined;
    // The real runtime exists only while this device runs the agent (see AgentSupervisor).
    const runtime = new LeasedAgentRuntime({
      mode: config.agentMode,
      settings: settings.get(),
      connectors,
      createStack: (current: AppSettings) =>
        createAgentStack({
          config,
          env,
          storage: agentStorage,
          settings: current,
          connectors,
          logger,
          leaseEpoch: () => supervisor?.heldEpoch ?? null,
        }),
      storage: agentStorage,
      problem: LEASE_CHECKING_PROBLEM,
      statusExtras: (status) => {
        const current = readiness.current(status);
        return {
          ...(supervisor ? { placement: supervisor.status() } : {}),
          ...(current ? { readiness: current } : {}),
        };
      },
      logger: logger.child({ component: "agent" }),
    });
    resources.runtime = runtime;
    const readiness = new ReadinessMonitor({
      mode: config.agentMode,
      harness: () => settings.get().agent.harness,
      connectors,
      probes: systemReadinessProbes({ env, execution: config.execution }),
      onChange: () => runtime.refreshStatus(),
      logger: logger.child({ component: "readiness" }),
    });
    resources.readiness = readiness;

    const sync = new SyncController({
      primary: new AttributedStorage(storage, writes, { origin: "sync" }),
      device,
      syncTokenPath: config.syncTokenPath,
      env,
      leaseEpoch: () => supervisor?.heldEpoch ?? null,
      logger,
    });
    resources.sync = sync;
    await sync.configure(config.sync);
    const deviceSettings = new DeviceSettings({
      device,
      placement: config.placement,
      sync: config.sync,
      lockedByEnv: config.lockedByEnv,
      remoteHosts,
      files: deviceSettingsFiles(config),
      hasToken:
        Boolean(env.DDL_SYNC_TOKEN?.trim()) ||
        (await secretFile(config.syncTokenPath).read()) !== null,
      applySync: (next) => supervisor?.applySync(next) ?? Promise.resolve(),
      logger: logger.child({ component: "device" }),
    });
    const machine = await MachineLink.load({
      settings,
      credentialFile: secretFile(join(config.home, MACHINE_TOKEN_FILE)),
      deviceName: () => device.name,
      logger: logger.child({ component: "machine" }),
    });
    resources.machine = machine;
    supervisor = new AgentSupervisor({
      runtime,
      sync,
      device,
      agentMode: config.agentMode,
      placement: deviceSettings,
      settings,
      credential: machine,
      ...(options.leaseTimings ? { leaseTimings: options.leaseTimings } : {}),
      logger,
    });
    resources.supervisor = supervisor;
    resources.unsubscribes.push(followSyncedSettings(storage, settings, runtime, logger));
    await supervisor.start();
    // Clients talk to the relay; the supervisor drives the leased runtime underneath it.
    const relay = new AgentRelay({
      local: runtime,
      placement: supervisor,
      machine,
      logger: logger.child({ component: "relay" }),
      ...(options.relayLinkTimings ? { linkTimings: options.relayLinkTimings } : {}),
    });
    resources.relay = relay;

    // The app is built after listen() because the bound port is part of the Host/Origin allowlist.
    let handler: FetchCallback = () => new Response("Starting", { status: 503 });
    const server = createServer(getRequestListener((request, env) => handler(request, env)));
    resources.server = server;
    const port = await listen(server, config.port);
    const app = createApp({
      storage,
      runtime: relay,
      settings,
      config: { port, allowedOrigins: config.allowedOrigins },
      token,
      remoteHosts,
      devices,
      logger: logger.child({ component: "http" }),
      webDist: config.webDist,
      connectors,
      writes,
      search: resolveVaultSearch(storage),
      syncStatus: () => sync.status(),
      device: deviceSettings,
      machine,
      systemSettings: createSystemSettingsOpener(),
      relay,
    });
    handler = app.fetch;

    resources.hub = attachWebSocketHub({
      server,
      policy: createSecurityPolicy({
        port,
        token,
        extraOrigins: config.allowedOrigins,
        remoteHosts,
        devices,
      }),
      devices,
      storage,
      runtime: relay,
      settings,
      writes,
      logger: logger.child({ component: "ws" }),
    });

    try {
      await relay.start();
    } catch (error) {
      logger.error("The agent runtime failed to start; notes remain available", {
        error: errorMessage(error),
      });
    }
    void readiness.refresh();

    const url = `http://${BIND_HOST}:${port}`;
    logger.info("Listening", { url, vault: displayPath(config.vaultPath, homedir()) });
    let closing: Promise<void> | undefined;
    return {
      url,
      port,
      config,
      close: () => {
        closing ??= shutdown(resources, logger);
        return closing;
      },
    };
  } catch (error) {
    await shutdown(resources, logger);
    throw error;
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`Port ${port} is already in use. Is another daemon running? Set DDL_PORT.`)
          : error,
      );
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host: BIND_HOST });
  });
}

/** Stops everything that was started, in dependency order. Each step is isolated. */
async function shutdown(resources: Resources, logger: Logger): Promise<void> {
  const step = async (name: string, fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      logger.warn(`Shutdown step failed: ${name}`, { error: errorMessage(error) });
    }
  };
  for (const unsubscribe of resources.unsubscribes) unsubscribe();
  resources.readiness?.stop();
  resources.machine?.dispose();
  const { supervisor, relay, runtime, sync, hub, server, devices, connectors, storage } = resources;
  if (supervisor) await step("agent lease", () => supervisor.stop());
  // The relay stops the leased runtime under it.
  if (relay) await step("agent relay", () => relay.stop());
  else if (runtime) await step("agent runtime", () => runtime.stop());
  if (sync) await step("sync", () => sync.stop());
  if (hub) await step("websockets", () => hub.close());
  if (server) await step("http", () => closeServer(server));
  if (devices) await step("paired devices", () => devices.flush());
  if (connectors) await step("connectors", () => connectors.dispose());
  if (storage) await step("storage", () => storage.dispose());
}

/**
 * Settings changed on another device arrive through sync: reload them so the agent, the clients
 * (`settings.changed`) and the placement (the vault's always-on machine) follow at once. The
 * store's own writes reload to what it already has, which changes nothing.
 */
function followSyncedSettings(
  storage: StorageProvider,
  settings: SettingsStore,
  runtime: LeasedAgentRuntime,
  logger: Logger,
): Unsubscribe {
  const reload = debounce(() => {
    settings.reload().then(
      (next) => {
        if (next) runtime.updateSettings(next);
      },
      (error: unknown) => {
        logger.warn("Could not reload settings synced from another device", {
          error: errorMessage(error),
        });
      },
    );
  }, SETTINGS_RELOAD_DEBOUNCE_MS);
  const unwatch = storage.watch((event) => {
    if (event.path === SETTINGS_PATH) reload();
  });
  return () => {
    unwatch();
    reload.cancel();
  };
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const force = setTimeout(() => server.closeAllConnections(), HTTP_CLOSE_GRACE_MS);
    server.close((error) => {
      clearTimeout(force);
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}
