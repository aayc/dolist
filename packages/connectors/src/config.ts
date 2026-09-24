/**
 * Connector config: loading `mcp.json`, normalizing the accepted shapes and validating each server
 * strictly. One bad server never breaks the file: its problems travel with the entry and surface as
 * an `error` state in `status()`.
 *
 * Accepted file shapes (paste-compatible):
 *   { "mcpServers": { "<name>": { ... } } }          Claude Desktop, Cursor, Claude Code
 *   { "mcp": { "servers": { "<name>": { ... } } } }  OpenClaw, VS Code settings
 */
import { readFile } from "node:fs/promises";
import { type ConnectorStatus, truncate } from "@ddl/core";
import { ConnectorConfigError } from "./errors";
import type { ConnectorsConfig, McpServerConfig, McpToolFilter } from "./types";
import {
  defineOwn,
  errnoCode,
  errorMessage,
  isPlainObject,
  type PlainObject,
  stableStringify,
  typeName,
} from "./util";

export type ConnectorTransport = ConnectorStatus["transport"];
export type ApprovalPosture = NonNullable<McpServerConfig["approval"]>;

/** File name of the connectors config inside `$DDL_HOME`. */
export const CONNECTORS_CONFIG_FILE = "mcp.json";
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** `setTimeout` clamps larger delays to 1 ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export const EMPTY_CONNECTORS_CONFIG: ConnectorsConfig = Object.freeze({
  mcpServers: Object.freeze({}),
});

interface ServerSpecBase {
  readonly name: string;
  readonly enabled: boolean;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly toolFilter: McpToolFilter | undefined;
  readonly approval: ApprovalPosture;
  readonly description: string | undefined;
}

export interface StdioServerSpec extends ServerSpecBase {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | undefined;
}

export interface HttpServerSpec extends ServerSpecBase {
  readonly type: "http" | "sse";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** A validated server entry with defaults applied (placeholders are still unresolved). */
export type ServerSpec = StdioServerSpec | HttpServerSpec;

export type ParsedServerConfig =
  | { readonly ok: true; readonly spec: ServerSpec; readonly warnings: readonly string[] }
  | {
      readonly ok: false;
      readonly name: string;
      readonly transport: ConnectorTransport;
      readonly enabled: boolean;
      readonly error: string;
    };

const COMMON_KEYS = [
  "type",
  "enabled",
  "connectTimeoutMs",
  "requestTimeoutMs",
  "toolFilter",
  "approval",
  "description",
];
const STDIO_KEYS = ["command", "args", "env", "cwd"];
const HTTP_KEYS = ["url", "headers"];
/** Keys other MCP clients write into the same file; accepted with a warning so snippets paste as-is. */
const FOREIGN_KEYS = new Set([
  "autoApprove",
  "alwaysAllow",
  "disabledTools",
  "timeout",
  "$comment",
]);
const APPROVALS: readonly string[] = ["auto", "always", "writes"];
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Reads a connectors file. A missing or empty file is an empty config; unreadable files, invalid
 * JSON or a wrong top-level shape throw `ConnectorConfigError`. Server entries are normalized
 * (aliases, inferred `type`) but not rejected here: invalid ones are reported by the manager's
 * `status()` so they never take the other servers down.
 */
export async function loadConnectorsConfig(path: string): Promise<ConnectorsConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { mcpServers: {} };
    throw new ConnectorConfigError(
      `Cannot read connectors config ${path}: ${errorMessage(error)}`,
      undefined,
      { cause: error },
    );
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === "") return { mcpServers: {} };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    throw new ConnectorConfigError(
      `Connectors config ${path} is not valid JSON: ${errorMessage(error)}`,
      undefined,
      { cause: error },
    );
  }
  return normalizeConnectorsConfig(json, `Connectors config ${path}`);
}

/**
 * Accepts `{ mcpServers }` and/or `{ mcp: { servers } }` (merged; `mcpServers` wins on duplicate
 * names) and normalizes every entry.
 */
