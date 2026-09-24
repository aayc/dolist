/**
 * Builds SDK client transports for a server spec. Every connection attempt gets a fresh transport,
 * with placeholders resolved at that moment (see `launch.ts`).
 */
import { stat } from "node:fs/promises";
import type { Logger } from "@ddl/core";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ConnectorTransport, ServerSpec } from "./config";
import { ConnectorConfigError } from "./errors";
import { type EnvSource, type HttpLaunch, resolveLaunch, type StdioLaunch } from "./launch";
import { maskSecrets } from "./redact";
import { StderrBuffer } from "./stderr";

export interface TransportHandle {
  readonly transport: Transport;
  /** Transport actually in use (an `http` server may have fallen back to `sse`). */
  readonly kind: ConnectorTransport;
  /** Child process id for stdio transports while the process runs. */
  pid(): number | null;
}

export interface TransportSource {
  /** Transport reported before the first successful connection. */
  readonly kind: ConnectorTransport;
  /** Whether a rejected streamable-HTTP connection may be retried over legacy SSE. */
  readonly sseFallback: boolean;
  open(options: { fallback: boolean }): Promise<TransportHandle>;
  /** Recent stderr lines of stdio servers, for diagnostics. */
  stderrTail(count?: number): string[];
}

export interface TransportSourceOptions {
  env: EnvSource;
  logger: Logger;
  homeDir?: string;
}

export function createTransportSource(
  spec: ServerSpec,
  options: TransportSourceOptions,
): TransportSource {
  const stderr = new StderrBuffer({
    onLine: (line) => options.logger.debug("mcp server stderr", { line: maskSecrets(line) }),
  });
  return {
    kind: spec.type,
    sseFallback: spec.type === "http",
    stderrTail: (count) => stderr.tail(count),
    async open({ fallback }) {
      const launch = resolveLaunch(spec, options.env, options.homeDir);
      return launch.type === "stdio"
        ? openStdio(spec.name, launch, stderr)
        : openHttp(launch, fallback || launch.type === "sse");
    },
  };
}

async function openStdio(
  serverName: string,
  launch: StdioLaunch,
  stderr: StderrBuffer,
): Promise<TransportHandle> {
  if (launch.cwd !== undefined) {
    // spawn reports a missing cwd as ENOENT, indistinguishable from a missing command.
    const info = await stat(launch.cwd).catch(() => undefined);
    if (!info?.isDirectory()) {
      throw new ConnectorConfigError(
        `"cwd" is not an existing directory: ${launch.cwd}`,
        serverName,
      );
    }
  }
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    // Only the SDK's safe defaults (PATH, HOME, …) plus configured variables reach the child, so
    // servers never inherit unrelated secrets from the daemon's environment.
    env: { ...getDefaultEnvironment(), ...launch.env },
    stderr: "pipe",
    ...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}),
  });
  stderr.attach(transport.stderr);
  return { transport, kind: "stdio", pid: () => transport.pid };
}

function openHttp(launch: HttpLaunch, sse: boolean): TransportHandle {
  const requestInit = { headers: launch.headers };
  const transport = sse
    ? new SSEClientTransport(launch.url, { requestInit })
    : new StreamableHTTPClientTransport(launch.url, { requestInit });
  return { transport, kind: sse ? "sse" : "http", pid: () => null };
}
