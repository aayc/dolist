import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import type { AgentRuntime, ExecutionProvider } from "@ddl/agent";
import type { ConnectorToolSource } from "@ddl/connectors";
import { createConsoleLogger, type Logger, type Unsubscribe } from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "./app";
import { AttributedStorage } from "./attributed-storage";
import { type DaemonConfig, loadConfig, summarizeConfig } from "./config";
import { errorMessage } from "./errors";
import { displayPath } from "./home-paths";
import { createSecurityPolicy } from "./security";
import { createSettingsStore } from "./settings-store";
import { createSystemSettingsOpener } from "./system-settings";
import { loadOrCreateToken } from "./token";
import { DAEMON_VERSION } from "./version";
import {
  createAgentStack,
  createConnectors,
  createSync,
  createVaultStorage,
  resolveVaultSearch,
  type SyncHandle,
  settingsDefaults,
} from "./wiring";
import { WriteTracker } from "./write-tracker";
import { attachWebSocketHub, type WebSocketHub } from "./ws";

/** Loopback only: agents can act on this machine, so the daemon is never reachable remotely. */
export const BIND_HOST = "127.0.0.1";
const HTTP_CLOSE_GRACE_MS = 2_000;

type FetchCallback = Parameters<typeof getRequestListener>[0];

export interface StartDaemonOptions {
  config?: DaemonConfig;
  /** Source of OPENROUTER_API_KEY etc. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  logger?: Logger;
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
  execution?: ExecutionProvider | null;
  runtime?: AgentRuntime;
  sync?: SyncHandle | null;
  server?: Server;
  hub?: WebSocketHub;
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
    const agent = await createAgentStack({
      config,
      env,
      storage: new AttributedStorage(storage, writes, { origin: "agent" }),
      settings: settings.get(),
      connectors,
      logger,
    });
    resources.execution = agent.execution;
    resources.runtime = agent.runtime;

    const sync = await createSync({
      target: config.sync,
      primary: new AttributedStorage(storage, writes, { origin: "sync" }),
      logger,
    });
    resources.sync = sync;
    if (sync) {
      resources.unsubscribes.push(sync.engine.onStatus((status) => logSyncStatus(logger, status)));
      await sync.engine.start();
    }

    // The app is built after listen() because the bound port is part of the Host/Origin allowlist.
    let handler: FetchCallback = () => new Response("Starting", { status: 503 });
    const server = createServer(getRequestListener((request, env) => handler(request, env)));
    resources.server = server;
    const port = await listen(server, config.port);
    const app = createApp({
      storage,
      runtime: agent.runtime,
      settings,
      config: { port, allowedOrigins: config.allowedOrigins },
      token,
      logger: logger.child({ component: "http" }),
      webDist: config.webDist,
      connectors,
      writes,
      search: resolveVaultSearch(storage),
      systemSettings: createSystemSettingsOpener(),
    });
    handler = app.fetch;

    resources.hub = attachWebSocketHub({
      server,
      policy: createSecurityPolicy({ port, token, extraOrigins: config.allowedOrigins }),
      storage,
      runtime: agent.runtime,
      settings,
      writes,
      logger: logger.child({ component: "ws" }),
    });

    try {
      await agent.runtime.start();
    } catch (error) {
      logger.error("The agent runtime failed to start; notes remain available", {
        error: errorMessage(error),
      });
    }

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
  const { runtime, sync, hub, server, execution, connectors, storage } = resources;
  if (runtime) await step("agent runtime", () => runtime.stop());
  if (sync) {
    await step("sync", () => sync.engine.stop());
    await step("sync target", () => sync.target.dispose());
  }
  if (hub) await step("websockets", () => hub.close());
  if (server) await step("http", () => closeServer(server));
  if (execution) await step("execution", () => execution.dispose());
  if (connectors) await step("connectors", () => connectors.dispose());
  if (storage) await step("storage", () => storage.dispose());
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

function logSyncStatus(logger: Logger, status: { state: string; lastError?: string }): void {
  if (status.state === "error") logger.warn("Sync failed", { error: status.lastError });
  else logger.debug("Sync status", { state: status.state });
}
