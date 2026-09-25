/**
 * What the daemon needs to sync with the sync service: this device's identity
 * (`$DDL_HOME/device.json`), the vault token (`$DDL_HOME/sync-token` or `DDL_SYNC_TOKEN`) and the
 * resulting sync target. The token is read here, handed to the provider and the lease client,
 * and never logged.
 */
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { createId, type Logger, SYNC_ID_PATTERN, SYNC_LIMITS } from "@ddl/core";
import { SyncServiceClient, type SyncTargetConfig } from "@ddl/storage";
import type { DaemonConfig } from "./config";

export interface DeviceIdentity {
  /** Random and stable: recorded on every change this device makes, and holds the agent lease. */
  id: string;
  /** Shown on other devices ("The agent is running on …"). Edit device.json to change it. */
  name: string;
}

export interface PreparedSync {
  /** The target for `createSync`, or null when sync is off or can't start (see `problem`). */
  target: SyncTargetConfig | null;
  /** Set when sync is configured with the sync service. */
  remote?: {
    host: string;
    device: DeviceIdentity;
    /** For the agent lease; absent without a token. */
    client?: SyncServiceClient;
    /** Why remote sync can't run (e.g. no token). */
    problem?: string;
  };
}

const MAX_TOKEN_LENGTH = 512;

/** Resolves the configured sync target, loading the device identity and token it needs. */
export async function prepareSync(options: {
  config: Pick<DaemonConfig, "sync" | "syncTokenPath" | "devicePath">;
  env: Record<string, string | undefined>;
  logger: Logger;
  hostname?: string;
}): Promise<PreparedSync> {
  const { config, env, logger } = options;
  const sync = config.sync;
  if (sync.kind !== "remote") return { target: sync };
  const device = await loadOrCreateDevice(config.devicePath, logger, options.hostname);
  const host = new URL(sync.url).host;
  const token = await loadSyncToken({ path: config.syncTokenPath, env, logger });
  if (!token) {
    const problem =
      "Sync with the sync server is set up, but there is no token: save the vault's token in ~/.daily-do-list/sync-token (chmod 600) or DDL_SYNC_TOKEN.";
    logger.error("Sync is off: no sync token", { host });
    return { target: null, remote: { host, device, problem } };
  }
  return {
    target: {
      kind: "remote",
      url: sync.url,
      vault: sync.vault,
      token,
      deviceId: device.id,
      deviceName: device.name,
    },
    remote: {
      host,
      device,
      client: new SyncServiceClient({
        url: sync.url,
        vault: sync.vault,
        token,
        deviceId: device.id,
        requestTimeoutMs: 10_000,
      }),
    },
  };
}

/** The vault token: `DDL_SYNC_TOKEN`, else the token file (tightened to 0600), else null. */
export async function loadSyncToken(options: {
  path: string;
  env: Record<string, string | undefined>;
  logger: Logger;
}): Promise<string | null> {
  const fromEnv = options.env.DDL_SYNC_TOKEN?.trim();
  if (fromEnv) return validToken(fromEnv, "DDL_SYNC_TOKEN");
  let content: string;
  try {
    content = await readFile(options.path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  if (process.platform !== "win32" && ((await stat(options.path)).mode & 0o077) !== 0) {
    await chmod(options.path, 0o600);
    options.logger.warn("The sync token file was readable by other users; restricted it to 0600");
  }
  const token = content.trim();
  return token ? validToken(token, "the sync token file") : null;
}

/** `$DDL_HOME/device.json`, created on first use with a random id and the machine's name. */
export async function loadOrCreateDevice(
  path: string,
  logger: Logger,
  hostname: string = osHostname(),
): Promise<DeviceIdentity> {
  let source: string | undefined;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
  let existing: unknown;
  if (source !== undefined) {
    try {
      existing = JSON.parse(source);
    } catch {
      existing = undefined;
    }
    const device = parseDevice(existing);
    if (device) return device;
    logger.warn("device.json is unreadable; giving this device a new id");
  }
  const created: DeviceIdentity = {
    id: createId("dev", 20),
    name: validName(nameOf(existing)) ?? defaultDeviceName(hostname),
  };
  const json = `${JSON.stringify(created, null, 2)}\n`;
  if (source !== undefined) {
    await writeFile(path, json);
    await chmod(path, 0o600);
    return created;
  }
  try {
    await writeFile(path, json, { mode: 0o600, flag: "wx" });
  } catch (error) {
    // Another start created it first: its identity wins.
    if (errnoCode(error) === "EEXIST") return loadOrCreateDevice(path, logger, hostname);
    throw error;
  }
  return created;
}

/** `Aarons-MacBook-Pro.local` → `Aarons-MacBook-Pro`. */
export function defaultDeviceName(hostname: string): string {
  return validName(hostname.split(".")[0] ?? "") ?? "This device";
}

function parseDevice(value: unknown): DeviceIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  const { id } = value as { id?: unknown };
  const name = validName(nameOf(value));
  if (typeof id !== "string" || !SYNC_ID_PATTERN.test(id) || !name) return null;
  return { id, name };
}

function nameOf(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as { name?: unknown }).name
    : undefined;
}

function validName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, SYNC_LIMITS.deviceNameLength)
    .trim();
  return name || undefined;
}

function validToken(token: string, source: string): string {
  if (token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    throw new Error(`${source} doesn't hold a sync token (one line, no spaces)`);
  }
  return token;
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
