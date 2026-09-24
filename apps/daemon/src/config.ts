import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionConfig } from "@ddl/agent";
import { type AgentMode, DEFAULT_MODEL, type LogLevel } from "@ddl/core";
import type { SyncTargetConfig } from "@ddl/storage";
import { z } from "zod";
import { loadEnvFiles } from "./env-file";
import { displayPath, resolveUserPath } from "./home-paths";

export const DEFAULT_PORT = 7331;
export const CONFIG_FILE = "config.json";
export const MCP_CONFIG_FILE = "mcp.json";
export const TOKEN_FILE = "daemon-token";

const DEFAULT_HOME = "~/.daily-do-list";
const DEFAULT_VAULT = "~/DailyDoList";
/** Resolved from this module so it works both from `src/` (tsx) and the `dist/` bundle. */
const DEFAULT_WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));
const REPO_PACKAGE_NAME = "daily-do-list";

export interface DaemonConfig {
  /** DDL_HOME: machine-local state (token, config, MCP config, workspaces, browser profile). */
  home: string;
  vaultPath: string;
  /** The daemon always binds 127.0.0.1. `0` picks a free port. */
  port: number;
  agentMode: AgentMode;
  /** Default model for the LLM client and for `agent.model` unless the vault's settings override it. */
  model: string;
  sync: SyncTargetConfig;
  execution: ExecutionConfig;
  /** Extra browser origins allowed to call the API and WebSocket (e.g. a native shell). */
  allowedOrigins: string[];
  webDist: string;
  logLevel: LogLevel;
  configPath: string;
  mcpConfigPath: string;
  tokenPath: string;
  /** Env files that were read (paths only, never values). */
  envFiles: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const AGENT_MODES = ["live", "mock", "off"] as const satisfies readonly AgentMode[];
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const satisfies readonly LogLevel[];

const PathSchema = z.string().trim().min(1);

const SyncSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ kind: z.literal("local"), root: PathSchema }),
  z.strictObject({
    kind: z.literal("s3"),
    bucket: z.string().trim().min(1),
    prefix: z.string().optional(),
    region: z.string().optional(),
    endpoint: z.url().optional(),
    profile: z.string().optional(),
    forcePathStyle: z.boolean().optional(),
  }),
]);

const ExecutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("local"),
    browser: z
      .strictObject({
        headless: z.boolean().optional(),
        channel: z.enum(["chrome", "chromium", "msedge"]).optional(),
        executablePath: PathSchema.optional(),
      })
      .optional(),
    computer: z.strictObject({ enabled: z.boolean() }).optional(),
  }),
  z.strictObject({
    kind: z.literal("cloud"),
    endpoint: z.url(),
    apiKeyEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/, "must be the NAME of an environment variable, not the key"),
  }),
]);

const OriginSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((origin) => origin.replace(/\/+$/, ""))
  .pipe(
    z
      .string()
      .regex(
        /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+$/,
        "must be an origin such as http://localhost:5174",
      ),
  );

const ConfigFileSchema = z.strictObject({
  vaultPath: PathSchema.optional(),
  port: z.int().min(0).max(65535).optional(),
  agentMode: z.enum(AGENT_MODES).optional(),
  model: z.string().trim().min(1).optional(),
  sync: SyncSchema.optional(),
  execution: ExecutionSchema.optional(),
  allowedOrigins: z.array(OriginSchema).optional(),
  webDist: PathSchema.optional(),
  logLevel: z.enum(LOG_LEVELS).optional(),
});

type ConfigFile = z.output<typeof ConfigFileSchema>;

export interface LoadConfigOptions {
  /** Mutated: variables from env files are added to it. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  cwd?: string;
  homedir?: string;
  platform?: NodeJS.Platform;
}

/**
 * Resolves configuration with precedence env var > `$DDL_HOME/config.json` > defaults. Env files
 * (`$DDL_HOME/.env`, then `.env.local` in the working directory and at the repo root) fill in
 * variables that are not already set.
 */
export function loadConfig(options: LoadConfigOptions = {}): DaemonConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homedir = options.homedir ?? osHomedir();
  const platform = options.platform ?? process.platform;
  const fromCwd = { homedir, base: cwd };

  const home = resolveUserPath(nonEmpty(env.DDL_HOME) ?? DEFAULT_HOME, fromCwd);
  ensurePrivateDir(home, homedir);

  let envFiles: string[];
  try {
    envFiles = loadEnvFiles(envFileCandidates(home, cwd), env);
  } catch (error) {
    throw new ConfigError(`Could not read an env file: ${errorMessage(error)}`);
  }

  const configPath = join(home, CONFIG_FILE);
  const file = readConfigFile(configPath, homedir);
  const fromHome = { homedir, base: home };
  const vaultEnv = nonEmpty(env.DDL_VAULT);
  const webDistEnv = nonEmpty(env.DDL_WEB_DIST);

