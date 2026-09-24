/**
 * Connector contracts. The config shape intentionally matches the de-facto `mcpServers` format used
 * by Claude Desktop, Cursor, OpenClaw (`mcp.servers`) and Hermes (`mcp_servers`), so existing server
 * snippets can be pasted in unchanged.
 */
import type { ConnectorStatus, ToolSpec, Unsubscribe } from "@ddl/core";

export interface McpToolFilter {
  /** Only expose these MCP tools: exact names or `*` globs (e.g. `read_*`). */
  include?: string[];
  /** Hide these MCP tools (applied after `include`): exact names or `*` globs. */
  exclude?: string[];
}

interface McpServerCommon {
  /** Default true. */
  enabled?: boolean;
  /** Connect/initialize timeout. Default 30s. */
  connectTimeoutMs?: number;
  /** Per tool-call timeout. Default 120s. */
  requestTimeoutMs?: number;
  toolFilter?: McpToolFilter;
  /**
   * Safety posture for this server's tools:
   *  - `"auto"` (default): use MCP tool annotations (`readOnlyHint`, `destructiveHint`,
   *    `openWorldHint`) plus the normal safety evaluator;
   *  - `"always"`: every call needs human approval;
   *  - `"writes"`: calls not annotated `readOnlyHint: true` need approval.
   */
  approval?: "auto" | "always" | "writes";
  /** Free-form description shown in the UI and given to the orchestrator when choosing tools. */
  description?: string;
}

export interface McpStdioServerConfig extends McpServerCommon {
  type?: "stdio";
  command: string;
  args?: string[];
  /** Values may reference env vars as `${NAME}` / `$NAME`; resolved at connect time. */
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHttpServerConfig extends McpServerCommon {
  /** `http` = streamable HTTP (falls back to SSE if the server rejects it); `sse` = legacy SSE. */
  type: "http" | "sse";
  url: string;
  /** Values may reference env vars as `${NAME}` / `$NAME`. */
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface ConnectorsConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface ConnectorToolSource {
  /**
   * Tools from every enabled server, named `mcp__<server>__<tool>`. Servers connect lazily on the
   * first call; failed servers are skipped (and reported via `status()`), never thrown.
   */
  getTools(): Promise<ToolSpec[]>;
  status(): ConnectorStatus[];
  onStatus(listener: (status: ConnectorStatus[]) => void): Unsubscribe;
  /** Re-read config and reconnect changed servers. */
  reload(config: ConnectorsConfig): Promise<void>;
  dispose(): Promise<void>;
}
