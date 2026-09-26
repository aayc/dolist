import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { createConsoleLogger, errorMessage, type LogLevel } from "@ddl/core";
import {
  createSyncServer,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_RATE_LIMIT,
  type RunningSyncServer,
} from "./server";
import { SyncStore, type VaultInfo } from "./store";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface CliOptions {
  /** `serve` runs until this aborts. */
  signal?: AbortSignal;
  onListening?: (server: RunningSyncServer) => void;
}

const MIB = 1024 * 1024;
const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

const USAGE = `Daily Do List sync server

Usage:
  ddl-sync serve --db <file> [--host ${DEFAULT_HOST}] [--port ${DEFAULT_PORT}]
                 [--max-file-mb 5] [--max-vault-mb 1024]
                 [--rate ${DEFAULT_RATE_LIMIT.perSecond}] [--burst ${DEFAULT_RATE_LIMIT.burst}] [--log-level info]
  ddl-sync vault create --name <name> --db <file> [--json]
  ddl-sync vault list --db <file> [--json]
  ddl-sync vault rotate-token --vault <id> --db <file> [--json]

Vaults are administered here only, never over HTTP. A token is printed once, when it is created
or rotated. Serve on 127.0.0.1 (the default) and put a TLS-terminating proxy in front to reach
it from other devices; see docs/SYNC.md.
`;

class UsageError extends Error {}

/** Runs one command. Returns the process exit code. */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  options: CliOptions = {},
): Promise<number> {
  try {
    const [command, ...rest] = argv;
    switch (command) {
      case "serve":
        return await serve(rest, io, options);
      case "vault":
        return vault(rest, io);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.stdout(USAGE);
        return command === undefined ? 2 : 0;
      default:
        throw new UsageError(`Unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    io.stderr(`ddl-sync: ${errorMessage(error)}\n`);
    return 1;
  }
}

async function serve(argv: readonly string[], io: CliIo, options: CliOptions): Promise<number> {
  const { values } = parse(argv, {
    db: { type: "string" },
    host: { type: "string" },
    port: { type: "string" },
    "max-file-mb": { type: "string" },
    "max-vault-mb": { type: "string" },
    rate: { type: "string" },
    burst: { type: "string" },
    "log-level": { type: "string" },
  });
  const db = required(values.db, "--db");
  const host = values.host ?? DEFAULT_HOST;
  const logLevel = values["log-level"] ?? "info";
  const level = LOG_LEVELS.find((candidate) => candidate === logLevel);
  if (!level) throw new UsageError(`--log-level must be one of ${LOG_LEVELS.join(", ")}`);
  if (!LOOPBACK.has(host)) {
    io.stderr(
      `Warning: listening on ${host}. Tokens and notes travel in the clear unless a TLS-terminating proxy is in front.\n`,
    );
  }
  const server = await createSyncServer({
    db,
    host,
    port: integer(values.port, "--port", DEFAULT_PORT, 0, 65_535),
    maxFileBytes: integer(values["max-file-mb"], "--max-file-mb", 5, 1, 1024) * MIB,
    quotaBytes: integer(values["max-vault-mb"], "--max-vault-mb", 1024, 1, 1_048_576) * MIB,
    rateLimit: {
      perSecond: integer(values.rate, "--rate", DEFAULT_RATE_LIMIT.perSecond, 1, 100_000),
      burst: integer(values.burst, "--burst", DEFAULT_RATE_LIMIT.burst, 1, 1_000_000),
    },
    logger: createConsoleLogger(level, { component: "sync" }),
  });
  io.stdout(`ddl-sync listening on ${server.url}\n`);
  options.onListening?.(server);
  await new Promise<void>((resolve) => {
    if (!options.signal || options.signal.aborted) resolve();
    else options.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await server.close();
  return 0;
}

function vault(argv: readonly string[], io: CliIo): number {
  const [action, ...rest] = argv;
  const { values } = parse(rest, {
    db: { type: "string" },
    name: { type: "string" },
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  const db = required(values.db, "--db");
  if (action !== "create" && action !== "list" && action !== "rotate-token") {
    throw new UsageError(`Unknown vault command "${action ?? ""}"`);
  }
  const store = new SyncStore(db);
  try {
    if (action === "create") {
      const { vault: created, token } = store.createVault(required(values.name, "--name"));
      if (values.json) io.stdout(`${JSON.stringify({ vault: created.id, token })}\n`);
      else io.stdout(tokenNotice(`Created vault "${created.name}".`, created.id, token));
    } else if (action === "rotate-token") {
      const id = required(values.vault, "--vault");
      const token = store.rotateToken(id);
      if (values.json) io.stdout(`${JSON.stringify({ vault: id, token })}\n`);
      else io.stdout(tokenNotice("Rotated the token; the old one no longer works.", id, token));
    } else {
      const vaults = store.listVaults();
      io.stdout(values.json ? `${JSON.stringify(vaults)}\n` : formatVaults(vaults));
    }
  } finally {
    store.close();
  }
  return 0;
}

function tokenNotice(headline: string, id: string, token: string): string {
  return `${headline}

  Vault id: ${id}
  Token:    ${token}

The token is shown only this once. On each device, save it to ~/.daily-do-list/sync-token
(chmod 600) and add "sync": { "kind": "remote", "url": "<server url>", "vault": "${id}" } to
~/.daily-do-list/config.json.
`;
}

function formatVaults(vaults: readonly VaultInfo[]): string {
  if (vaults.length === 0) return "No vaults yet. Create one with: ddl-sync vault create\n";
  const lines = vaults.map(
    (v) =>
      `${v.id}  ${v.name}  files=${v.files}  bytes=${v.bytes}  changes=${v.lastSeq}  created=${new Date(v.createdAt).toISOString()}`,
  );
  return `${lines.join("\n")}\n`;
}

function parse<const T extends ParseArgsOptionsConfig>(argv: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...argv], options, strict: true, allowPositionals: false });
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
}

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new UsageError(`${flag} is required`);
  return value;
}

function integer(
  value: string | undefined,
  flag: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new UsageError(`${flag} must be an integer from ${min} to ${max}`);
  }
  return n;
}
