// biome-ignore-all lint/suspicious/noTemplateCurlyInString: some strings are connector config placeholders, not template literals.
/**
 * Process-lifecycle tests against a real stdio MCP server (`fixtures/echo-server.mjs`).
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ConnectorStatus, silentLogger, type ToolResult, type ToolSpec } from "@ddl/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseServerConfig, type ServerSpec } from "../src/config";
import { McpConnection } from "../src/connection";
import { McpTimeoutError, McpTransportError, McpUnavailableError } from "../src/errors";
import { createConnectorManager } from "../src/manager";
import { createTransportSource } from "../src/transports";
import type { ConnectorsConfig, ConnectorToolSource } from "../src/types";
import { isProcessAlive, waitFor } from "./support/wait";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const FAST_RETRY = {
  maxReconnectAttempts: 2,
  baseDelayMs: 20,
  maxDelayMs: 50,
  jitter: 0,
  cooldownMs: 60_000,
};
const SLOW = { timeout: 20_000 };
const ctx = { toolCallId: "call-1" };

let dir: string;
const cleanup: Array<() => Promise<void>> = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ddl-connectors-stdio-"));
});

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
  await rm(dir, { recursive: true, force: true });
});

function fixture(env: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return { command: process.execPath, args: [FIXTURE], env, ...extra };
}

function specOf(raw: unknown): ServerSpec {
  const parsed = parseServerConfig("srv", raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.spec;
}

function managed(
  servers: Record<string, unknown>,
  env: Record<string, string> = {},
): ConnectorToolSource {
  const source = createConnectorManager({ mcpServers: servers } as ConnectorsConfig, {
    env,
    retry: FAST_RETRY,
  });
  cleanup.push(() => source.dispose());
  return source;
}

function statusOf(source: ConnectorToolSource, name: string): ConnectorStatus | undefined {
  return source.status().find((status) => status.name === name);
}

function byName(tools: ToolSpec[], name: string): ToolSpec {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

function textOf(result: unknown): string {
  const content = (result as ToolResult).content;
  const first = content[0];
  return first?.type === "text" ? first.text : "";
}

/** Server name → pid, via each fixture's `pid` tool. */
async function pids(source: ConnectorToolSource): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const tool of await source.getTools()) {
    const match = /^mcp__(.+)__pid$/.exec(tool.name);
    if (match?.[1]) out[match[1]] = Number(textOf(await tool.execute({}, ctx)));
  }
  return out;
}

