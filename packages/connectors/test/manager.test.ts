import { type ConnectorStatus, TOOL_NAME_RE, type ToolSpec } from "@ddl/core";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerSpec } from "../src/config";
import { McpUnavailableError } from "../src/errors";
import { ConnectorManager } from "../src/manager";
import type { ConnectorsConfig } from "../src/types";
import { FakeServers, type FakeTool, fakeTool } from "./support/fake-server";
import { waitFor } from "./support/wait";

const FAST_RETRY = {
  maxReconnectAttempts: 2,
  baseDelayMs: 5,
  maxDelayMs: 20,
  jitter: 0,
  cooldownMs: 60_000,
};
const ctx = { toolCallId: "call-1" };

/** Hands out one `FakeServers` per created connection and remembers them by server name. */
class Farm {
  readonly sources = new Map<string, FakeServers[]>();
  readonly tools = new Map<string, FakeTool[]>();
  readonly failures = new Map<string, string>();

  readonly create = (spec: ServerSpec): FakeServers => {
    const source = new FakeServers(this.tools.get(spec.name) ?? []);
    const failure = this.failures.get(spec.name);
    if (failure !== undefined) {
      source.failOpens = 1;
      source.failMessage = failure;
    }
    this.sources.set(spec.name, [...(this.sources.get(spec.name) ?? []), source]);
    return source;
  };

  latest(name: string): FakeServers {
    const source = this.sources.get(name)?.at(-1);
    if (!source) throw new Error(`no source for ${name}`);
    return source;
  }
}

const managers: ConnectorManager[] = [];

function manager(servers: Record<string, unknown>, farm: Farm): ConnectorManager {
  const created = new ConnectorManager(
    config(servers),
    { retry: FAST_RETRY, env: {} },
    farm.create,
  );
  managers.push(created);
  return created;
}

function config(servers: Record<string, unknown>): ConnectorsConfig {
  return { mcpServers: servers } as ConnectorsConfig;
}

function statusOf(source: ConnectorManager, name: string): ConnectorStatus | undefined {
  return source.status().find((status) => status.name === name);
}

