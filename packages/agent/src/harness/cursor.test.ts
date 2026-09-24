/**
 * Drives the real Cursor harness — ACP client, MCP bridge, tool runner, permission routing,
 * policy monitor, suspend/resume — against a deterministic fake of the Cursor CLI that speaks the
 * same protocol and calls our MCP endpoint like the real one. No network, no real CLI.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_CURSOR_MODEL,
  deferred,
  type Logger,
  silentLogger,
  type ToolSpec,
  textResult,
} from "@ddl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellExecOptions, ShellExecutor } from "../execution/types";
import { createCursorHarness } from "./cursor";
import { CursorHarness, type CursorHarnessOptions } from "./cursor/harness";
import type { HarnessEvent, HarnessSession, HarnessSessionOptions, ToolCallRequest } from "./types";

const FAKE_CLI = fileURLToPath(new URL("./cursor/testing/fake-cursor-cli.ts", import.meta.url));
/** Every test starts the fake CLI as a process; a loaded machine can take seconds to do that. */
const SPAWN_TIMEOUT_MS = 30_000;
const cleanup: string[] = [];
const sessions: HarnessSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.dispose().catch(() => {})));
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

interface Setup {
  harness: CursorHarness;
  home: string;
  cwd: string;
  userHome: string;
  events: HarnessEvent[];
  gateCalls: ToolCallRequest[];
  create(overrides?: Partial<HarnessSessionOptions>): Promise<HarnessSession>;
}

async function setup(
  options: { flags?: string[]; harness?: Partial<CursorHarnessOptions>; userMcp?: unknown } = {},
): Promise<Setup> {
  const home = await tempDir("ddl-cursor-home-");
  const cwd = await tempDir("ddl-cursor-cwd-");
  const userHome = await tempDir("ddl-cursor-user-");
  if (options.userMcp !== undefined) {
    await mkdir(path.join(userHome, ".cursor"), { recursive: true });
    await writeFile(path.join(userHome, ".cursor", "mcp.json"), JSON.stringify(options.userMcp));
  }
  const harness = new CursorHarness({
    home,
    binary: process.execPath,
    binaryArgs: [FAKE_CLI, ...(options.flags ?? [])],
    env: {
      PATH: process.env.PATH,
      HOME: userHome,
      LANG: "en_US.UTF-8",
      OPENROUTER_API_KEY: "must-not-leak",
      CURSOR_API_KEY: "must-not-leak",
    },
    userHome,
    idleTimeoutMs: 0,
    requestTimeoutMs: 15_000,
    cancelGraceMs: 400,
    ...options.harness,
  });
  const events: HarnessEvent[] = [];
  const gateCalls: ToolCallRequest[] = [];
  return {
    harness,
    home,
    cwd,
    userHome,
    events,
    gateCalls,
    create: async (overrides = {}) => {
      const session = await harness.createSession({
        sessionId: "thr_test",
        role: "subagent",
        systemPrompt: "You are a careful test agent.",
        tools: [],
        model: "composer-2.5",
        cwd,
        beforeToolCall: async (call) => {
          gateCalls.push(call);
          return { allow: true };
        },
        onEvent: (event) => events.push(event),
        ...overrides,
      });
      sessions.push(session);
      return session;
    },
  };
}

function tool(name: string, execute: ToolSpec["execute"], extra: Partial<ToolSpec> = {}): ToolSpec {
  return {
    name,
    label: name,
    description: `The ${name} tool`,
    parameters: { type: "object", properties: { text: { type: "string" } } },
    safety: { readOnly: true },
    execute,
    ...extra,
  };
}

const types = (events: HarnessEvent[]) => events.map((e) => e.type);
const texts = (events: HarnessEvent[]) =>
  events.flatMap((e) => (e.type === "message_end" ? [e.text] : []));
const lastText = (events: HarnessEvent[]) => texts(events).at(-1) ?? "";
const errors = (events: HarnessEvent[]) =>
  events.flatMap((e) => (e.type === "error" ? [e.message] : []));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 4_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function pidsIn(file: string): Promise<number[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map(Number);
}

describe("createCursorHarness", () => {
  it("validates its options", () => {
    expect(() => createCursorHarness({ home: "" })).toThrow(/home/);
    expect(createCursorHarness({ home: "/tmp/x" }).name).toBe("cursor");
  });
});