describe("stdio servers", () => {
  it("runs a server, captures its stderr and kills it on close", SLOW, async () => {
    const spec = specOf(fixture({ FIXTURE_LABEL: "one" }));
    const conn = new McpConnection({
      serverName: "srv",
      source: createTransportSource(spec, { env: {}, logger: silentLogger }),
      connectTimeoutMs: 10_000,
    });
    cleanup.push(() => conn.close());
    await conn.ready();
    expect(conn.state).toBe("connected");
    expect(conn.toolList?.map((tool) => tool.name)).toEqual(["echo", "pid", "env", "crash"]);
    expect(textOf(await conn.callTool("echo", { text: "hi" }, { timeoutMs: 5_000 }))).toBe(
      "one: hi",
    );
    const pid = Number(textOf(await conn.callTool("pid", {}, { timeoutMs: 5_000 })));
    expect(isProcessAlive(pid)).toBe(true);
    expect(conn.stderrTail()).toContain("fixture one started");

    await conn.close();
    await waitFor(() => !isProcessAlive(pid), "child process exit");
  });

  it(
    "gives the child only its configured variables plus the SDK's safe defaults",
    SLOW,
    async () => {
      process.env.DDL_CONNECTORS_TEST_PARENT_ONLY = "parent-only";
      cleanup.push(async () => {
        Reflect.deleteProperty(process.env, "DDL_CONNECTORS_TEST_PARENT_ONLY");
      });
      const source = managed(
        { echo: fixture({ FIXTURE_TOKEN: "${TEST_TOKEN}" }) },
        { TEST_TOKEN: "from-env" },
      );
      const env = byName(await source.getTools(), "mcp__echo__env");
      expect(textOf(await env.execute({ name: "FIXTURE_TOKEN" }, ctx))).toBe("from-env");
      expect(textOf(await env.execute({ name: "DDL_CONNECTORS_TEST_PARENT_ONLY" }, ctx))).toBe(
        "<unset>",
      );
      expect(textOf(await env.execute({ name: "PATH" }, ctx))).not.toBe("<unset>");
    },
  );

  it("reports config and launch problems per server while the others work", SLOW, async () => {
    const source = managed({
      missing: fixture({ TOKEN: "${DDL_CONNECTORS_TEST_MISSING}" }),
      nocmd: { command: "ddl-connectors-test-no-such-command" },
      badcwd: fixture({}, { cwd: join(dir, "does-not-exist") }),
      echo: fixture({ FIXTURE_LABEL: "ok" }),
    });
    const tools = await source.getTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp__echo__crash",
      "mcp__echo__echo",
      "mcp__echo__env",
      "mcp__echo__pid",
    ]);
    expect(statusOf(source, "missing")).toMatchObject({
      state: "error",
      error: "Environment variable not set: DDL_CONNECTORS_TEST_MISSING (in env.TOKEN)",
    });
    expect(statusOf(source, "nocmd")?.error).toMatch(
      /^Command not found: "ddl-connectors-test-no-such-command"/,
    );
    expect(statusOf(source, "badcwd")?.error).toMatch(/^"cwd" is not an existing directory/);
    expect(statusOf(source, "echo")).toMatchObject({ state: "connected", toolCount: 4 });
  });

  it(
    "restarts a crashed server; one that keeps crashing ends in error while others keep working",
    SLOW,
    async () => {
      const marker = join(dir, "crash-marker");
      const source = managed({
        flaky: fixture({ FIXTURE_LABEL: "flaky", FIXTURE_CRASH_MARKER: marker }),
        steady: fixture({ FIXTURE_LABEL: "steady" }),
      });
      const tools = await source.getTools();
      const crash = byName(tools, "mcp__flaky__crash");
      const flakyEcho = byName(tools, "mcp__flaky__echo");
      const steadyEcho = byName(tools, "mcp__steady__echo");

      await expect(crash.execute({}, ctx)).rejects.toBeInstanceOf(McpTransportError);
      await waitFor(() => statusOf(source, "flaky")?.state === "connected", "flaky restarted");
      expect(textOf(await flakyEcho.execute({ text: "back" }, ctx))).toBe("flaky: back");

      await expect(crash.execute({ persist: true }, ctx)).rejects.toBeInstanceOf(McpTransportError);
      await waitFor(() => statusOf(source, "flaky")?.state === "error", "flaky gave up");
      expect(statusOf(source, "flaky")?.error).toContain("refusing to start");
      expect(textOf(await steadyEcho.execute({ text: "still here" }, ctx))).toBe(
        "steady: still here",
      );
      expect((await source.getTools()).some((tool) => tool.name.startsWith("mcp__flaky__"))).toBe(
        false,
      );
      await expect(flakyEcho.execute({ text: "x" }, ctx)).rejects.toBeInstanceOf(
        McpUnavailableError,
      );
    },
  );

  it("kills a server that never finishes starting", SLOW, async () => {
    const pidFile = join(dir, "pid");
    const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const spec = specOf({ command: process.execPath, args: ["-e", script], connectTimeoutMs: 300 });
    const conn = new McpConnection({
      serverName: "mute",
      source: createTransportSource(spec, { env: {}, logger: silentLogger }),
      connectTimeoutMs: spec.connectTimeoutMs,
    });
    cleanup.push(() => conn.close());
    await conn.ready();
    expect(conn.state).toBe("error");
    expect(conn.lastError).toBeInstanceOf(McpTimeoutError);
    const pid = Number(await readFile(pidFile, "utf8"));
    await waitFor(() => !isProcessAlive(pid), "unresponsive process killed", 10_000);
  });

  it(
    "reload keeps unchanged processes, restarts changed ones and kills removed ones",
    SLOW,
    async () => {
      const source = managed({
        keep: fixture({ FIXTURE_LABEL: "keep" }),
        change: fixture({ FIXTURE_LABEL: "v1" }),
        gone: fixture({ FIXTURE_LABEL: "gone" }),
      });
      const before = await pids(source);
      await source.reload({
        mcpServers: {
          keep: { ...fixture({ FIXTURE_LABEL: "keep" }), approval: "always" },
          change: fixture({ FIXTURE_LABEL: "v2" }),
          added: fixture({ FIXTURE_LABEL: "added" }),
        },
      } as ConnectorsConfig);
      await waitFor(
        () => !isProcessAlive(before.gone ?? 0) && !isProcessAlive(before.change ?? 0),
        "old processes exited",
      );
      const after = await pids(source);
      expect(after.keep).toBe(before.keep);
      expect(after.change).not.toBe(before.change);
      expect(after.added).toBeGreaterThan(0);
      const tools = await source.getTools();
      expect(textOf(await byName(tools, "mcp__change__echo").execute({ text: "x" }, ctx))).toBe(
        "v2: x",
      );
      expect(byName(tools, "mcp__keep__echo").safety.alwaysRequireApproval).toBe(true);
    },
  );

  it("dispose kills every child process", SLOW, async () => {
    const source = managed({ a: fixture(), b: fixture() });
    const running = await pids(source);
    expect(Object.keys(running).sort()).toEqual(["a", "b"]);
    await source.dispose();
    await waitFor(
      () => Object.values(running).every((pid) => !isProcessAlive(pid)),
      "children exited",
    );
    expect(await source.getTools()).toEqual([]);
  });
});
