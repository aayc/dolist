import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpBridge, type McpRegistration, type McpSessionHandler } from "./mcp-bridge";

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let bridge: McpBridge;
let endpoint: McpRegistration;
let handler: McpSessionHandler & { callTool: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  bridge = new McpBridge({ serverName: "daily-do-list", maxBodyBytes: 1024 });
  await bridge.start();
  handler = {
    listTools: () => [
      { name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } },
    ],
    callTool: vi.fn(async (name: string, args: unknown) => ({
      content: [{ type: "text" as const, text: `${name}:${JSON.stringify(args)}` }],
    })),
  };
  endpoint = bridge.register(handler);
});

afterEach(async () => {
  await bridge.close();
});

function send(
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
    host?: string;
  } = {},
): Promise<Response> {
  const url = new URL(endpoint.url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: url.port,
        path: options.path ?? url.pathname,
        method: options.method ?? "POST",
        headers: {
          host: options.host ?? `127.0.0.1:${url.port}`,
          authorization: `Bearer ${endpoint.token}`,
          "content-type": "application/json",
          ...options.headers,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const rpc = (method: string, params?: unknown, id: number | string = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

describe("McpBridge", () => {
  it("listens on loopback only, one endpoint and token per session", () => {
    expect(bridge.address.host).toBe("127.0.0.1");
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{32}$/);
    expect(endpoint.token).toMatch(/^[0-9a-f]{64}$/);
    const other = bridge.register(handler);
    expect(other.url).not.toBe(endpoint.url);
    expect(other.token).not.toBe(endpoint.token);
  });

  it("negotiates the protocol version and serves tools", async () => {
    const init = await send({ body: rpc("initialize", { protocolVersion: "2025-06-18" }) });
    expect(init.status).toBe(200);
    expect(JSON.parse(init.body)).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "daily-do-list" },
      },
    });
    const unknown = await send({ body: rpc("initialize", { protocolVersion: "1999-01-01" }) });
    expect(JSON.parse(unknown.body).result.protocolVersion).toBe("2025-11-25");
    expect(JSON.parse((await send({ body: rpc("ping", {}, "p") })).body)).toEqual({
      jsonrpc: "2.0",
      id: "p",
      result: {},
    });
    const list = await send({ body: rpc("tools/list", {}) });
    expect(JSON.parse(list.body).result.tools.map((t: { name: string }) => t.name)).toEqual([
      "echo",
    ]);
    const call = await send({ body: rpc("tools/call", { name: "echo", arguments: { a: 1 } }) });
    expect(JSON.parse(call.body).result).toEqual({
      content: [{ type: "text", text: 'echo:{"a":1}' }],
    });
    expect(handler.callTool).toHaveBeenCalledWith("echo", { a: 1 }, expect.any(AbortSignal));
  });

  it("answers notifications with 202, GET with 405 and DELETE with 200", async () => {
    const note = await send({
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);
    expect(note.body).toBe("");
    const get = await send({ method: "GET", headers: { accept: "text/event-stream" } });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST, DELETE");
    expect((await send({ method: "DELETE" })).status).toBe(200);
    expect((await send({ method: "PUT", body: "{}" })).status).toBe(405);
  });

  it("refuses bad tokens, unknown endpoints, foreign hosts and any Origin before parsing", async () => {
    const bad = await send({ headers: { authorization: "Bearer wrong" }, body: rpc("tools/list") });
    expect(bad.status).toBe(401);
    expect(bad.headers["www-authenticate"]).toBe("Bearer");
    expect((await send({ headers: { authorization: "" }, body: rpc("tools/list") })).status).toBe(
      401,
    );
    const otherToken = bridge.register(handler).token;
    expect(
      (await send({ headers: { authorization: `Bearer ${otherToken}` }, body: rpc("tools/list") }))
        .status,
    ).toBe(401);
    expect((await send({ path: "/mcp/0123456789abcdef0123456789abcdef" })).status).toBe(404);
    expect((await send({ path: "/" })).status).toBe(404);
    const port = new URL(endpoint.url).port;
    expect((await send({ host: `evil.example.com:${port}`, body: rpc("tools/list") })).status).toBe(
      403,
    );
    expect((await send({ host: `127.0.0.1:1`, body: rpc("tools/list") })).status).toBe(403);
    expect((await send({ host: `localhost:${port}`, body: rpc("ping") })).status).toBe(200);
    const origin = await send({
      headers: { origin: "https://example.com" },
      body: rpc("tools/list"),
    });
    expect(origin.status).toBe(403);
    expect(
      (await send({ headers: { origin: `http://127.0.0.1:${port}` }, body: rpc("ping") })).status,
    ).toBe(403);
    expect(handler.callTool).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies, wrong content types and malformed JSON-RPC", async () => {
    const big = await send({
      body: rpc("tools/call", { name: "echo", arguments: { x: "y".repeat(2000) } }),
    });
    expect(big.status).toBe(413);
    expect(
      (await send({ headers: { "content-type": "text/plain" }, body: rpc("ping") })).status,
    ).toBe(415);
    expect(
      (await send({ headers: { "mcp-protocol-version": "1999-01-01" }, body: rpc("ping") })).status,
    ).toBe(400);
    const parse = await send({ body: "{not json" });
    expect(parse.status).toBe(400);
    expect(JSON.parse(parse.body).error.code).toBe(-32700);
    const batch = await send({ body: `[${rpc("ping")}]` });
    expect(JSON.parse(batch.body).error.code).toBe(-32600);
    expect(
      JSON.parse((await send({ body: '{"jsonrpc":"1.0","id":1,"method":"ping"}' })).body).error
        .code,
    ).toBe(-32600);
    const unknown = await send({ body: rpc("resources/list") });
    expect(JSON.parse(unknown.body).error.code).toBe(-32601);
    const invalid = await send({ body: rpc("tools/call", { name: 42 }) });
    expect(JSON.parse(invalid.body).error.code).toBe(-32602);
    const badArgs = await send({ body: rpc("tools/call", { name: "echo", arguments: [1] }) });
    expect(JSON.parse(badArgs.body).error.code).toBe(-32602);
    expect(handler.callTool).not.toHaveBeenCalled();
  });

  it("aborts a call when the client cancels it or the session is unregistered", async () => {
    const signals: AbortSignal[] = [];
    handler.callTool.mockImplementation(
      (_name: string, _args: unknown, signal: AbortSignal) =>
        new Promise((resolve) => {
          signals.push(signal);
          signal.addEventListener("abort", () =>
            resolve({ content: [{ type: "text", text: "cancelled" }], isError: true }),
          );
        }),
    );
    const call = send({ body: rpc("tools/call", { name: "echo", arguments: {} }, 7) });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const cancel = await send({
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 7 },
      }),
    });
    expect(cancel.status).toBe(202);
    expect(JSON.parse((await call).body).result.isError).toBe(true);

    const second = send({ body: rpc("tools/call", { name: "echo", arguments: {} }, 8) });
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    endpoint.unregister();
    expect(signals[1]?.aborted).toBe(true);
    await second;
    expect((await send({ body: rpc("ping") })).status).toBe(404);
  });
});
