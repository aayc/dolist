/**
 * Subcommands of the daemon's entry point for a headless machine (the always-on VM), run as the
 * daemon's user: `pair` prints a pairing code, `devices` lists paired devices, `revoke` revokes
 * one. They read `daemon-token` and call the running daemon on 127.0.0.1; they never print it.
 */
import { readFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import {
  API_ROUTES,
  type ApiErrorBody,
  formatDate,
  formatPairingCode,
  normalizeDeviceName,
  type PairedDevice,
  type PairedDevicesResponse,
  type PairingCodeResponse,
  pluralize,
} from "@ddl/core";
import { ConfigError, type DaemonConfig, type LoadConfigOptions, loadConfig } from "./config";
import { displayPath } from "./home-paths";

const REQUEST_TIMEOUT_MS = 5_000;

export const CLI_USAGE = `Usage: node dist/main.js [command]

Without a command, starts the daemon. Commands talk to the daemon running on this machine and
must run as its user (e.g. sudo -u ddl -H node /opt/ddl/current/daemon/dist/main.js pair):

  pair [--name <device name>]   Print a pairing code for a new device (single use, 5 minutes)
  devices                       List the devices paired with this daemon
  revoke <device id>            Revoke a paired device; its connections close at once
  help                          Show this help
`;

export interface CliIo {
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  /** Where configuration is read from besides `env` (tests). */
  config?: Omit<LoadConfigOptions, "env">;
}

class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

/** Runs a subcommand; resolves with the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const [command, ...args] = argv;
    switch (command) {
      case "pair":
        await pair(args, io);
        return 0;
      case "devices":
        expectNoArguments(args);
        await listDevices(io);
        return 0;
      case "revoke":
        await revoke(args, io);
        return 0;
      case "help":
      case "--help":
      case "-h":
        io.stdout(CLI_USAGE);
        return 0;
      default:
        throw new CliError(`Unknown command "${command ?? ""}".\n\n${CLI_USAGE}`, 2);
    }
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`${error.message.trimEnd()}\n`);
      return error.exitCode;
    }
    throw error;
  }
}

async function pair(args: readonly string[], io: CliIo): Promise<void> {
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = arg === "--name" ? args[++i] : arg.startsWith("--name=") ? arg.slice(7) : null;
    if (value === null) throw new CliError(`Unexpected argument "${arg}".\n\n${CLI_USAGE}`, 2);
    const normalized = value === undefined ? null : normalizeDeviceName(value);
    if (normalized === null) {
      throw new CliError("--name takes a device name of 1 to 64 characters.", 2);
    }
    name = normalized;
  }
  const daemon = await connect(io);
  const issued = (await daemon.request(
    "POST",
    API_ROUTES.pairingCodes,
    name ? { name } : {},
    201,
  )) as PairingCodeResponse;
  const now = io.now?.() ?? Date.now();
  const minutes = Math.max(1, Math.round((issued.expiresAt - now) / 60_000));
  const lines = [
    `Pairing code: ${formatPairingCode(issued.code)}`,
    `Valid once, until ${formatDate(new Date(issued.expiresAt), "HH:mm")} (${pluralize(minutes, "minute")}).`,
  ];
  if (issued.url) {
    lines.push(
      `On the new device, open ${issued.url} (or enter it as the always-on machine's address) and type the code.`,
    );
  } else {
    lines.push(
      `This daemon has no remote hosts yet, so other devices can't reach it: add its tailnet name to remote.hosts in ${daemon.display(daemon.config.configPath)} (or DDL_REMOTE_HOSTS) and restart it.`,
    );
  }
  io.stdout(`${lines.join("\n")}\n`);
}

async function listDevices(io: CliIo): Promise<void> {
  const daemon = await connect(io);
  const { devices } = (await daemon.request(
    "GET",
    API_ROUTES.devices,
    undefined,
    200,
  )) as PairedDevicesResponse;
  if (devices.length === 0) {
    io.stdout("No devices are paired with this daemon.\n");
    return;
  }
  const rows = [
    ["NAME", "KIND", "PAIRED", "LAST SEEN", "ID"],
    ...devices.map((device: PairedDevice) => [
      device.name,
      device.kind,
      dateTime(device.createdAt),
      device.lastSeenAt === null ? "never" : dateTime(device.lastSeenAt),
      device.id,
    ]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  const text = rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
  io.stdout(`${text}\n`);
}

async function revoke(args: readonly string[], io: CliIo): Promise<void> {
  const [id, ...rest] = args;
  if (id === undefined || rest.length > 0) {
    throw new CliError(`revoke takes one device id (see \`devices\`).\n\n${CLI_USAGE}`, 2);
  }
  const daemon = await connect(io);
  await daemon.request("DELETE", API_ROUTES.pairedDevice(id), undefined, 204);
  io.stdout(`Revoked ${id}.\n`);
}

function expectNoArguments(args: readonly string[]): void {
  if (args.length > 0) throw new CliError(`Unexpected argument "${args[0]}".\n\n${CLI_USAGE}`, 2);
}

interface DaemonConnection {
  config: DaemonConfig;
  display(path: string): string;
  request(method: string, path: string, body: unknown, expected: number): Promise<unknown>;
}

async function connect(io: CliIo): Promise<DaemonConnection> {
  const homedir = io.config?.homedir ?? osHomedir();
  let config: DaemonConfig;
  try {
    config = loadConfig({ ...io.config, env: { ...io.env } });
  } catch (error) {
    if (error instanceof ConfigError) throw new CliError(error.message);
    throw error;
  }
  const display = (path: string) => displayPath(path, homedir);
  if (config.port === 0) {
    throw new CliError(
      "The daemon's port is configured as 0 (any free port), so it can't be found: set DDL_PORT to the port it listens on.",
    );
  }
  const token = await readToken(config.tokenPath, display);
  const base = `http://127.0.0.1:${config.port}`;
  const doFetch = io.fetch ?? fetch;
  return {
    config,
    display,
    async request(method, path, body, expected) {
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new CliError(
          `The daemon isn't answering on 127.0.0.1:${config.port}. Is it running (systemctl status ddl-daemon)?`,
        );
      }
      if (res.status === expected) return expected === 204 ? undefined : res.json();
      const error = (await res.json().catch(() => ({}))) as Partial<ApiErrorBody>;
      if (res.status === 401) {
        throw new CliError(
          `The daemon on 127.0.0.1:${config.port} refused the token in ${display(config.tokenPath)}: is this the daemon's user, and is it this daemon's port?`,
        );
      }
      throw new CliError(error.message ?? `The daemon answered HTTP ${res.status}.`);
    },
  };
}

async function readToken(path: string, display: (path: string) => string): Promise<string> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") {
      throw new CliError(
        `There is no daemon token at ${display(path)}: start the daemon first, and run this as its user (sudo -u <user> -H …).`,
      );
    }
    if (code === "EACCES") {
      throw new CliError(
        `Can't read ${display(path)}: run this as the daemon's user (sudo -u <user> -H …).`,
      );
    }
    throw error;
  }
  const token = content.trim();
  if (!token)
    throw new CliError(`${display(path)} is empty: restart the daemon to create a token.`);
  return token;
}

/** Local time (invariant: time is local). */
function dateTime(ms: number): string {
  return formatDate(new Date(ms), "YYYY-MM-DD HH:mm");
}
