/**
 * The connector manager: owns one `McpConnection` per enabled server and exposes their tools as
 * `ToolSpec`s. Servers connect lazily (all in parallel) on the first `getTools()`; a server that
 * fails is skipped and reported through `status()`, never thrown. `reload()` diffs per server:
 * unchanged servers keep their connection, policy-only edits (approval, filter, description,
 * request timeout) apply in place, launch changes reconnect, and removed servers are closed.
 */
import {
  type ConnectorStatus,
  type Logger,
  silentLogger,
  type ToolSpec,
  truncate,
  type Unsubscribe,
} from "@ddl/core";
import { createMcpToolSpec, type McpToolTarget } from "./adapter";
import {
  launchFingerprint,
  type ParsedServerConfig,
  parseServerConfig,
  type ServerSpec,
} from "./config";
import { McpConnection, type McpProgress, type RetryPolicy } from "./connection";
import { McpUnavailableError } from "./errors";
import { isToolAllowed } from "./filter";
import type { EnvSource } from "./launch";
import { assignToolNames, mcpToolName, toolRefKey } from "./names";
import { maskSecrets } from "./redact";
import type { McpToolDefinition } from "./tool-definition";
import {
  createTransportSource,
  type TransportSource,
  type TransportSourceOptions,
} from "./transports";
import type { ConnectorsConfig, ConnectorToolSource } from "./types";
import { compareStrings, errorMessage, isPlainObject, stableStringify } from "./util";

export { EMPTY_CONNECTORS_CONFIG, loadConnectorsConfig } from "./config";

export interface ConnectorManagerOptions {
  logger?: Logger;
  /** Environment for `${NAME}` placeholders, read at connect time. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Reconnect/backoff tuning. */
  retry?: Partial<RetryPolicy>;
}

export type TransportSourceFactory = (
  spec: ServerSpec,
  options: TransportSourceOptions,
) => TransportSource;

interface ServerEntry {
  readonly name: string;
  readonly parsed: ParsedServerConfig;
  /** Reload keeps the connection while this stays the same. */
  readonly key: string;
  readonly spec: ServerSpec | undefined;
  readonly connection: McpConnection | undefined;
}

const MAX_STATUS_ERROR_CHARS = 500;

export function createConnectorManager(
  config: ConnectorsConfig,
  options: ConnectorManagerOptions = {},
): ConnectorToolSource {
  return new ConnectorManager(config, options);
}

export class ConnectorManager implements ConnectorToolSource {
  private entries = new Map<string, ServerEntry>();
  private readonly listeners = new Set<(status: ConnectorStatus[]) => void>();
  private readonly logger: Logger;
  private readonly env: EnvSource;
  private readonly retry: Partial<RetryPolicy> | undefined;
  private readonly createSource: TransportSourceFactory;
  private started = false;
  private disposed = false;
  private generation = 0;
  private toolCache: { generation: number; tools: ToolSpec[] } | undefined;
  private emitQueued = false;
  private lastEmitted: string | undefined;
  private readonly renamed = new Set<string>();

  /** `createSource` is a seam for tests (in-memory servers); production uses real transports. */
  constructor(
    config: ConnectorsConfig,
    options: ConnectorManagerOptions = {},
    createSource: TransportSourceFactory = createTransportSource,
  ) {
    this.logger = options.logger ?? silentLogger;
    this.env = options.env ?? process.env;
    this.retry = options.retry;
    this.createSource = createSource;
    for (const [name, raw] of serversOf(config, this.logger)) {
      this.entries.set(name, this.createEntry(name, raw, parseServerConfig(name, raw)));
    }
  }

  async getTools(): Promise<ToolSpec[]> {
    if (this.disposed) return [];
    this.started = true;
    await Promise.all([...this.entries.values()].map((entry) => entry.connection?.ready()));
    if (this.disposed) return [];
    return this.buildTools();
  }

  status(): ConnectorStatus[] {
    return [...this.entries.values()].map((entry) => this.entryStatus(entry));
  }

