import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { McpConnection, type McpConnectionOptions } from "../src/connection";
import { McpTimeoutError, McpTransportError, McpUnavailableError } from "../src/errors";
import type { TransportSource } from "../src/transports";
import { FakeServers, fakeTool, hangUntilCancelled, silentSource } from "./support/fake-server";
import { waitFor } from "./support/wait";

const FAST_RETRY = {
  maxReconnectAttempts: 3,
  baseDelayMs: 5,
  maxDelayMs: 20,
  jitter: 0,
  cooldownMs: 200,
};

const open: McpConnection[] = [];

function connection(
  source: TransportSource,
  options: Partial<McpConnectionOptions> = {},
): McpConnection {
  const created = new McpConnection({
    serverName: "fake",
    source,
    connectTimeoutMs: 2_000,
    retry: FAST_RETRY,
    ...options,
  });
  open.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

describe("McpConnection", () => {
  it("connects lazily and lists tools leniently", async () => {
    const source = new FakeServers([
      fakeTool("ok", { annotations: { readOnlyHint: true, title: "OK", openWorldHint: "yes" } }),
      {
        definition: {
          name: "no_schema_type",
          inputSchema: { properties: { a: {} }, required: ["a", "b"] },
        },
      },
      { definition: { description: "nameless" } },
      fakeTool("needs_tasks", { execution: { taskSupport: "required" } }),
      fakeTool("ok", { description: "duplicate" }),
      fakeTool("no_schema_at_all", { inputSchema: undefined }),
    ]);
    const conn = connection(source);
    expect(conn.state).toBe("idle");
    expect(source.opens).toBe(0);

    await conn.ready();
    expect(conn.state).toBe("connected");
    expect(conn.toolList?.map((tool) => tool.name)).toEqual([
      "ok",
      "no_schema_type",
      "no_schema_at_all",
    ]);
    expect(conn.toolList?.[0]?.annotations).toEqual({ readOnlyHint: true, title: "OK" });
    await conn.ready();
    expect(source.opens).toBe(1);
  });

  it("follows pagination and caps the number of tools", async () => {
    const tools = Array.from({ length: 12 }, (_, i) => fakeTool(`tool_${i}`));
    const conn = connection(new FakeServers(tools, { pageSize: 5 }), { maxTools: 10 });
    await conn.ready();
    expect(conn.toolList).toHaveLength(10);
    expect(conn.toolList?.at(-1)?.name).toBe("tool_9");
  });

  it("calls tools and surfaces server protocol errors as McpError", async () => {
    const source = new FakeServers([
      fakeTool("echo", {}, (args) => ({ content: [{ type: "text", text: `echo ${args.text}` }] })),
    ]);
    const conn = connection(source);
    await expect(
      conn.callTool("echo", { text: "hi" }, { timeoutMs: 1_000 }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "echo hi" }],
    });
    await expect(conn.callTool("nope", {}, { timeoutMs: 1_000 })).rejects.toBeInstanceOf(McpError);
    expect(source.calls.map((call) => call.name)).toEqual(["echo", "nope"]);
  });

  it("times out slow calls and cancels them on the server", async () => {
    const source = new FakeServers([fakeTool("hang", {}, hangUntilCancelled)]);
    const conn = connection(source);
    await conn.ready();
    const error = await conn.callTool("hang", {}, { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpTimeoutError);
    expect(error).toMatchObject({ operation: "call_tool", timeoutMs: 50 });
    await waitFor(() => source.cancelled.includes("hang"), "server-side cancellation");
    expect(conn.state).toBe("connected");
  });

  it("rejects with the caller's abort reason and cancels on the server", async () => {
    const source = new FakeServers([fakeTool("hang", {}, hangUntilCancelled)]);
    const conn = connection(source);
    await conn.ready();
    const controller = new AbortController();
    const reason = new Error("user cancelled the task");
    setTimeout(() => controller.abort(reason), 20);
    await expect(
      conn.callTool("hang", {}, { timeoutMs: 5_000, signal: controller.signal }),
    ).rejects.toBe(reason);
    await waitFor(() => source.cancelled.includes("hang"), "server-side cancellation");

    const aborted = AbortSignal.abort();
    await expect(conn.callTool("hang", {}, { timeoutMs: 5_000, signal: aborted })).rejects.toBe(
      aborted.reason,
    );
  });

  it("reports a server that never initializes as a connect timeout", async () => {
    const conn = connection(silentSource(), { connectTimeoutMs: 50 });
    await conn.ready();
    expect(conn.state).toBe("error");
    expect(conn.lastError).toBeInstanceOf(McpTimeoutError);
    expect(conn.lastError?.message).toBe(
      'MCP server "fake" did not finish starting up within 50 ms',
    );
  });

  it("reconnects after an unexpected disconnect and refreshes its tools", async () => {
    const source = new FakeServers([fakeTool("a")]);
    let changes = 0;
    const conn = connection(source, { onChange: () => changes++ });
    await conn.ready();
    source.tools = [fakeTool("a"), fakeTool("b")];
    await source.crash();
    expect(conn.state).toBe("connecting");
    expect(conn.lastError).toBeInstanceOf(McpTransportError);
    expect(conn.toolList?.map((t) => t.name)).toEqual(["a"]);

    await waitFor(() => conn.state === "connected", "reconnected");
    expect(source.opens).toBe(2);
    expect(conn.lastError).toBeUndefined();
    expect(conn.toolList?.map((t) => t.name)).toEqual(["a", "b"]);
    expect(changes).toBeGreaterThanOrEqual(3);
    await expect(conn.callTool("b", {}, { timeoutMs: 1_000 })).resolves.toMatchObject({
      content: [{ text: "called b" }],
    });
  });

  it("lets calls wait for an in-progress reconnect", async () => {
    const source = new FakeServers([fakeTool("a")]);
    const conn = connection(source, { retry: { ...FAST_RETRY, baseDelayMs: 50 } });
    await conn.ready();
    await source.crash();
    await expect(conn.callTool("a", {}, { timeoutMs: 2_000 })).resolves.toMatchObject({
      content: [{ text: "called a" }],
    });
    expect(source.opens).toBe(2);
  });

  it("fails an in-flight call when the connection drops", async () => {
    const source = new FakeServers([fakeTool("hang", {}, hangUntilCancelled)]);
    const conn = connection(source);
    await conn.ready();
    const call = conn.callTool("hang", {}, { timeoutMs: 5_000 }).catch((e: unknown) => e);
    await waitFor(() => source.calls.length === 1, "call reached the server");
    await source.crash();
    const error = await call;
    expect(error).toBeInstanceOf(McpTransportError);
    expect((error as Error).message).toBe('MCP server "fake" disconnected while running "hang"');
  });

  it("gives up after the reconnect budget, then cools down before trying again lazily", async () => {
    const source = new FakeServers([fakeTool("a")]);
    const conn = connection(source);
    await conn.ready();
    source.failOpens = 100;
    await source.crash();
    await waitFor(() => conn.state === "error", "error state");
    expect(source.opens).toBe(1 + FAST_RETRY.maxReconnectAttempts);
    expect(conn.lastError?.message).toBe("fake server is down");
    expect(conn.toolList).toBeUndefined();

    const refused = await conn.callTool("a", {}, { timeoutMs: 1_000 }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(McpUnavailableError);
    expect((refused as Error).message).toMatch(
      /^MCP server "fake" is unavailable: fake server is down \(next attempt in \d+ s\)$/,
    );
    await conn.ready();
    expect(source.opens).toBe(1 + FAST_RETRY.maxReconnectAttempts);

    source.failOpens = 0;
    await new Promise((resolve) => setTimeout(resolve, FAST_RETRY.cooldownMs + 20));
    await expect(conn.callTool("a", {}, { timeoutMs: 1_000 })).resolves.toMatchObject({
      content: [{ text: "called a" }],
    });
    expect(conn.state).toBe("connected");
    expect(source.opens).toBe(2 + FAST_RETRY.maxReconnectAttempts);
  });

  it("puts a failed first connection into cooldown instead of retrying on every use", async () => {
    const source = new FakeServers([fakeTool("a")]);
    source.failOpens = 1;
    const conn = connection(source);
    await conn.ready();
    await conn.ready();
    expect(conn.state).toBe("error");
    expect(source.opens).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, FAST_RETRY.cooldownMs + 20));
    await conn.ready();
    expect(conn.state).toBe("connected");
    expect(source.opens).toBe(2);
  });

  it("refreshes the tool list on notifications/tools/list_changed", async () => {
    const source = new FakeServers([fakeTool("a")]);
    let changes = 0;
    const conn = connection(source, { onChange: () => changes++ });
    await conn.ready();
    const before = changes;
    source.tools = [fakeTool("a"), fakeTool("c")];
    await source.announceToolsChanged();
    await waitFor(() => conn.toolList?.length === 2, "refreshed tool list");
    expect(changes).toBeGreaterThan(before);
    expect(source.opens).toBe(1);
  });

  it("stops reconnecting once closed and refuses later calls", async () => {
    const source = new FakeServers([fakeTool("a")]);
    const conn = connection(source, { retry: { ...FAST_RETRY, baseDelayMs: 100 } });
    await conn.ready();
    await source.crash();
    await conn.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(source.opens).toBe(1);
    expect(conn.state).toBe("closed");
    await expect(conn.callTool("a", {}, { timeoutMs: 1_000 })).rejects.toThrow(
      'MCP server "fake" was shut down',
    );
    await conn.close();
  });
});