function byName(tools: ToolSpec[], name: string): ToolSpec {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}; have ${tools.map((t) => t.name).join(", ")}`);
  return tool;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.dispose()));
});

describe("ConnectorManager", () => {
  it("connects enabled servers lazily and reports failures without throwing", async () => {
    const farm = new Farm();
    farm.tools.set("alpha", [fakeTool("search"), fakeTool("create")]);
    farm.tools.set("beta", [fakeTool("ping")]);
    farm.failures.set("beta", "fake server is down");
    const m = manager(
      {
        alpha: { command: "fake" },
        beta: { command: "fake" },
        off: { command: "fake", enabled: false },
        broken: { command: 42 },
        offBroken: { command: 42, enabled: false },
      },
      farm,
    );
    expect(m.status()).toEqual([
      { name: "alpha", transport: "stdio", state: "idle", toolCount: 0 },
      { name: "beta", transport: "stdio", state: "idle", toolCount: 0 },
      { name: "off", transport: "stdio", state: "disabled", toolCount: 0 },
      {
        name: "broken",
        transport: "stdio",
        state: "error",
        toolCount: 0,
        error: 'Invalid config: "command" must be a string (got number)',
      },
      { name: "offBroken", transport: "stdio", state: "disabled", toolCount: 0 },
    ]);
    expect(farm.sources.has("off")).toBe(false);

    const [tools] = await Promise.all([m.getTools(), m.getTools()]);
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__alpha__create", "mcp__alpha__search"]);
    expect(farm.latest("alpha").opens).toBe(1);
    expect(statusOf(m, "alpha")).toEqual({
      name: "alpha",
      transport: "stdio",
      state: "connected",
      toolCount: 2,
    });
    expect(statusOf(m, "beta")).toEqual({
      name: "beta",
      transport: "stdio",
      state: "error",
      toolCount: 0,
      error: "fake server is down",
    });
    expect(await m.getTools()).toBe(tools);
  });

  it("gives every tool a unique, provider-safe name", async () => {
    const farm = new Farm();
    farm.tools.set("files", [
      fakeTool("read.file"),
      fakeTool("read_file"),
      fakeTool("x".repeat(80)),
    ]);
    farm.tools.set("Files", [fakeTool("read_file")]);
    const m = manager({ files: { command: "fake" }, Files: { command: "fake" } }, farm);
    const names = (await m.getTools()).map((tool) => tool.name);
    expect(names).toHaveLength(4);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(4);
    for (const name of names) expect(name).toMatch(TOOL_NAME_RE);
    expect(names).toContain("mcp__Files__read_file");
  });

  it("applies toolFilter to tools, status counts and calls", async () => {
    const farm = new Farm();
    farm.tools.set("svc", [fakeTool("read_a"), fakeTool("read_secret"), fakeTool("write_a")]);
    const m = manager(
      { svc: { command: "fake", toolFilter: { include: ["read_*"], exclude: ["read_secret"] } } },
      farm,
    );
    const tools = await m.getTools();
    expect(tools.map((tool) => tool.name)).toEqual(["mcp__svc__read_a"]);
    expect(statusOf(m, "svc")?.toolCount).toBe(1);

    const readA = byName(tools, "mcp__svc__read_a");
    await m.reload(config({ svc: { command: "fake", toolFilter: { exclude: ["read_*"] } } }));
    expect(farm.sources.get("svc")).toHaveLength(1);
    await expect(readA.execute({}, ctx)).rejects.toThrow(
      'Tool "read_a" is excluded by the toolFilter of MCP server "svc"',
    );
    expect((await m.getTools()).map((tool) => tool.name)).toEqual(["mcp__svc__write_a"]);
    expect(farm.latest("svc").calls).toEqual([]);
  });

  it("maps annotations to safety hints and applies approval changes to existing specs", async () => {
    const farm = new Farm();
    farm.tools.set("mail", [
      fakeTool("list_messages", { annotations: { readOnlyHint: true } }),
      fakeTool("send_message"),
    ]);
    const m = manager({ mail: { command: "fake", approval: "writes" } }, farm);
    const tools = await m.getTools();
    const list = byName(tools, "mcp__mail__list_messages");
    const send = byName(tools, "mcp__mail__send_message");
    expect(list.safety).toMatchObject({ readOnly: true, destructive: false, openWorld: true });
    expect(list.safety.alwaysRequireApproval).toBe(false);
    expect(send.safety).toMatchObject({ readOnly: false, destructive: true, openWorld: true });
    expect(send.safety.alwaysRequireApproval).toBe(true);
    expect(send.safety.describe?.({ to: "sam@example.com", subject: "Hi" })).toBe(
      'mail · send_message(to: "sam@example.com", subject: "Hi")',
    );

    await m.reload(config({ mail: { command: "fake", approval: "always" } }));
    expect(farm.sources.get("mail")).toHaveLength(1);
    expect(list.safety.alwaysRequireApproval).toBe(true);

    await m.reload(config({}));
    expect(list.safety.alwaysRequireApproval).toBe(true);
    await expect(send.execute({}, ctx)).rejects.toBeInstanceOf(McpUnavailableError);
  });

  it("executes tools end to end and returns server errors as error results", async () => {
    const farm = new Farm();
    farm.tools.set("calc", [
      fakeTool("add", {}, (args) => {
        const sum = Number(args.a) + Number(args.b);
        return { content: [{ type: "text", text: String(sum) }], structuredContent: { sum } };
      }),
    ]);
    const m = manager({ calc: { command: "fake", description: "Arithmetic" } }, farm);
    const add = byName(await m.getTools(), "mcp__calc__add");
    expect(add.description).toBe('[calc: Arithmetic] Tool "add" from MCP server "calc".');
    await expect(add.execute({ a: 2, b: 3 }, ctx)).resolves.toEqual({
      content: [{ type: "text", text: "5" }],
      details: { server: "calc", tool: "add", structuredContent: { sum: 5 } },
    });

    farm.latest("calc").tools = [];
    const result = await add.execute({ a: 1, b: 1 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: 'MCP server "calc" returned error -32602: Unknown tool: add' },
    ]);
  });

  it("reload keeps unchanged servers, restarts changed ones and closes removed ones", async () => {
    const farm = new Farm();
    for (const name of ["keep", "change", "gone", "added"]) farm.tools.set(name, [fakeTool(name)]);
    const m = manager(
      {
        keep: { command: "fake" },
        change: { command: "fake", args: ["v1"] },
        gone: { command: "fake" },
      },
      farm,
    );
    await m.getTools();
    let goneClosed = false;
    farm.latest("gone").latest.onclose = () => {
      goneClosed = true;
    };

    await m.reload(
      config({
        keep: { command: "fake", description: "same process" },
        change: { command: "fake", args: ["v2"] },
        added: { command: "fake" },
      }),
    );
    expect(goneClosed).toBe(true);
    expect(farm.sources.get("keep")).toHaveLength(1);
    expect(farm.sources.get("change")).toHaveLength(2);
    expect(m.status().map((status) => status.name)).toEqual(["keep", "change", "added"]);
    await waitFor(
      () =>
        statusOf(m, "added")?.state === "connected" && statusOf(m, "change")?.state === "connected",
      "background connections after reload",
    );
    const tools = await m.getTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp__added__added",
      "mcp__change__change",
      "mcp__keep__keep",
    ]);
    expect(byName(tools, "mcp__keep__keep").description).toBe(
      '[keep: same process] Tool "keep" from MCP server "keep".',
    );
  });

  it("keeps offering a reconnecting server's tools and recovers transparently", async () => {
    const farm = new Farm();
    farm.tools.set("a", [fakeTool("x")]);
    const m = manager({ a: { command: "fake" } }, farm);
    const [x] = await m.getTools();
    await farm.latest("a").crash();
    expect(statusOf(m, "a")).toMatchObject({ state: "connecting", toolCount: 1 });
    expect(statusOf(m, "a")?.error).toContain('MCP server "a" disconnected');
    expect(await m.getTools()).toHaveLength(1);
    await waitFor(() => statusOf(m, "a")?.state === "connected", "reconnected");
    await expect(x?.execute({}, ctx)).resolves.toMatchObject({ content: [{ text: "called x" }] });
  });

  it("emits coalesced, de-duplicated status updates and isolates listener failures", async () => {
    const farm = new Farm();
    farm.tools.set("a", [fakeTool("x")]);
    const m = manager({ a: { command: "fake" } }, farm);
    const seen: string[] = [];
    m.onStatus(() => {
      throw new Error("listener bug");
    });
    const unsubscribe = m.onStatus((status) =>
      seen.push(status.map((s) => `${s.name}:${s.state}`).join(",")),
    );
    await m.getTools();
    await waitFor(() => seen.at(-1) === "a:connected", "connected status");
    expect(seen).toEqual(["a:connecting", "a:connected"]);

    unsubscribe();
    await m.reload(config({ a: { command: "fake" }, b: { command: "fake", enabled: false } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(2);
  });

  it("masks secrets in status errors", async () => {
    const farm = new Farm();
    const fakeKey = ["sk", "-", "a".repeat(24)].join("");
    farm.failures.set("leaky", `upstream rejected key ${fakeKey}`);
    const m = manager({ leaky: { command: "fake" } }, farm);
    await m.getTools();
    expect(statusOf(m, "leaky")?.error).toBe("upstream rejected key •••");
  });

  it("dispose closes every connection and leaves nothing callable", async () => {
    const farm = new Farm();
    farm.tools.set("a", [fakeTool("x")]);
    const m = manager({ a: { command: "fake" } }, farm);
    const [x] = await m.getTools();
    let closed = false;
    farm.latest("a").latest.onclose = () => {
      closed = true;
    };
    await m.dispose();
    await m.dispose();
    expect(closed).toBe(true);
    expect(m.status()).toEqual([]);
    expect(await m.getTools()).toEqual([]);
    expect(x?.safety.alwaysRequireApproval).toBe(true);
    await expect(x?.execute({}, ctx)).rejects.toBeInstanceOf(McpUnavailableError);
  });
});
