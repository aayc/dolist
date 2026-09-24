/**
 * Typed connector errors. Messages reach users (status, approval cards) and the model, so they name
 * servers, fields and environment variables but never include resolved values.
 */

export class ConnectorError extends Error {
  /** Config key of the server this error is about, when there is one. */
  readonly serverName: string | undefined;

  constructor(message: string, serverName?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectorError";
    this.serverName = serverName;
  }
}

/** The connectors file, or one server entry in it, is invalid. */
export class ConnectorConfigError extends ConnectorError {
  constructor(message: string, serverName?: string, options?: ErrorOptions) {
    super(message, serverName, options);
    this.name = "ConnectorConfigError";
  }
}

export interface MissingEnvVar {
  variable: string;
  /** Config field that references it, e.g. `env.GITHUB_TOKEN` or `headers.Authorization`. */
  field: string;
}

/** A `${NAME}` / `$NAME` placeholder refers to an environment variable that is not set. */
export class MissingEnvVarError extends ConnectorConfigError {
  readonly variables: string[];

  constructor(serverName: string, missing: readonly MissingEnvVar[]) {
    const list = missing.map((m) => `${m.variable} (in ${m.field})`).join(", ");
    super(`Environment variable${missing.length === 1 ? "" : "s"} not set: ${list}`, serverName);
    this.name = "MissingEnvVarError";
    this.variables = [...new Set(missing.map((m) => m.variable))];
  }
}

/** The server could not be started, reached or initialized. */
export class McpConnectError extends ConnectorError {
  constructor(serverName: string, message: string, options?: ErrorOptions) {
    super(message, serverName, options);
    this.name = "McpConnectError";
  }
}

export type McpOperation = "connect" | "call_tool";

/** An MCP operation exceeded its deadline. */
export class McpTimeoutError extends ConnectorError {
  readonly operation: McpOperation;
  readonly timeoutMs: number;

  constructor(serverName: string, operation: McpOperation, timeoutMs: number, toolName?: string) {
    const what =
      operation === "connect"
        ? `did not finish starting up within ${timeoutMs} ms`
        : `did not answer "${toolName ?? "tool"}" within ${timeoutMs} ms`;
    super(`MCP server "${serverName}" ${what}`, serverName);
    this.name = "McpTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/** The server can't take requests: it failed and is cooling down, or was disabled, removed or closed. */
export class McpUnavailableError extends ConnectorError {
  /** Epoch ms after which the next lazy connection attempt is allowed, when known. */
  readonly retryAt: number | undefined;

  constructor(serverName: string, message: string, retryAt?: number, options?: ErrorOptions) {
    super(message, serverName, options);
    this.name = "McpUnavailableError";
    this.retryAt = retryAt;
  }
}

/** The connection failed or closed while a request was in flight. */
export class McpTransportError extends ConnectorError {
  constructor(serverName: string, message: string, options?: ErrorOptions) {
    super(message, serverName, options);
    this.name = "McpTransportError";
  }
}
