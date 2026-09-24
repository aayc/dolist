/** Shapes below are the ones the Cursor CLI (2026.09) reports over ACP, trimmed. */
import { describe, expect, it } from "vitest";
import {
  classifyToolCall,
  findViolation,
  hasResult,
  type MonitorContext,
  ToolCallTracker,
  type TrackedToolCall,
} from "./monitor";
import { routePermission } from "./permissions";
import { permissionOutcome } from "./protocol";

const WORKSPACE = "/home/u/.daily-do-list/cursor/sessions/thr-1-abcd/workspace";
const ctx = (approved = false): MonitorContext => ({
  workspaceRoots: [WORKSPACE],
  isApprovedWeb: () => approved,
});

function track(...updates: Array<Partial<TrackedToolCall>>): TrackedToolCall {
  const tracker = new ToolCallTracker();
  let call: TrackedToolCall = { toolCallId: "tool_1" };
  for (const update of updates) call = tracker.apply({ toolCallId: "tool_1", ...update });
  return call;
}

function verdict(call: TrackedToolCall, approved = false): string | undefined {
  return findViolation(call, classifyToolCall(call, "ddl"), ctx(approved));
}

const started = { status: "in_progress" };

describe("policy monitor", () => {
  it("tolerates built-ins the deny list blocked (completed, but no result)", () => {
    const blocked = [
      track(
        { title: "Read File", kind: "read", rawInput: {} },
        { title: "Read /etc/hosts", rawInput: { path: "/etc/hosts" } },
        started,
        { status: "completed" },
      ),
      track({ title: "`echo hi`", kind: "execute", rawInput: { command: "echo hi" } }, started, {
        status: "completed",
      }),
      track({ title: "Edit File", kind: "edit" }, started, { status: "completed" }),
      track({ title: "Delete File", kind: "delete" }, started, { status: "completed" }),
      track(
        {
          title: "ddl-x",
          kind: "other",
          rawInput: { providerIdentifier: "notes", toolName: "send" },
        },
        { status: "completed", rawOutput: { permissionDenied: true } },
      ),
      track(
        { title: "Read Lints", kind: "read", rawInput: { paths: ["/x"] } },
        { status: "completed", rawOutput: { totalDiagnostics: 0, totalFiles: 0 } },
      ),
      track(
        { title: "Web Search", kind: "search", rawInput: { searchTerm: "q" } },
        { status: "completed", rawOutput: { rejected: true, reason: "User rejected" } },
      ),
      track(
        { title: "Web Fetch", kind: "fetch", rawInput: { url: "https://example.com" } },
        { status: "completed", rawOutput: { rejected: true, reason: "User rejected" } },
      ),
    ];
    for (const call of blocked) {
      expect(hasResult(call)).toBe(false);
      expect(verdict(call)).toBeUndefined();
    }
  });

  it("flags built-ins that produced a result", () => {
    const read = track(
      { title: "Read /etc/hosts", kind: "read", rawInput: { path: "/etc/hosts" } },
      { status: "completed", rawOutput: { content: "127.0.0.1 localhost\n" } },
    );
    expect(verdict(read)).toBe("read: Read /etc/hosts");
    const shell = track(
      { title: "`true`", kind: "execute", rawInput: { command: "true" } },
      { status: "completed", rawOutput: { exitCode: 0, stdout: "", stderr: "" } },
    );
    expect(verdict(shell)).toBe("execute: `true`");
    const edit = track(
      { title: "Edit `a.txt`", kind: "edit" },
      {
        status: "completed",
        content: [{ type: "diff", path: "a.txt", oldText: "", newText: "x" }],
      },
    );
    expect(verdict(edit)).toBe("edit: Edit `a.txt`");
    const mcp = track(
      {
        title: "notes: send",
        kind: "other",
        rawInput: { providerIdentifier: "notes", toolName: "send" },
      },
      { status: "completed", rawOutput: { content: [{ type: "text", text: "sent" }] } },
    );
    expect(verdict(mcp)).toBe("MCP tool notes:send");
    const unknown = track(
      { title: "Generate image", kind: "other", rawInput: { _toolName: "generateImage" } },
      { status: "completed", rawOutput: { path: "/tmp/x.png" } },
    );
    expect(verdict(unknown)).toBe("other: Generate image");
  });

  it("passes our MCP calls and the CLI's bookkeeping tools", () => {
    const ours = track(
      { title: "MCP: tool", kind: "other" },
      { title: "ddl: echo", rawInput: { providerIdentifier: "ddl", toolName: "echo", args: {} } },
      { status: "completed", rawOutput: { success: true } },
    );
    expect(classifyToolCall(ours, "ddl")).toEqual({ type: "bridge" });
    expect(verdict(ours)).toBeUndefined();
    const todos = track(
      { title: "Update TODOs", kind: "other", rawInput: { _toolName: "updateTodos", todos: [] } },
      { status: "completed" },
    );
    const task = track(
      { title: "Task: hi", kind: "other", rawInput: { _toolName: "task", prompt: "hi" } },
      { status: "completed", rawOutput: { durationMs: 2000, isBackground: false } },
    );
    const question = track(
      { title: "Pick one", kind: "think", rawInput: { _toolName: "askQuestion" } },
      { status: "completed" },
    );
    for (const call of [todos, task, question]) {
      expect(classifyToolCall(call, "ddl").type).toBe("internal");
      expect(verdict(call)).toBeUndefined();
    }
  });

  it("keeps an MCP call pending classification until the CLI names its server", () => {
    const tracker = new ToolCallTracker();
    const first = tracker.apply({
      toolCallId: "t",
      title: "MCP: tool",
      kind: "other",
      rawInput: {},
    });
    expect(classifyToolCall(first, "ddl").type).toBe("builtin");
    expect(verdict(first)).toBeUndefined();
    const named = tracker.apply({
      toolCallId: "t",
      title: "ddl: echo",
      rawInput: { providerIdentifier: "ddl", toolName: "echo" },
    });
    const done = tracker.apply({
      toolCallId: "t",
      status: "completed",
      rawInput: {},
      rawOutput: { success: true },
    });
    expect(classifyToolCall(named, "ddl")).toEqual({ type: "bridge" });
    expect(classifyToolCall(done, "ddl")).toEqual({ type: "bridge" });
  });

  it("allows the CLI's web tools only after our approval", () => {
    const search = track(
      { title: "Web Search", kind: "search", rawInput: {} },
      { title: 'Web Search: "desks"', rawInput: { searchTerm: "desks" } },
      { status: "completed", rawOutput: { referenceCount: 4 } },
    );
    expect(classifyToolCall(search, "ddl")).toEqual({
      type: "web",
      tool: "web_search",
      value: "desks",
    });
    expect(verdict(search, true)).toBeUndefined();
    expect(verdict(search, false)).toBe("web search without the safety gate");
    const fetch = track(
      {
        title: "Web Fetch: https://example.com",
        kind: "fetch",
        rawInput: { url: "https://example.com" },
      },
      { status: "completed", rawOutput: { success: true } },
    );
    expect(classifyToolCall(fetch, "ddl")).toEqual({
      type: "web",
      tool: "web_fetch",
      value: "https://example.com",
    });
    expect(verdict(fetch, false)).toBe("web fetch without the safety gate");
  });

  it("allows grep/glob inside the session workspace and flags searches the CLI ran elsewhere", () => {
    // The CLI re-roots an outside path to the workspace and reports matches from there.
    const reRooted = track(
      { title: 'grep "x"', kind: "search", rawInput: { pattern: "x", path: "/etc" } },
      { status: "completed", rawOutput: { totalMatches: 1, truncated: false } },
    );
    expect(verdict(reRooted)).toBeUndefined();
    const inside = track(
      {
        title: "Find `*.md`",
        kind: "search",
        rawInput: { pattern: "*.md" },
        locations: [{ path: WORKSPACE }],
      },
      { status: "completed", rawOutput: { totalFiles: 1, truncated: false } },
    );
    expect(verdict(inside)).toBeUndefined();
    const outside = track(
      { title: "Find `*`", kind: "search", locations: [{ path: "/home/u" }] },
      { status: "completed", rawOutput: { totalFiles: 12 } },
    );
    expect(verdict(outside)).toBe("search outside its workspace (/home/u)");
    const empty = track(
      { title: "Find", kind: "search", locations: [{ path: "/home/u" }] },
      { status: "completed", rawOutput: { totalFiles: 0 } },
    );
    expect(verdict(empty)).toBeUndefined();
  });
});