export function normalizeConnectorsConfig(
  input: unknown,
  source = "Connectors config",
): ConnectorsConfig {
  if (!isPlainObject(input)) {
    throw new ConnectorConfigError(`${source} must be a JSON object with an "mcpServers" object`);
  }
  const servers: PlainObject = {};
  if (input.mcp !== undefined) {
    const nested = input.mcp;
    if (
      !isPlainObject(nested) ||
      (nested.servers !== undefined && !isPlainObject(nested.servers))
    ) {
      throw new ConnectorConfigError(
        `${source}: "mcp.servers" must be an object mapping server names to server configs`,
      );
    }
    copyServers(servers, nested.servers);
  }
  if (input.mcpServers !== undefined) {
    if (!isPlainObject(input.mcpServers)) {
      throw new ConnectorConfigError(
        `${source}: "mcpServers" must be an object mapping server names to server configs`,
      );
    }
    copyServers(servers, input.mcpServers);
  }
  // Entries may still be invalid; `parseServerConfig` (run by the manager) reports them per server.
  return { mcpServers: servers as Record<string, McpServerConfig> };
}

function copyServers(target: PlainObject, source: unknown): void {
  if (!isPlainObject(source)) return;
  for (const [name, raw] of Object.entries(source))
    defineOwn(target, name, normalizeServerEntry(raw));
}

/**
 * Applies aliases used by other clients and infers `type`: `command` ⇒ `stdio`, `url` ⇒ `http`.
 * Returns non-objects unchanged so validation can report them.
 */
export function normalizeServerEntry(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const { transport, connectionTimeoutMs, disabled, ...rest } = raw;
  const entry: PlainObject = { ...rest };
  if (typeof entry.type === "string") entry.type = canonicalTransport(entry.type) ?? entry.type;
  // Aliases that agree with the canonical key are dropped; conflicting ones stay and fail validation.
  if (transport !== undefined) {
    const alias =
      typeof transport === "string" ? (canonicalTransport(transport) ?? transport) : transport;
    if (entry.type === undefined) entry.type = alias;
    else if (alias !== entry.type) entry.transport = transport;
  }
  if (entry.type === undefined) {
    if (entry.command !== undefined && entry.url === undefined) entry.type = "stdio";
    if (entry.url !== undefined && entry.command === undefined) entry.type = "http";
  }
  if (connectionTimeoutMs !== undefined) {
    if (entry.connectTimeoutMs === undefined) entry.connectTimeoutMs = connectionTimeoutMs;
    else if (connectionTimeoutMs !== entry.connectTimeoutMs) {
      entry.connectionTimeoutMs = connectionTimeoutMs;
    }
  }
  if (disabled !== undefined) {
    if (entry.enabled === undefined && typeof disabled === "boolean") entry.enabled = !disabled;
    else if (disabled !== !entry.enabled) entry.disabled = disabled;
  }
  return entry;
}

const ALIAS_CONFLICTS: Record<string, string> = {
  transport: '"transport" conflicts with "type"',
  connectionTimeoutMs: '"connectionTimeoutMs" conflicts with "connectTimeoutMs"',
  disabled: '"disabled" conflicts with "enabled"',
};

function canonicalTransport(value: string): ConnectorTransport | undefined {
  switch (
    value
      .trim()
      .toLowerCase()
      .replace(/[\s_-]/g, "")
  ) {
    case "stdio":
      return "stdio";
    case "http":
    case "streamablehttp":
      return "http";
    case "sse":
      return "sse";
    default:
      return undefined;
  }
}

