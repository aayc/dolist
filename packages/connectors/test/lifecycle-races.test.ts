import { TOOL_NAME_RE, type ToolSpec } from "@ddl/core";
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
import { afterEach, describe, expect, it } from "vitest";
import type { ServerSpec } from "../src/config";
import { MAX_TOOLS_PER_SERVER } from "../src/connection";
import {
  ConnectorError,
  McpTimeoutError,
  McpTransportError,
  McpUnavailableError,
} from "../src/errors";
import { ConnectorManager } from "../src/manager";
import type { TransportHandle, TransportSource } from "../src/transports";
import type { ConnectorsConfig } from "../src/types";
import { waitFor } from "./support/wait";

const FAST_RETRY = {
  maxReconnectAttempts: 3,
  baseDelayMs: 5,
  maxDelayMs: 20,
  jitter: 0,
  cooldownMs: 60_000,
};
const ctx = { toolCallId: "call-1" };

type Handler = (
  args: Record<string, unknown>,
  signal: AbortSignal,
  server: Server,
) => Promise<CallToolResult>;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** An in-memory MCP server whose startup, listing and calls the test controls. */
class ControlledSource implements TransportSource {
  readonly kind = "stdio" as const;
  readonly sseFallback = false;
  tools: Array<Record<string, unknown>>;
  handlers = new Map<string, Handler>();
  /** `tools/list` waits for this (the part of connecting that `close()` must be able to abort). */
  listGate: Promise<void> | undefined;
  listDelayMs = 0;
  listRequests = 0;
  opens = 0;
  readonly servers: Server[] = [];
  readonly calls: string[] = [];
  readonly cancelled: string[] = [];

  constructor(tools: string[] = []) {
    this.tools = tools.map((name) => ({ name, inputSchema: { type: "object", properties: {} } }));
  }

  async open(): Promise<TransportHandle> {
    this.opens++;
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new Server(
      { name: "controlled", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.listRequests++;
      await this.listGate;
      if (this.listDelayMs > 0) await new Promise((r) => setTimeout(r, this.listDelayMs));
      return { tools: this.tools } as unknown as ListToolsResult;
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name } = request.params;
      this.calls.push(name);
      extra.signal.addEventListener("abort", () => this.cancelled.push(name), { once: true });
      if (!this.tools.some((t) => t.name === name))
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
      const handler = this.handlers.get(name);
      return handler
        ? handler(request.params.arguments ?? {}, extra.signal, server)
        : { content: [{ type: "text", text: `called ${name}` }] };
    });
    await server.connect(serverSide);
    this.servers.push(server);
    return { transport: client, kind: "stdio", pid: () => null };
  }

  stderrTail(): string[] {
    return [];
  }
}

const managers: ConnectorManager[] = [];

function managerFor(sources: Record<string, ControlledSource>, servers: Record<string, unknown>) {
  const created = new ConnectorManager(
    { mcpServers: servers } as ConnectorsConfig,
    { retry: FAST_RETRY, env: {} },
    (spec: ServerSpec) => {
      const source = sources[spec.name];
      if (!source) throw new Error(`no source for ${spec.name}`);
      return source;
    },
  );
  managers.push(created);
  return created;
}

function byName(tools: ToolSpec[], name: string): ToolSpec {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`missing ${name}: ${tools.map((t) => t.name).join(", ")}`);
  return tool;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.dispose()));
});