  onStatus(listener: (status: ConnectorStatus[]) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async reload(config: ConnectorsConfig): Promise<void> {
    if (this.disposed) return;
    const next = new Map<string, ServerEntry>();
    const created: ServerEntry[] = [];
    const retired: McpConnection[] = [];
    for (const [name, raw] of serversOf(config, this.logger)) {
      const parsed = parseServerConfig(name, raw);
      const previous = this.entries.get(name);
      if (previous && previous.key === entryKey(parsed, raw)) {
        next.set(name, { ...previous, parsed, spec: parsed.ok ? parsed.spec : undefined });
        continue;
      }
      if (previous?.connection) retired.push(previous.connection);
      const entry = this.createEntry(name, raw, parsed);
      next.set(name, entry);
      created.push(entry);
    }
    for (const [name, previous] of this.entries) {
      if (!next.has(name) && previous.connection) retired.push(previous.connection);
    }
    this.entries = next;
    this.logger.info("connectors reloaded", {
      servers: next.size,
      restarted: created.length,
      closed: retired.length,
    });
    this.changed();
    await Promise.all(retired.map((connection) => connection.close()));
    if (this.started && !this.disposed) {
      for (const entry of created) void entry.connection?.ready();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const connections = [...this.entries.values()].flatMap((entry) =>
      entry.connection ? [entry.connection] : [],
    );
    this.entries = new Map();
    this.listeners.clear();
    this.toolCache = undefined;
    await Promise.all(connections.map((connection) => connection.close()));
  }

  private createEntry(name: string, raw: unknown, parsed: ParsedServerConfig): ServerEntry {
    const key = entryKey(parsed, raw);
    const logger = this.logger.child({ connector: name });
    if (!parsed.ok) {
      if (parsed.enabled) logger.warn("invalid connector config", { error: parsed.error });
      return { name, parsed, key, spec: undefined, connection: undefined };
    }
    for (const warning of parsed.warnings) logger.warn("connector config warning", { warning });
    const { spec } = parsed;
    if (!spec.enabled) return { name, parsed, key, spec, connection: undefined };
    const connection = new McpConnection({
      serverName: name,
      source: this.createSource(spec, { env: this.env, logger }),
      connectTimeoutMs: spec.connectTimeoutMs,
      logger,
      onChange: () => this.changed(),
      ...(this.retry ? { retry: this.retry } : {}),
    });
    return { name, parsed, key, spec, connection };
  }

  private entryStatus(entry: ServerEntry): ConnectorStatus {
    const { name, parsed, spec, connection } = entry;
    if (!parsed.ok) {
      return parsed.enabled
        ? { name, transport: parsed.transport, state: "error", toolCount: 0, error: parsed.error }
        : { name, transport: parsed.transport, state: "disabled", toolCount: 0 };
    }
    if (!connection || !spec?.enabled) {
      return { name, transport: parsed.spec.type, state: "disabled", toolCount: 0 };
    }
    const state = connection.state === "closed" ? "idle" : connection.state;
    const tools = connection.toolList;
    const status: ConnectorStatus = {
      name,
      transport: connection.transport,
      state,
      toolCount: tools
        ? tools.filter((tool) => isToolAllowed(spec.toolFilter, tool.name)).length
        : 0,
    };
    const failure = connection.lastError;
    if (failure && (state === "error" || state === "connecting")) {
      status.error = truncate(maskSecrets(failure.message), MAX_STATUS_ERROR_CHARS);
    }
    return status;
  }

  private buildTools(): ToolSpec[] {
    if (this.toolCache?.generation === this.generation) return this.toolCache.tools;
    const candidates: Array<{ entry: ServerEntry; spec: ServerSpec; tool: McpToolDefinition }> = [];
    for (const entry of this.entries.values()) {
      const { spec, connection } = entry;
      const tools = connection?.toolList;
      if (!spec || !tools) continue;
      for (const tool of tools) {
        if (isToolAllowed(spec.toolFilter, tool.name)) candidates.push({ entry, spec, tool });
      }
    }
    const names = assignToolNames(
      candidates.map(({ entry, tool }) => ({ server: entry.name, tool: tool.name })),
    );
    const tools = candidates.map(({ entry, spec, tool }) => {
      const key = toolRefKey(entry.name, tool.name);
      const name = names.get(key) ?? mcpToolName(entry.name, tool.name);
      if (name !== mcpToolName(entry.name, tool.name) && !this.renamed.has(`${key}\u0000${name}`)) {
        this.renamed.add(`${key}\u0000${name}`);
        this.logger.warn("MCP tool renamed to avoid a name collision", {
          connector: entry.name,
          tool: tool.name,
          name,
        });
      }
      return createMcpToolSpec({
        name,
        serverName: entry.name,
        serverDescription: spec.description,
        tool,
        target: this.targetFor(entry.name, tool.name),
      });
    });
    tools.sort((a, b) => compareStrings(a.name, b.name));
    this.toolCache = { generation: this.generation, tools };
    return tools;
  }

  /** Resolves the server by name on every use, so specs survive reloads and reconnects. */
  private targetFor(serverName: string, toolName: string): McpToolTarget {
    return {
      approval: () => {
        const entry = this.entries.get(serverName);
        return !this.disposed && entry?.connection && entry.spec ? entry.spec.approval : undefined;
      },
      call: (args, options) => this.callTool(serverName, toolName, args, options),
    };
  }

  private callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; onProgress?: (progress: McpProgress) => void },
  ): Promise<unknown> {
    const entry = this.entries.get(serverName);
    if (this.disposed || !entry?.connection || !entry.spec) {
      return Promise.reject(
        new McpUnavailableError(
          serverName,
          `MCP server "${serverName}" is no longer configured or is disabled`,
        ),
      );
    }
    if (!isToolAllowed(entry.spec.toolFilter, toolName)) {
      return Promise.reject(
        new McpUnavailableError(
          serverName,
          `Tool "${toolName}" is excluded by the toolFilter of MCP server "${serverName}"`,
        ),
      );
    }
    return entry.connection.callTool(toolName, args, {
      timeoutMs: entry.spec.requestTimeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
  }

  private changed(): void {
    this.generation++;
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      if (this.disposed || this.listeners.size === 0) return;
      const status = this.status();
      const serialized = JSON.stringify(status);
      if (serialized === this.lastEmitted) return;
      this.lastEmitted = serialized;
      for (const listener of [...this.listeners]) {
        try {
          listener(status);
        } catch (error) {
          this.logger.warn("connector status listener failed", { error: errorMessage(error) });
        }
      }
    });
  }
}

function serversOf(config: ConnectorsConfig, logger: Logger): Array<[string, unknown]> {
  const servers: unknown = isPlainObject(config) ? config.mcpServers : undefined;
  if (isPlainObject(servers)) return Object.entries(servers);
  if (servers !== undefined) logger.error('connectors config: "mcpServers" must be an object');
  return [];
}

function entryKey(parsed: ParsedServerConfig, raw: unknown): string {
  if (!parsed.ok) return `invalid:${stableStringify(raw)}`;
  return `${parsed.spec.enabled ? "enabled" : "disabled"}:${launchFingerprint(parsed.spec)}`;
}