/** Strictly validates one server entry and applies defaults. Never throws. */
export function parseServerConfig(name: string, raw: unknown): ParsedServerConfig {
  const entry = normalizeServerEntry(raw);
  const transport = guessTransport(entry);
  if (!isPlainObject(entry)) {
    return invalid(
      name,
      transport,
      true,
      `Server config must be an object (got ${typeName(entry)})`,
    );
  }
  const issues: string[] = [];
  if (name.trim() === "") issues.push("the server name must not be empty");
  const enabled = readBoolean(entry, "enabled", issues) ?? true;
  const common = {
    name,
    enabled,
    connectTimeoutMs: readTimeout(entry, "connectTimeoutMs", issues) ?? DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeoutMs: readTimeout(entry, "requestTimeoutMs", issues) ?? DEFAULT_REQUEST_TIMEOUT_MS,
    toolFilter: readToolFilter(entry, issues),
    approval: readApproval(entry, issues),
    description: readString(entry, "description", issues, true)?.trim() || undefined,
  };

  let spec: ServerSpec | undefined;
  const type = entry.type;
  if (type === "stdio") {
    rejectKeys(entry, HTTP_KEYS, type, issues);
    const command = readString(entry, "command", issues)?.trim();
    if (entry.command === undefined) issues.push('"command" is required for stdio servers');
    const args = readStringArray(entry, "args", issues) ?? [];
    const env = readStringRecord(entry, "env", issues, envNameProblem) ?? {};
    const cwd = readString(entry, "cwd", issues)?.trim();
    if (command !== undefined) spec = { ...common, type, command, args, env, cwd };
  } else if (type === "http" || type === "sse") {
    rejectKeys(entry, STDIO_KEYS, type, issues);
    const url = readString(entry, "url", issues)?.trim();
    if (entry.url === undefined) issues.push(`"url" is required for ${type} servers`);
    // URLs with placeholders are checked after interpolation, at connect time.
    const urlProblem = url !== undefined && !url.includes("$") ? httpUrlProblem(url) : undefined;
    if (urlProblem) issues.push(urlProblem);
    const headers = readStringRecord(entry, "headers", issues, headerNameProblem) ?? {};
    if (url !== undefined) spec = { ...common, type, url, headers };
  } else if (type === undefined) {
    issues.push(
      entry.command !== undefined && entry.url !== undefined
        ? 'has both "command" (stdio) and "url" (http/sse); keep one, or set "type"'
        : 'needs "command" (stdio server) or "url" (http/sse server)',
    );
  } else {
    const shown = typeof type === "string" ? ` (got "${truncate(type, 30)}")` : "";
    issues.push(`"type" must be "stdio", "http" or "sse"${shown}`);
  }

  const known = new Set([...COMMON_KEYS, ...(type === "stdio" ? STDIO_KEYS : HTTP_KEYS)]);
  const warnings: string[] = [];
  for (const key of Object.keys(entry)) {
    if (known.has(key) || STDIO_KEYS.includes(key) || HTTP_KEYS.includes(key)) continue;
    const conflict = Object.hasOwn(ALIAS_CONFLICTS, key) ? ALIAS_CONFLICTS[key] : undefined;
    if (conflict) issues.push(conflict);
    else if (FOREIGN_KEYS.has(key))
      warnings.push(`option "${key}" is not supported and is ignored`);
    else issues.push(`unknown option "${truncate(key, 40)}"`);
  }

  if (issues.length > 0 || spec === undefined) {
    return invalid(name, transport, enabled, `Invalid config: ${issues.join("; ")}`);
  }
  return { ok: true, spec, warnings };
}

/** Identity of everything that requires a new connection when it changes. */
export function launchFingerprint(spec: ServerSpec): string {
  return spec.type === "stdio"
    ? stableStringify({
        type: spec.type,
        command: spec.command,
        args: spec.args,
        env: spec.env,
        cwd: spec.cwd ?? null,
        connectTimeoutMs: spec.connectTimeoutMs,
      })
    : stableStringify({
        type: spec.type,
        url: spec.url,
        headers: spec.headers,
        connectTimeoutMs: spec.connectTimeoutMs,
      });
}

function invalid(
  name: string,
  transport: ConnectorTransport,
  enabled: boolean,
  error: string,
): ParsedServerConfig {
  return { ok: false, name, transport, enabled, error };
}

function guessTransport(entry: unknown): ConnectorTransport {
  if (!isPlainObject(entry)) return "stdio";
  if (entry.type === "stdio" || entry.type === "http" || entry.type === "sse") return entry.type;
  return entry.url !== undefined ? "http" : "stdio";
}

function rejectKeys(entry: PlainObject, keys: string[], type: string, issues: string[]): void {
  for (const key of keys) {
    if (entry[key] !== undefined) issues.push(`"${key}" is not valid for ${type} servers`);
  }
}

