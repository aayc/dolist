/**
 * In-memory MCP servers for fast tests: each `open()` starts a fresh SDK `Server` on a linked
 * `InMemoryTransport` pair, so a "crash" (closing the server) is followed by a real reconnect.
 */
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  type ListToolsResult,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { ConnectorTransport } from "../../src/config";
import type { TransportHandle, TransportSource } from "../../src/transports";

export type FakeToolHandler = (
  args: Record<string, unknown>,
  extra: { signal: AbortSignal },
) => CallToolResult | Promise<CallToolResult>;

export interface FakeTool {
  /** Listed as-is, so tests can serve deliberately malformed definitions. */
  definition: Record<string, unknown>;
  handler?: FakeToolHandler;
}

export function fakeTool(
  name: string,
  definition: Record<string, unknown> = {},
  handler?: FakeToolHandler,
): FakeTool {
  return {
    definition: { name, inputSchema: { type: "object", properties: {} }, ...definition },
    ...(handler ? { handler } : {}),
  };
}

/** Resolves when the call is cancelled (timeout, abort or disconnect). */
export const hangUntilCancelled: FakeToolHandler = (_args, { signal }) =>
  new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ content: [] }), { once: true });
  });

export class FakeServers implements TransportSource {
  readonly kind: ConnectorTransport;
  readonly sseFallback = false;
  tools: FakeTool[];
  pageSize: number | undefined;
  opens = 0;
  /** Number of upcoming `open()` calls that fail. */
  failOpens = 0;
  failMessage = "fake server is down";
  readonly servers: Server[] = [];
  /** Names of tools whose in-flight calls were cancelled. */
  readonly cancelled: string[] = [];
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private readonly stderr: string[] = [];

  constructor(
    tools: FakeTool[] = [],
    options: { kind?: ConnectorTransport; pageSize?: number } = {},
  ) {
    this.tools = tools;
    this.kind = options.kind ?? "stdio";
    this.pageSize = options.pageSize;
  }

  async open(): Promise<TransportHandle> {
    this.opens++;
    if (this.failOpens > 0) {
      this.failOpens--;
      throw new Error(this.failMessage);
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = this.createServer();
    await server.connect(serverSide);
    this.servers.push(server);
    return { transport: clientSide, kind: this.kind, pid: () => null };
  }

  stderrTail(count = 10): string[] {
    return this.stderr.slice(-count);
  }

  writeStderr(line: string): void {
    this.stderr.push(line);
  }

  get latest(): Server {
    const server = this.servers.at(-1);
    if (!server) throw new Error("no fake server has been started");
    return server;
  }

  /** Closes the current server, which the client sees as the transport closing. */
  async crash(): Promise<void> {
    await this.latest.close();
  }

  async announceToolsChanged(): Promise<void> {
    await this.latest.sendToolListChanged();
  }

  private createServer(): Server {
    const server = new Server(
      { name: "fake", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, (request) => {
      const all = this.tools.map((tool) => tool.definition);
      if (this.pageSize === undefined) return { tools: all } as unknown as ListToolsResult;
      const offset = Number(request.params?.cursor ?? 0);
      const end = offset + this.pageSize;
      const page = {
        tools: all.slice(offset, end),
        ...(end < all.length ? { nextCursor: String(end) } : {}),
      };
      return page as unknown as ListToolsResult;
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name } = request.params;
      const args = request.params.arguments ?? {};
      this.calls.push({ name, args });
      const tool = this.tools.find((candidate) => candidate.definition.name === name);
      if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
      extra.signal.addEventListener("abort", () => this.cancelled.push(name), { once: true });
      if (!tool.handler) return { content: [{ type: "text", text: `called ${name}` }] };
      return tool.handler(args, { signal: extra.signal });
    });
    return server;
  }
}

/** A source whose server never answers `initialize`. */
export function silentSource(): TransportSource {
  return {
    kind: "stdio",
    sseFallback: false,
    stderrTail: () => [],
    async open() {
      const [clientSide] = InMemoryTransport.createLinkedPair();
      return { transport: clientSide, kind: "stdio", pid: () => null };
    },
  };
}