  return {
    home,
    vaultPath: vaultEnv
      ? resolveUserPath(vaultEnv, fromCwd)
      : resolveUserPath(file.vaultPath ?? DEFAULT_VAULT, fromHome),
    port: parsePortEnv(env.DDL_PORT) ?? file.port ?? DEFAULT_PORT,
    agentMode:
      parseEnumEnv("DDL_AGENT_MODE", env.DDL_AGENT_MODE, AGENT_MODES) ?? file.agentMode ?? "live",
    model: nonEmpty(env.DDL_MODEL) ?? file.model ?? DEFAULT_MODEL,
    sync: resolveSync(file.sync, fromHome),
    execution: resolveExecution(file.execution, home, platform, fromHome),
    allowedOrigins: file.allowedOrigins ?? [],
    webDist: webDistEnv
      ? resolveUserPath(webDistEnv, fromCwd)
      : file.webDist
        ? resolveUserPath(file.webDist, fromHome)
        : DEFAULT_WEB_DIST,
    logLevel:
      parseEnumEnv("DDL_LOG_LEVEL", env.DDL_LOG_LEVEL, LOG_LEVELS) ?? file.logLevel ?? "info",
    configPath,
    mcpConfigPath: join(home, MCP_CONFIG_FILE),
    tokenPath: join(home, TOKEN_FILE),
    envFiles,
  };
}

/** Loggable view of the configuration: no secrets, home-relative paths. */
export function summarizeConfig(
  config: DaemonConfig,
  homedir = osHomedir(),
): Record<string, unknown> {
  const { execution } = config;
  return {
    home: displayPath(config.home, homedir),
    vault: displayPath(config.vaultPath, homedir),
    port: config.port,
    agentMode: config.agentMode,
    model: config.model,
    sync: config.sync.kind,
    execution:
      execution.kind === "local"
        ? `local (browser ${execution.browser?.headless === false ? "headed" : "headless"}, computer use ${execution.computer?.enabled ? "on" : "off"})`
        : `cloud (${safeHost(execution.endpoint)})`,
    allowedOrigins: config.allowedOrigins,
    webDist: displayPath(config.webDist, homedir),
    envFiles: config.envFiles.map((path) => displayPath(path, homedir)),
  };
}

function readConfigFile(path: string, homedir: string): ConfigFile {
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(
      `${displayPath(path, homedir)} is not valid JSON: ${errorMessage(error)}`,
    );
  }
  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid ${displayPath(path, homedir)}:\n${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function resolveSync(
  sync: ConfigFile["sync"],
  paths: { homedir: string; base: string },
): SyncTargetConfig {
  if (!sync) return { kind: "none" };
  if (sync.kind === "local") return { kind: "local", root: resolveUserPath(sync.root, paths) };
  return sync;
}

function resolveExecution(
  execution: ConfigFile["execution"],
  home: string,
  platform: NodeJS.Platform,
  paths: { homedir: string; base: string },
): ExecutionConfig {
  if (execution?.kind === "cloud") return execution;
  const browser = { headless: true, ...execution?.browser };
  if (browser.executablePath)
    browser.executablePath = resolveUserPath(browser.executablePath, paths);
  return {
    kind: "local",
    home,
    browser,
    computer: execution?.computer ?? { enabled: platform === "darwin" },
  };
}

function envFileCandidates(home: string, cwd: string): string[] {
  const candidates = [join(home, ".env"), join(cwd, ".env.local")];
  const repoRoot = findRepoRoot(cwd);
  if (repoRoot) candidates.push(join(repoRoot, ".env.local"));
  return [...new Set(candidates)];
}

/** The Daily Do List checkout containing `start`, if any (never an unrelated monorepo). */
function findRepoRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return readPackageName(join(dir, "package.json")) === REPO_PACKAGE_NAME ? dir : undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readPackageName(path: string): string | undefined {
  try {
    const pkg: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof pkg === "object" && pkg !== null && "name" in pkg && typeof pkg.name === "string"
      ? pkg.name
      : undefined;
  } catch {
    return undefined;
  }
}

function ensurePrivateDir(path: string, homedir: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ConfigError(`Could not create ${displayPath(path, homedir)}: ${errorMessage(error)}`);
  }
}

function parsePortEnv(value: string | undefined): number | undefined {
  const raw = nonEmpty(value);
  if (raw === undefined) return undefined;
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port > 65535) {
    throw new ConfigError(`DDL_PORT must be an integer between 0 and 65535 (got "${raw}")`);
  }
  return port;
}

function parseEnumEnv<const T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  const raw = nonEmpty(value);
  if (raw === undefined) return undefined;
  const match = allowed.find((candidate) => candidate === raw.toLowerCase());
  if (!match) throw new ConfigError(`${name} must be one of ${allowed.join(", ")} (got "${raw}")`);
  return match;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid endpoint";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