function readBoolean(entry: PlainObject, key: string, issues: string[]): boolean | undefined {
  const value = entry[key];
  if (value === undefined || typeof value === "boolean") return value;
  issues.push(`"${key}" must be true or false (got ${typeName(value)})`);
  return undefined;
}

function readString(
  entry: PlainObject,
  key: string,
  issues: string[],
  allowEmpty = false,
): string | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push(`"${key}" must be a string (got ${typeName(value)})`);
    return undefined;
  }
  if (!allowEmpty && value.trim() === "") {
    issues.push(`"${key}" must not be empty`);
    return undefined;
  }
  return value;
}

function readTimeout(entry: PlainObject, key: string, issues: string[]): number | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    issues.push(`"${key}" must be a positive number of milliseconds`);
    return undefined;
  }
  if (value > MAX_TIMEOUT_MS) {
    issues.push(`"${key}" must be at most ${MAX_TIMEOUT_MS} ms`);
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function readStringArray(entry: PlainObject, key: string, issues: string[]): string[] | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    issues.push(`"${key}" must be an array of strings (got ${typeName(value)})`);
    return undefined;
  }
  const items: unknown[] = value;
  const out: string[] = [];
  for (const [index, item] of items.entries()) {
    if (typeof item === "string") out.push(item);
    else issues.push(`"${key}[${index}]" must be a string (got ${typeName(item)})`);
  }
  return out;
}

function readStringRecord(
  entry: PlainObject,
  key: string,
  issues: string[],
  nameProblem: (name: string) => string | undefined,
): Record<string, string> | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    issues.push(`"${key}" must be an object of strings (got ${typeName(value)})`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    const problem = nameProblem(name);
    if (problem) issues.push(`"${key}" ${problem}`);
    else if (typeof item === "string") defineOwn(out, name, item);
    else issues.push(`"${key}.${truncate(name, 40)}" must be a string (got ${typeName(item)})`);
  }
  return out;
}

function envNameProblem(name: string): string | undefined {
  return name === "" || name.includes("=") || name.includes("\u0000")
    ? `has an invalid variable name "${truncate(name, 40)}"`
    : undefined;
}

function headerNameProblem(name: string): string | undefined {
  return HEADER_NAME_RE.test(name)
    ? undefined
    : `has an invalid header name "${truncate(name, 40)}"`;
}

function readApproval(entry: PlainObject, issues: string[]): ApprovalPosture {
  const value = entry.approval;
  if (value === undefined) return "auto";
  if (typeof value === "string" && APPROVALS.includes(value)) return value as ApprovalPosture;
  issues.push('"approval" must be "auto", "always" or "writes"');
  return "auto";
}

function readToolFilter(entry: PlainObject, issues: string[]): McpToolFilter | undefined {
  const value = entry.toolFilter;
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    issues.push('"toolFilter" must be an object with "include" and/or "exclude" arrays');
    return undefined;
  }
  // A misspelled key here would silently expose tools, so it is an error rather than a warning.
  for (const key of Object.keys(value)) {
    if (key !== "include" && key !== "exclude") {
      issues.push(`"toolFilter.${truncate(key, 40)}" is not supported (use "include"/"exclude")`);
    }
  }
  const include = readPatterns(value, "include", issues);
  const exclude = readPatterns(value, "exclude", issues);
  if (include.length === 0 && exclude.length === 0) return undefined;
  return {
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

function readPatterns(filter: PlainObject, key: string, issues: string[]): string[] {
  const value = filter[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`"toolFilter.${key}" must be an array of tool names`);
    return [];
  }
  const items: unknown[] = value;
  const out: string[] = [];
  for (const [index, item] of items.entries()) {
    if (typeof item === "string" && item.trim() !== "") out.push(item.trim());
    else issues.push(`"toolFilter.${key}[${index}]" must be a non-empty string`);
  }
  return out;
}

function httpUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '"url" is not a valid URL';
  }
  return url.protocol === "http:" || url.protocol === "https:"
    ? undefined
    : '"url" must start with http:// or https://';
}
