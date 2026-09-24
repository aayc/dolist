// biome-ignore-all lint/suspicious/noTemplateCurlyInString: some strings are connector config placeholders, not template literals.
/**
 * HTTP transports against loopback servers built from the SDK's own server transports
 * (127.0.0.1 only; nothing leaves the machine).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConnectorStatus } from "@ddl/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createConnectorManager } from "../src/manager";
import type { ConnectorsConfig, ConnectorToolSource } from "../src/types";

interface Loopback {
  url: string;
  requests: Array<{ method: string; path: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

function mcpServer(label: string): Server {
  const server = new Server({ name: label, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "whoami", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: label }],
  }));
  return server;
}

async function listen(handler: Handler): Promise<Loopback> {
  const requests: Loopback["requests"] = [];
  const http = createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      path: req.url ?? "",
      authorization: req.headers.authorization,
    });
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  const loopback: Loopback = {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
  cleanup.push(() => loopback.close());
  return loopback;
}

/** Stateless streamable HTTP: a fresh server per POST, 405 for the optional GET stream. */
const streamableHandler: Handler = async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = mcpServer("streamable");
  res.on("close", () => {
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
};

/** A legacy server that only speaks the 2024-11-05 HTTP+SSE transport. */
function legacySseHandler(): Handler {
  const sessions = new Map<string, SSEServerTransport>();
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/mcp") {
      const transport = new SSEServerTransport("/messages", res);
      sessions.set(transport.sessionId, transport);
      res.on("close", () => sessions.delete(transport.sessionId));
      await mcpServer("legacy").connect(transport);
      return;
    }
    const session = sessions.get(url.searchParams.get("sessionId") ?? "");
    if (req.method === "POST" && url.pathname === "/messages" && session) {
      await session.handlePostMessage(req, res);
      return;
    }
    res.writeHead(405).end();
  };
}

function managed(
  servers: Record<string, unknown>,
  env: Record<string, string> = {},
): ConnectorToolSource {
  const source = createConnectorManager({ mcpServers: servers } as ConnectorsConfig, { env });
  cleanup.push(() => source.dispose());
  return source;
}

function statusOf(source: ConnectorToolSource, name: string): ConnectorStatus | undefined {
  return source.status().find((status) => status.name === name);
}

describe("http servers", () => {
  it("talks streamable HTTP with interpolated headers", async () => {
    const loopback = await listen(streamableHandler);
    const source = managed(
      { remote: { url: loopback.url, headers: { Authorization: "Bearer ${LOOPBACK_TOKEN}" } } },
      { LOOPBACK_TOKEN: "loopback-token" },
    );
    const [whoami] = await source.getTools();
    expect(whoami?.name).toBe("mcp__remote__whoami");
    await expect(whoami?.execute({}, { toolCallId: "1" })).resolves.toMatchObject({
      content: [{ type: "text", text: "streamable" }],
    });
    expect(statusOf(source, "remote")).toEqual({
      name: "remote",
      transport: "http",
      state: "connected",
      toolCount: 1,
    });
    const posts = loopback.requests.filter((request) => request.method === "POST");
    expect(posts.length).toBeGreaterThanOrEqual(3);
    for (const post of posts) expect(post.authorization).toBe("Bearer loopback-token");
  });

  it("falls back to legacy SSE when streamable HTTP is rejected", async () => {
    const loopback = await listen(legacySseHandler());
    const source = managed({ legacy: { type: "http", url: loopback.url } });
    const [whoami] = await source.getTools();
    await expect(whoami?.execute({}, { toolCallId: "1" })).resolves.toMatchObject({
      content: [{ type: "text", text: "legacy" }],
    });
    expect(statusOf(source, "legacy")).toMatchObject({ transport: "sse", state: "connected" });
    expect(loopback.requests[0]).toMatchObject({ method: "POST", path: "/mcp" });
  });

  it("reports authentication failures without trying the SSE fallback", async () => {
    const loopback = await listen(async (_req, res) => {
      res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
    });
    const source = managed({
      locked: { url: loopback.url, headers: { Authorization: "Bearer wrong" } },
    });
    expect(await source.getTools()).toEqual([]);
    expect(statusOf(source, "locked")).toMatchObject({
      state: "error",
      error:
        'Authentication failed (HTTP 401). Check the token in "headers"; OAuth sign-in is not supported yet.',
    });
    expect(loopback.requests.every((request) => request.method === "POST")).toBe(true);
  });
});