describe("routePermission", () => {
  const request = (kind: string, title: string, toolCallId = "tool_9") => ({
    sessionId: "s",
    toolCallId,
    title,
    kind,
    options: [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "allow-always", kind: "allow_always" },
      { optionId: "reject-once", kind: "reject_once" },
    ],
  });
  const none = () => false;

  it("gates the CLI's web search and fetch with our tool names and input shapes", () => {
    expect(
      routePermission(request("search", "Web search: IANA example domain", "web_search_0"), none),
    ).toEqual({
      type: "web",
      tool: "web_search",
      input: { query: "IANA example domain" },
      value: "IANA example domain",
    });
    expect(
      routePermission(request("fetch", "Fetch https://example.com/a?b=1", "web_fetch_1"), none),
    ).toEqual({
      type: "web",
      tool: "web_fetch",
      input: { url: "https://example.com/a?b=1" },
      value: "https://example.com/a?b=1",
    });
  });

  it("allows only permission requests of MCP calls to our server, recognized by tool call", () => {
    expect(
      routePermission(request("other", "ddl-echo: echo", "tool_ours"), (id) => id === "tool_ours"),
    ).toEqual({ type: "bridge" });
    // Question prompts carry a model-chosen title and allow_once answer options.
    expect(
      routePermission(request("other", "ddl-echo: echo", "tool_q_q0"), (id) => id === "tool_ours")
        .type,
    ).toBe("reject");
    expect(routePermission(request("other", "Web search: x"), none).type).toBe("reject");
    expect(routePermission(request("edit", "Delete `/tmp/x`"), none)).toEqual({
      type: "reject",
      what: "edit: Delete `/tmp/x`",
    });
    expect(routePermission(request("search", "Web search:   "), none).type).toBe("reject");
  });

  it("answers with one-time options only, cancelled when none fits", () => {
    const r = request("search", "Web search: q");
    expect(permissionOutcome(r, true)).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(permissionOutcome(r, false)).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
    expect(
      permissionOutcome({ options: [{ optionId: "always", kind: "allow_always" }] }, true),
    ).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });
});
