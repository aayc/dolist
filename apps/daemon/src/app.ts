import type { AgentRuntime } from "@ddl/agent";
import type { ConnectorToolSource } from "@ddl/connectors";
import { WIRE_LIMITS } from "@ddl/contract";
import type { Logger, SyncStatusResponse } from "@ddl/core";
import { type StorageProvider, searchVault } from "@ddl/storage";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getPath } from "hono/utils/url";
import type { DaemonConfig } from "./config";
import type { AppContext } from "./context";
import { type DeviceSettings, memoryDeviceSettings } from "./device-settings";
import { createErrorHandler, errorBody } from "./errors";
import { memorySecretFile } from "./home-files";
import { MachineLink } from "./machine-link";
import { PairedDeviceStore } from "./paired-devices";
import { PairingCodes } from "./pairing";
import { createRemoteHosts, type RemoteHosts } from "./remote-hosts";
import { registerAgentRoutes } from "./routes/agent";
import { registerArtifactRoutes } from "./routes/artifacts";
import { registerComputerRoutes } from "./routes/computer";
import { registerDailyRoutes } from "./routes/daily";
import { registerDeviceRoutes } from "./routes/device";
import { registerMachineRoutes } from "./routes/machine";
import { registerNoteRoutes } from "./routes/notes";
import { registerPairingRoutes } from "./routes/pairing";
import { registerRoutineRoutes } from "./routes/routines";
import { registerSettingsRoutes } from "./routes/settings";
import { disabledSyncStatusResponse, registerSyncRoutes } from "./routes/sync";
import { registerVaultRoutes } from "./routes/vault";
import { registerWebRoutes } from "./routes/web";
import type { VaultSearch } from "./search";
import { createSecurityPolicy, isApiPath, requestGuard, securityHeaders } from "./security";
import type { SettingsStore } from "./settings-store";
import { NO_SYSTEM_SETTINGS, type SystemSettingsOpener } from "./system-settings";
import { DAEMON_VERSION } from "./version";
import { WriteTracker } from "./write-tracker";

export const MAX_BODY_BYTES = WIRE_LIMITS.bodyBytes;

export interface AppDeps {
  storage: StorageProvider;
  runtime: AgentRuntime;
  settings: SettingsStore;
  /** `port` must be the port actually listened on (it is part of the Host/Origin allowlists). */
  config: Pick<DaemonConfig, "port" | "allowedOrigins">;
  token: string;
  /** Shared with the WebSocket hub's policy. Default: none (loopback only). */
  remoteHosts?: RemoteHosts;
  /** Shared with the WebSocket hub's policy. Default: in memory. */
  devices?: PairedDeviceStore;
  pairing?: PairingCodes;
  logger: Logger;
  /** Built web UI directory; `null` or omitted disables static serving. */
  webDist?: string | null;
  connectors?: Pick<ConnectorToolSource, "status">;
  /** Shared with the WebSocket hub so it can attribute changes to the client that made them. */
  writes?: WriteTracker;
  search?: VaultSearch;
  /** The sync engine's status; absent = sync is off. */
  syncStatus?: () => SyncStatusResponse;
  /** Device-local settings. Default: kept in memory (tests). */
  device?: DeviceSettings;
  /** The always-on machine link. Default: its credential kept in memory (tests). */
  machine?: MachineLink;
  /** Opens System Settings for computer use permissions. Default: opens nothing (tests). */
  systemSettings?: SystemSettingsOpener;
  now?: () => Date;
  version?: string;
}

export function createApp(deps: AppDeps): Hono {
  const remoteHosts = deps.remoteHosts ?? createRemoteHosts();
  const devices = deps.devices ?? new PairedDeviceStore({ path: null, logger: deps.logger });
  const device = deps.device ?? memoryDeviceSettings({ remoteHosts });
  const ctx: AppContext = {
    storage: deps.storage,
    runtime: deps.runtime,
    settings: deps.settings,
    policy: createSecurityPolicy({
      port: deps.config.port,
      token: deps.token,
      extraOrigins: deps.config.allowedOrigins,
      remoteHosts,
      devices,
    }),
    remoteHosts,
    devices,
    pairing: deps.pairing ?? new PairingCodes(),
    token: deps.token,
    logger: deps.logger,
    webDist: deps.webDist ?? null,
    connectors: deps.connectors,
    writes: deps.writes ?? new WriteTracker(),
    search: deps.search ?? ((query, limit) => searchVault(deps.storage, query, { limit })),
    syncStatus: deps.syncStatus ?? disabledSyncStatusResponse,
    device,
    machine:
      deps.machine ??
      new MachineLink({
        settings: deps.settings,
        credentialFile: memorySecretFile(),
        deviceName: () => device.device.name,
        logger: deps.logger,
      }),
    systemSettings: deps.systemSettings ?? NO_SYSTEM_SETTINGS,
    now: deps.now ?? (() => new Date()),
    version: deps.version ?? DAEMON_VERSION,
  };

  const app = new Hono({ getPath: routingPath });
  app.onError(createErrorHandler(ctx.logger));
  app.notFound((c) =>
    isApiPath(c.req.path)
      ? c.json(errorBody("not_found", "Unknown API route"), 404)
      : c.text("Not found", 404),
  );

  app.use("*", securityHeaders());
  app.use("*", requestGuard(ctx.policy));
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json(errorBody("payload_too_large", "Request body exceeds 5 MB"), 413),
    }),
  );
  app.use("/api/*", requestLogger(ctx.logger));

  registerVaultRoutes(app, ctx);
  registerNoteRoutes(app, ctx);
  registerDailyRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerRoutineRoutes(app, ctx);
  registerArtifactRoutes(app, ctx);
  registerSyncRoutes(app, ctx);
  registerDeviceRoutes(app, ctx);
  registerMachineRoutes(app, ctx);
  registerComputerRoutes(app, ctx);
  registerPairingRoutes(app, ctx);
  app.all("/api/*", (c) => c.json(errorBody("not_found", "Unknown API route"), 404));
  app.all("/ws", (c) => c.json(errorBody("upgrade_required", "Use a WebSocket upgrade"), 426));
  registerWebRoutes(app, ctx);
  return app;
}

/**
 * Hono routes on the percent-decoded path, and its wildcard patterns do not match line
 * terminators, so a path like `/api/notes/a%0Ab.md` would skip every route and middleware.
 * Re-escaping them keeps such requests on the normal path (guarded, then rejected by validation).
 */
function routingPath(request: Request): string {
  const path = getPath(request);
  let out = "";
  for (const ch of path) {
    const code = ch.charCodeAt(0);
    out +=
      code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029
        ? encodeURIComponent(ch)
        : ch;
  }
  return out;
}

function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    logger.debug("api", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  };
}