describe("connector lifecycle races", () => {
  it("drops a server removed by reload while it is still connecting", async () => {
    const gate = deferred();
    const slow = new ControlledSource(["x"]);
    slow.listGate = gate.promise;
    const m = managerFor(
      { slow, other: new ControlledSource(["y"]) },
      {
        slow: { command: "fake" },
        other: { command: "fake" },
      },
    );
    const pending = m.getTools();
    await waitFor(() => slow.listRequests === 1, "slow server listing tools");
    await m.reload({ mcpServers: { other: { command: "fake" } } } as ConnectorsConfig);
    gate.resolve();
    const tools = await pending;
    expect(tools.map((t) => t.name)).toEqual(["mcp__other__y"]);
    expect(m.status().map((s) => s.name)).toEqual(["other"]);
    expect((await m.getTools()).map((t) => t.name)).toEqual(["mcp__other__y"]);
  });

  it("restarts a server whose launch config changes mid-connect and serves the new tools", async () => {
    const gate = deferred();
    const first = new ControlledSource(["old"]);
    first.listGate = gate.promise;
    const second = new ControlledSource(["new"]);
    let created = 0;
    const m = new ConnectorManager(
      { mcpServers: { srv: { command: "fake", args: ["v1"] } } } as unknown as ConnectorsConfig,
      { retry: FAST_RETRY, env: {} },
      () => (created++ === 0 ? first : second),
    );
    managers.push(m);
    const pending = m.getTools();
    await waitFor(() => first.listRequests === 1, "first launch listing tools");
    await m.reload({
      mcpServers: { srv: { command: "fake", args: ["v2"] } },
    } as unknown as ConnectorsConfig);
    gate.resolve();
    await pending;
    await waitFor(() => m.status()[0]?.state === "connected", "second launch connected");
    expect((await m.getTools()).map((t) => t.name)).toEqual(["mcp__srv__new"]);
  });

  it("rejects an in-flight call promptly when the manager is disposed", async () => {
    const source = new ControlledSource(["hang"]);
    source.handlers.set(
      "hang",
      (_args, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve({ content: [] }))),
    );
    const m = managerFor({ srv: source }, { srv: { command: "fake" } });
    const hang = byName(await m.getTools(), "mcp__srv__hang");
    const call = hang.execute({}, ctx);
    await waitFor(() => source.calls.length === 1, "call reached the server");
    const started = performance.now();
    await m.dispose();
    await expect(call).rejects.toBeInstanceOf(ConnectorError);
    expect(performance.now() - started).toBeLessThan(1_000);
    await expect(hang.execute({}, ctx)).rejects.toBeInstanceOf(McpUnavailableError);
    expect(hang.safety.alwaysRequireApproval).toBe(true);
  });

  it("rejects an in-flight call when reload removes its server", async () => {
    const source = new ControlledSource(["hang"]);
    source.handlers.set(
      "hang",
      (_args, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve({ content: [] }))),
    );
    const m = managerFor({ srv: source }, { srv: { command: "fake" } });
    const hang = byName(await m.getTools(), "mcp__srv__hang");
    const call = hang.execute({}, ctx);
    await waitFor(() => source.calls.length === 1, "call reached the server");
    await m.reload({ mcpServers: {} } as ConnectorsConfig);
    await expect(call).rejects.toBeInstanceOf(ConnectorError);
  });

  it("keeps an in-flight call alive across a policy-only reload", async () => {
    const release = deferred();
    const source = new ControlledSource(["slow"]);
    source.handlers.set("slow", async () => {
      await release.promise;
      return { content: [{ type: "text", text: "done" }] };
    });
    const m = managerFor({ srv: source }, { srv: { command: "fake" } });
    const slow = byName(await m.getTools(), "mcp__srv__slow");
    const call = slow.execute({}, ctx);
    await waitFor(() => source.calls.length === 1, "call reached the server");
    await m.reload({
      mcpServers: { srv: { command: "fake", approval: "always" } },
    } as unknown as ConnectorsConfig);
    expect(slow.safety.alwaysRequireApproval).toBe(true);
    release.resolve();
    await expect(call).resolves.toMatchObject({ content: [{ type: "text", text: "done" }] });
    expect(source.opens).toBe(1);
  });

  it("connects each server once for many concurrent getTools calls", async () => {
    const sources = {
      a: new ControlledSource(["a1"]),
      b: new ControlledSource(["b1"]),
      c: new ControlledSource(["c1"]),
    };
    const m = managerFor(sources, {
      a: { command: "fake" },
      b: { command: "fake" },
      c: { command: "fake" },
    });
    const results = await Promise.all(Array.from({ length: 20 }, () => m.getTools()));
    for (const r of results) expect(r).toBe(results[0]);
    expect(Object.values(sources).map((s) => s.opens)).toEqual([1, 1, 1]);
  });

  it("fails a call on a crash mid-call, then reconnects for the next one", async () => {
    const source = new ControlledSource(["work"]);
    const reached = deferred();
    let crashOnce = true;
    source.handlers.set("work", async (_args, _signal, server) => {
      if (crashOnce) {
        crashOnce = false;
        reached.resolve();
        await new Promise((r) => setTimeout(r, 5));
        await server.close();
        return { content: [] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    });
    const m = managerFor({ srv: source }, { srv: { command: "fake" } });
    const work = byName(await m.getTools(), "mcp__srv__work");
    const call = work.execute({}, ctx);
    await reached.promise;
    await expect(call).rejects.toBeInstanceOf(McpTransportError);
    await waitFor(() => source.opens === 2 && m.status()[0]?.state === "connected", "reconnected");
    await expect(work.execute({}, ctx)).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("finishes a call whose server announces list_changed mid-call and refreshes the tools", async () => {
    const source = new ControlledSource(["mutate"]);
    source.handlers.set("mutate", async (_args, _signal, server) => {
      source.tools = [...source.tools, { name: "added", inputSchema: { type: "object" } }];
      await server.sendToolListChanged();
      return { content: [{ type: "text", text: "mutated" }] };
    });
    const m = managerFor({ srv: source }, { srv: { command: "fake" } });
    const mutate = byName(await m.getTools(), "mcp__srv__mutate");
    await expect(mutate.execute({}, ctx)).resolves.toMatchObject({
      content: [{ type: "text", text: "mutated" }],
    });
    await waitFor(async () => (await m.getTools()).length === 2, "tool list refreshed");
    expect((await m.getTools()).map((t) => t.name)).toEqual([
      "mcp__srv__added",
      "mcp__srv__mutate",
    ]);
  });

  it("turns a call to a tool the server just removed into an error result", async () => {
    const source = new ControlledSource(["gone", "stay"]);
    const m = managerFor({ srv: source }, { srv: { command: "fake" } });
    const gone = byName(await m.getTools(), "mcp__srv__gone");
    source.tools = source.tools.filter((t) => t.name !== "gone");
    const result = await gone.execute({}, ctx);
    expect(result.isError).toBe(true);
  });

  it("reports a server whose tools/list is too slow without blocking the others", async () => {
    const slow = new ControlledSource(["x"]);
    slow.listDelayMs = 400;
    const m = managerFor(
      { slow, fast: new ControlledSource(["y"]) },
      {
        slow: { command: "fake", connectTimeoutMs: 50 },
        fast: { command: "fake" },
      },
    );
    const started = performance.now();
    const tools = await m.getTools();
    expect(performance.now() - started).toBeLessThan(350);
    expect(tools.map((t) => t.name)).toEqual(["mcp__fast__y"]);
    expect(m.status().find((s) => s.name === "slow")).toMatchObject({
      state: "error",
      error: expect.stringContaining("did not finish starting up within 50 ms"),
    });
  });

  it("times out and cancels a slow call, and honors an aborted signal", async () => {
    const source = new ControlledSource(["hang"]);
    source.handlers.set(
      "hang",
      (_args, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve({ content: [] }))),
    );
    const m = managerFor({ srv: source }, { srv: { command: "fake", requestTimeoutMs: 40 } });
    const hang = byName(await m.getTools(), "mcp__srv__hang");
    await expect(hang.execute({}, ctx)).rejects.toBeInstanceOf(McpTimeoutError);
    const controller = new AbortController();
    const call = hang.execute({}, { ...ctx, signal: controller.signal });
    await waitFor(() => source.calls.length === 2, "second call reached the server");
    controller.abort(new Error("user stopped the task"));
    await expect(call).rejects.toThrow("user stopped the task");
    await waitFor(() => source.cancelled.length === 2, "both calls cancelled on the server");
  });

  it("caps thousands of tools per server and keeps names unique after sanitization", async () => {
    const variants = ["a.b", "a_b", "A_B", "a b", "a/b", "a😀b"];
    const names = Array.from(
      { length: 1_500 },
      (_, i) => `${variants[i % variants.length]}${Math.floor(i / 12)}`,
    );
    const big = new ControlledSource(names);
    const twin = new ControlledSource(["a.b0", "a_b0"]);
    const m = managerFor(
      { big, Big: twin },
      { big: { command: "fake" }, Big: { command: "fake" } },
    );
    const tools = await m.getTools();
    expect(tools).toHaveLength(MAX_TOOLS_PER_SERVER + 2);
    const toolNames = tools.map((t) => t.name);
    for (const name of toolNames) expect(name).toMatch(TOOL_NAME_RE);
    expect(new Set(toolNames.map((n) => n.toLowerCase())).size).toBe(toolNames.length);
    expect(m.status().find((s) => s.name === "big")?.toolCount).toBe(MAX_TOOLS_PER_SERVER);
  });
});