describe("CursorHarness (fake CLI)", { timeout: SPAWN_TIMEOUT_MS }, () => {
  it("streams a reply bracketed by turn_start/idle with stable message ids", async () => {
    const s = await setup();
    const session = await s.create();
    await session.prompt("!think Let me think.\n!say Hello from Cursor");
    expect(types(s.events)[0]).toBe("turn_start");
    expect(s.events.at(-1)).toEqual({ type: "idle" });
    const end = s.events.find((e) => e.type === "message_end");
    expect(end).toMatchObject({ text: "Hello from Cursor" });
    expect(s.events.filter((e) => e.type === "text_delta")).toHaveLength(2);
    const ids = s.events.flatMap((e) =>
      e.type === "text_delta" || e.type === "thinking_delta" ? [e.messageId] : [],
    );
    expect(ids).toHaveLength(3);
    expect(new Set(ids)).toEqual(new Set([end?.type === "message_end" ? end.messageId : "?"]));
    expect(session.isRunning).toBe(false);
  });

  it("writes the system prompt, tool guidance and a deny-everything CLI config", async () => {
    const s = await setup({
      userMcp: { mcpServers: { "notes-app": { url: "https://example.com/mcp" } } },
    });
    const guided = tool("echo", async () => textResult("x"), {
      promptGuidelines: ["Only echo short text."],
    });
    const session = await s.create({ tools: [guided] });
    await session.prompt("!agents");
    const agentsMd = lastText(s.events);
    expect(agentsMd.startsWith("You are a careful test agent.")).toBe(true);
    expect(agentsMd).toContain("Use only the tools of the `ddl` MCP server: echo.");
    expect(agentsMd).toContain("- echo: Only echo short text.");
    expect(agentsMd).toContain("You have no web access");

    await session.prompt("!cli");
    const configs = JSON.parse(lastText(s.events)) as {
      project: { permissions: { allow: string[]; deny: string[] } };
      global: Record<string, unknown> & { permissions: { allow: string[]; deny: string[] } };
    };
    for (const permissions of [configs.project.permissions, configs.global.permissions]) {
      expect(permissions.allow).toEqual(["Mcp(ddl:*)"]);
      expect(permissions.deny).toEqual(
        expect.arrayContaining([
          "Read(**)",
          "Write(**)",
          "Shell(*)",
          "WebFetch(*)",
          "Mcp(notes-app:*)",
        ]),
      );
      expect(permissions.deny).not.toContain("Mcp(ddl:*)");
    }
    expect(configs.global).toMatchObject({ approvalMode: "allowlist", autoAcceptWebSearch: false });

    await session.prompt("!list");
    expect(lastText(s.events)).toBe("tools: echo");
  });

  it("gives the CLI a minimal environment and private config dirs", async () => {
    const s = await setup();
    const session = await s.create();
    await session.prompt("!env");
    const env = JSON.parse(lastText(s.events)) as { keys: string[]; config: string; data: string };
    expect(env.keys).not.toContain("OPENROUTER_API_KEY");
    expect(env.keys).not.toContain("CURSOR_API_KEY");
    expect(env.keys).toEqual(
      expect.arrayContaining(["PATH", "HOME", "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR"]),
    );
    expect(env.config).toBe(path.join(s.home, "cursor", "config"));
    expect(env.data.startsWith(path.join(s.home, "cursor", "sessions"))).toBe(true);
  });

  it("runs custom tools through the gate with their spec, reporting each call once", async () => {
    const echo = tool("echo", async (input) =>
      textResult(`echo: ${(input as { text: string }).text}`),
    );
    const s = await setup();
    const session = await s.create({ tools: [echo] });
    await session.prompt('!call echo {"text":"hi"}');
    expect(s.gateCalls).toEqual([
      {
        sessionId: "thr_test",
        role: "subagent",
        toolCallId: expect.stringMatching(/^call_/),
        toolName: "echo",
        input: { text: "hi" },
        spec: echo,
      },
    ]);
    expect(s.events.filter((e) => e.type === "tool_start")).toHaveLength(1);
    expect(s.events.find((e) => e.type === "tool_end")).toEqual({
      type: "tool_end",
      toolCallId: s.gateCalls[0]?.toolCallId,
      toolName: "echo",
      result: { content: [{ type: "text", text: "echo: hi" }] },
      isError: false,
    });
    expect(lastText(s.events)).toBe("result(echo): echo: hi");
  });

  it("never executes calls the gate denies, and tells the model why", async () => {
    const execute = vi.fn(async () => textResult("deleted"));
    const s = await setup();
    const session = await s.create({
      tools: [tool("delete_everything", execute, { safety: { destructive: true } })],
      beforeToolCall: async () => ({ allow: false, reason: "destructive actions need approval" }),
    });
    await session.prompt("!call delete_everything {}");
    expect(execute).not.toHaveBeenCalled();
    expect(s.events.find((e) => e.type === "tool_end")).toMatchObject({
      toolName: "delete_everything",
      isError: true,
      blocked: true,
    });
    expect(lastText(s.events)).toBe(
      "result(delete_everything) error: Blocked by safety policy: destructive actions need approval",
    );
  });

  it("fails closed when the gate throws and rejects invalid arguments before the gate", async () => {
    const execute = vi.fn(async () => textResult("ran"));
    const strict = tool("strict", execute, {
      parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
    });
    const s = await setup();
    const gate = vi.fn(async (): Promise<{ allow: true }> => {
      throw new Error("evaluator crashed");
    });
    const session = await s.create({ tools: [strict], beforeToolCall: gate });
    await session.prompt('!call strict {"wrong":true}');
    expect(gate).not.toHaveBeenCalled();
    expect(lastText(s.events)).toMatch(
      /^result\(strict\) error: Invalid arguments for strict: n: is required/,
    );
    await session.prompt('!call strict {"n":1}');
    expect(gate).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(lastText(s.events)).toBe(
      "result(strict) error: Blocked by safety policy: the safety check failed",
    );
  });

  it("serves the built-in file and shell tools, confined and gated without a spec", async () => {
    const exec = vi.fn(async (_command: string, options: ShellExecOptions) => {
      options.onData?.("hello\n");
      return { exitCode: 0, output: "hello\n", timedOut: false, truncated: false, durationMs: 2 };
    });
    const shell: ShellExecutor = { exec };
    const s = await setup();
    await writeFile(
      path.join(path.dirname(s.cwd), `outside-${path.basename(s.cwd)}.txt`),
      "private",
    );
    cleanup.push(path.join(path.dirname(s.cwd), `outside-${path.basename(s.cwd)}.txt`));
    const session = await s.create({ builtinTools: { files: true, shell } });
    await session.prompt("!list");
    expect(lastText(s.events)).toBe("tools: read,write,edit,bash");
    await session.prompt('!call write {"path":"notes/a.txt","content":"one two"}');
    expect(await readFile(path.join(s.cwd, "notes", "a.txt"), "utf8")).toBe("one two");
    await session.prompt(
      '!call edit {"path":"notes/a.txt","edits":[{"oldText":"two","newText":"three"}]}',
    );
    expect(await readFile(path.join(s.cwd, "notes", "a.txt"), "utf8")).toBe("one three");
    await session.prompt(`!call read {"path":"../outside-${path.basename(s.cwd)}.txt"}`);
    expect(lastText(s.events)).toMatch(/error: Access denied: .* is outside the task workspace/);
    await session.prompt('!call bash {"command":"echo hello"}');
    expect(lastText(s.events)).toBe("result(bash): hello");
    expect(exec).toHaveBeenCalledWith("echo hello", expect.objectContaining({ cwd: s.cwd }));
    expect(exec.mock.calls[0]?.[1]).not.toHaveProperty("env");
    expect(s.events.some((e) => e.type === "tool_update")).toBe(true);
    const names = s.gateCalls.map((c) => c.toolName);
    expect(names).toEqual(["write", "edit", "read", "bash"]);
    for (const call of s.gateCalls) expect(call).not.toHaveProperty("spec");
  });

  it("routes the CLI's web search and fetch through the gate as web_search / web_fetch", async () => {
    const webFetch = tool("web_fetch", async () => textResult("page"));
    const s = await setup();
    const decisions = [
      { allow: true as const },
      { allow: false as const, reason: "local address" },
    ];
    const session = await s.create({
      tools: [webFetch],
      beforeToolCall: async (call) => {
        s.gateCalls.push(call);
        return decisions.shift() ?? { allow: false, reason: "no" };
      },
    });
    await session.prompt("!websearch standing desks");
    expect(lastText(s.events)).toBe("websearch: allow-once");
    await session.prompt("!webfetch http://127.0.0.1:7331/api");
    expect(lastText(s.events)).toBe("webfetch: reject-once");
    expect(s.gateCalls.map(({ toolName, input, spec }) => ({ toolName, input, spec }))).toEqual([
      { toolName: "web_search", input: { query: "standing desks" }, spec: undefined },
      { toolName: "web_fetch", input: { url: "http://127.0.0.1:7331/api" }, spec: undefined },
    ]);
    const ends = s.events.filter((e) => e.type === "tool_end");
    expect(ends[0]).toMatchObject({ toolName: "web_search", isError: false });
    expect(ends[0]?.type === "tool_end" && ends[0].result.content[0]).toMatchObject({
      text: "Cursor's web search returned 3 result(s)",
    });
    expect(ends[1]).toMatchObject({ toolName: "web_fetch", blocked: true, isError: true });
    expect(errors(s.events)).toEqual([]);
  });

  it("refuses the CLI's web requests when the agent has no web tools", async () => {
    const s = await setup();
    const session = await s.create();
    await session.prompt("!websearch anything");
    expect(lastText(s.events)).toBe("websearch: reject-once");
    expect(s.gateCalls).toEqual([]);
    expect(s.events.find((e) => e.type === "tool_end")).toMatchObject({ blocked: true });
  });

  it("rejects other permission requests, even ones titled like our MCP calls", async () => {
    const s = await setup({ flags: ["--fake-ask-mcp"] });
    const session = await s.create({ tools: [tool("echo", async () => textResult("echoed"))] });
    await session.prompt("!permission other | ddl-echo: echo");
    expect(lastText(s.events)).toBe("permission: reject-once");
    await session.prompt("!permission execute | `rm -rf /`");
    expect(lastText(s.events)).toBe("permission: reject-once");
    await session.prompt("!call echo {}");
    expect(lastText(s.events)).toBe("result(echo): echoed");
    expect(s.gateCalls.map((c) => c.toolName)).toEqual(["echo"]);
  });

  it("stops the session when a disabled built-in produces a result", async () => {
    const s = await setup();
    const session = await s.create();
    await session.prompt(
      '!builtin read | Read /etc/hosts | {"path":"/etc/hosts"} | -\n!say still here',
    );
    expect(lastText(s.events)).toBe("still here");
    await session.prompt("!todo\n!say todos are fine");
    expect(lastText(s.events)).toBe("todos are fine");
    expect(errors(s.events)).toEqual([]);

    await session.prompt(
      '!builtin execute | `echo hi` | {"command":"echo hi"} | {"exitCode":0,"stdout":"hi\\n","stderr":""}\n!sleep 2000\n!say too late',
    );
    expect(errors(s.events)).toEqual([
      "Cursor ran a built-in tool that this harness disables (execute: `echo hi`); the session was stopped",
    ]);
    expect(texts(s.events)).not.toContain("too late");
    await expect(session.prompt("!say again")).rejects.toThrow(/the session was stopped/);
  });

  it("queues prompts sent while a run is in progress", async () => {
    const s = await setup();
    const session = await s.create();
    const first = session.prompt("!stream 5 20");
    expect(session.isRunning).toBe(true);
    const second = session.prompt("!say two");
    await Promise.all([first, second]);
    expect(types(s.events).filter((t) => t === "turn_start" || t === "idle")).toEqual([
      "turn_start",
      "idle",
      "turn_start",
      "idle",
    ]);
    expect(lastText(s.events)).toBe("two");
    expect(session.isRunning).toBe(false);
  });

  it("delivers steering at the next turn boundary within the same run", async () => {
    const s = await setup();
    const session = await s.create();
    const run = session.prompt("!sleep 150\n!say first");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await session.steer("!say steered");
    await run;
    expect(texts(s.events)).toEqual(["first", "steered"]);
    expect(types(s.events).filter((t) => t === "turn_start")).toHaveLength(1);
    await session.steer("!say idle steer");
    expect(lastText(s.events)).toBe("idle steer");
  });

  it("aborts the current run; the prompt resolves and the session stays usable", async () => {
    const s = await setup();
    const session = await s.create();
    const run = session.prompt("!stream 200 20");
    await waitFor(() => s.events.some((e) => e.type === "text_delta"));
    await session.abort();
    await run;
    expect(s.events.at(-1)).toEqual({ type: "idle" });
    expect(errors(s.events)).toEqual([]);
    await session.prompt("!say again");
    expect(lastText(s.events)).toBe("again");

    const before = s.events.length;
    const early = session.prompt("!say should not run");
    await session.abort();
    await early;
    expect(texts(s.events.slice(before))).toEqual([]);
  });

  it("stops a CLI that ignores cancel, then resumes the session", async () => {
    const s = await setup();
    const session = await s.create();
    await session.prompt("!say remember me");
    const run = session.prompt("!hang");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await session.abort();
    await run;
    expect(errors(s.events)).toEqual([]);
    await session.prompt("!model");
    expect(lastText(s.events)).toBe("model: composer-2.5[fast=true]");
  });

  it("records the CLI process in the session folder, for a later daemon's cleanup", async () => {
    const s = await setup();
    await s.create();
    const sessions = path.join(s.home, "cursor", "sessions");
    const [name] = await readdir(sessions);
    const pidFile = path.join(sessions, name!, "cli.pid");
    await expect
      .poll(() => readFile(pidFile, "utf8").catch(() => ""), { timeout: 5_000 })
      .toMatch(/^\d+\n$/);
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  it("runs the default model, and a variant agent mode can't select as its preset", async () => {
    const warnings: Array<Record<string, unknown> | undefined> = [];
    const logger: Logger = {
      ...silentLogger,
      warn: (_message, fields) => warnings.push(fields),
      child: () => logger,
    };
    const s = await setup({ harness: { logger } });
    const session = await s.create({ model: DEFAULT_CURSOR_MODEL });
    await session.prompt("!model");
    expect(lastText(s.events)).toBe(
      "model: claude-opus-5-5[context=300k,effort=medium,fast=false]",
    );
    expect(warnings).toEqual([]);
    const variant = await s.create({
      sessionId: "thr_variant",
      model: "claude-opus-5-5-high-fast",
    });
    await variant.prompt("!model");
    expect(lastText(s.events)).toBe(
      "model: claude-opus-5-5[context=300k,effort=medium,fast=false]",
    );
    expect(warnings).toContainEqual({
      configured: "claude-opus-5-5-high-fast",
      running: "claude-opus-5-5[context=300k,effort=medium,fast=false]",
    });
  });

  it("reports a CLI crash mid-turn and resumes with the next prompt", async () => {
    const s = await setup();
    const session = await s.create({ model: "gpt-5.5" });
    await session.prompt("!crash");
    expect(errors(s.events)).toEqual([
      expect.stringMatching(/The Cursor CLI exited \(code 3\).*resumes/),
    ]);
    expect(s.events.at(-1)).toEqual({ type: "idle" });
    await session.prompt("!model");
    expect(lastText(s.events)).toBe("model: gpt-5.5[context=272k,reasoning=medium,fast=false]");
  });

  it("suspends idle sessions and resumes them without replaying history as events", async () => {
    const pids = path.join(await tempDir("ddl-cursor-pids-"), "pids.txt");
    const s = await setup({ flags: [`--fake-pids=${pids}`], harness: { idleTimeoutMs: 60 } });
    const session = await s.create();
    await session.prompt("!say one");
    const [first] = await pidsIn(pids);
    await waitFor(() => !alive(first!));
    const before = s.events.length;
    await session.prompt("!say two");
    expect(texts(s.events.slice(before))).toEqual(["two"]);
    expect(await pidsIn(pids)).toHaveLength(2);
  });

  it("dispose ends the CLI's process group and removes the session's files", async () => {
    const pids = path.join(await tempDir("ddl-cursor-pids-"), "pids.txt");
    const s = await setup({ flags: [`--fake-pids=${pids}`, "--fake-helper"] });
    const session = await s.create();
    await session.prompt("!say hi");
    const started = await pidsIn(pids);
    expect(started).toHaveLength(2);
    expect(await readdir(path.join(s.home, "cursor", "sessions"))).toHaveLength(1);
    await session.dispose();
    await session.dispose();
    await waitFor(() => started.every((pid) => !alive(pid)));
    expect(await readdir(path.join(s.home, "cursor", "sessions"))).toEqual([]);
    expect(await readdir(path.join(s.home, "cursor", "config", "acp-sessions"))).toEqual([]);
    const count = s.events.length;
    await session.prompt("ignored");
    await session.steer("ignored");
    expect(s.events.length).toBe(count);
  });

  it("disposes the session when its signal aborts", async () => {
    const controller = new AbortController();
    const s = await setup();
    const session = await s.create({ signal: controller.signal });
    const run = session.prompt("!stream 500 10");
    await waitFor(() => s.events.some((e) => e.type === "text_delta"));
    controller.abort();
    await run;
    await waitFor(
      async () => (await readdir(path.join(s.home, "cursor", "sessions"))).length === 0,
    );
    await expect(s.create({ signal: controller.signal })).rejects.toThrow(/aborted/);
  });

  it("answers long calls as still running and delivers the result in the same run", async () => {
    const release = deferred<void>();
    const slow = tool(
      "slow",
      async () => {
        await release.promise;
        return textResult("slow done");
      },
      { safety: {} },
    );
    const s = await setup({ harness: { detachAfterMs: 100 } });
    const session = await s.create({ tools: [slow] });
    let resolved = false;
    const run = session.prompt("!call slow {}").then(() => {
      resolved = true;
    });
    await waitFor(() => texts(s.events).some((t) => t.includes("still running")));
    expect(resolved).toBe(false);
    release.resolve();
    await run;
    expect(lastText(s.events)).toMatch(
      /^ok: \[Result of slow \(call call_\w+\), which was still running earlier\]\nslow done/,
    );
    expect(s.events.find((e) => e.type === "tool_end")).toMatchObject({
      toolName: "slow",
      isError: false,
    });
    expect(types(s.events).filter((t) => t === "turn_start")).toHaveLength(1);
  });

  it("resolves the model by id, display name or preset, and explains unknown ones", async () => {
    const s = await setup();
    const byName = await s.create({ model: "Sonnet 4.6" });
    await byName.prompt("!model");
    expect(lastText(s.events)).toBe("model: sonnet-4.6[thinking=true]");
    const withParams = await s.create({ model: "gpt-5.5[reasoning=high]" });
    await withParams.prompt("!model");
    expect(lastText(s.events)).toBe("model: gpt-5.5[context=272k,reasoning=medium,fast=false]");
    await expect(s.create({ model: "no-such-model" })).rejects.toThrow(
      /"no-such-model" isn't available.*composer-2\.5, gpt-5\.5, claude-opus-5-5, sonnet-4\.6/,
    );
    expect(await readdir(path.join(s.home, "cursor", "sessions"))).toHaveLength(2);
  });

  it("fails session creation clearly when the CLI can't be used", async () => {
    const cases: Array<[string[], RegExp]> = [
      [["--fake-no-http"], /can't connect to HTTP MCP servers/],
      [["--fake-protocol=2"], /ACP version 2/],
      [["--fake-new-error"], /not signed in or its login expired.*agent login/],
    ];
    for (const [flags, message] of cases) {
      const s = await setup({ flags });
      await expect(s.create()).rejects.toThrow(message);
      expect(await readdir(path.join(s.home, "cursor", "sessions"))).toEqual([]);
    }
    const missing = await setup({ harness: { binary: "/nonexistent/agent" } });
    await expect(missing.create()).rejects.toThrow(/Cursor CLI is not installed/);
  });

  it("rejects invalid or conflicting tool sets", async () => {
    const s = await setup();
    const echo = tool("echo", async () => textResult("x"));
    await expect(s.create({ tools: [echo, echo] })).rejects.toThrow(/Duplicate/);
    await expect(s.create({ tools: [tool("bad name!", echo.execute)] })).rejects.toThrow(
      /Invalid tool name/,
    );
    await expect(
      s.create({
        tools: [tool("bash", echo.execute)],
        builtinTools: { files: false, shell: { exec: vi.fn() } },
      }),
    ).rejects.toThrow(/conflicts/);
    await expect(
      s.create({ tools: [tool("weird", echo.execute, { parameters: { type: "array" } })] }),
    ).rejects.toThrow(/object schema/);
  });

  it("keeps running when an event listener throws", async () => {
    const s = await setup();
    const session = await s.create({
      onEvent: () => {
        throw new Error("listener bug");
      },
    });
    await expect(session.prompt("!say fine")).resolves.toBeUndefined();
  });

  it("removes stale session files at start and closes the bridge on dispose", async () => {
    const s = await setup();
    const stale = path.join(s.home, "cursor", "sessions", "old-session-1234");
    await mkdir(stale, { recursive: true });
    await mkdir(path.join(s.home, "cursor", "config", "acp-sessions", "stale-id"), {
      recursive: true,
    });
    const session = await s.create();
    const entries = await readdir(path.join(s.home, "cursor", "sessions"));
    expect(entries).not.toContain("old-session-1234");
    expect(entries).toHaveLength(1);
    expect(await readdir(path.join(s.home, "cursor", "config", "acp-sessions"))).not.toContain(
      "stale-id",
    );
    await s.harness.dispose();
    await session.prompt("!say still works until disposed");
    expect(lastText(s.events)).toBe("still works until disposed");
    await session.dispose();
    await expect(s.create()).rejects.toThrow(/replaced/);
  });
});
