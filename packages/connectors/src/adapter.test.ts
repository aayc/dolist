import type { ToolResult } from "@ddl/core";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  createMcpToolSpec,
  describeMcpCall,
  type McpToolTarget,
  requiresApproval,
  safetyHintsFromAnnotations,
} from "./adapter";
import type { ApprovalPosture } from "./config";
import { McpTransportError } from "./errors";
import type { McpToolDefinition } from "./tool-definition";

interface Posture {
  current: ApprovalPosture | undefined;
}

function makeTarget(posture: Posture, call?: McpToolTarget["call"]): McpToolTarget {
  return {
    approval: () => posture.current,
    call: call ?? (async () => ({ content: [{ type: "text", text: "ok" }] })),
  };
}

function makeTool(overrides: Partial<McpToolDefinition> = {}): McpToolDefinition {
  return {
    name: "create_issue",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
    annotations: {},
    ...overrides,
  };
}

const ctx = { toolCallId: "call-1" };

describe("safetyHintsFromAnnotations", () => {
  it("follows the MCP defaults for unannotated tools", () => {
    expect(safetyHintsFromAnnotations({})).toEqual({
      readOnly: false,
      destructive: true,
      openWorld: true,
    });
  });

  it("ignores destructiveHint for read-only tools and honours explicit false hints", () => {
    expect(safetyHintsFromAnnotations({ readOnlyHint: true, destructiveHint: true })).toEqual({
      readOnly: true,
      destructive: false,
      openWorld: true,
    });
    expect(safetyHintsFromAnnotations({ destructiveHint: false, openWorldHint: false })).toEqual({
      readOnly: false,
      destructive: false,
      openWorld: false,
    });
  });
});

describe("requiresApproval", () => {
  it.each([
    ["auto", false, false],
    ["auto", true, false],
    ["always", true, true],
    ["writes", true, false],
    ["writes", false, true],
    [undefined, true, true],
  ] as const)("posture %s, readOnly %s → %s", (posture, readOnly, expected) => {
    expect(requiresApproval(posture, readOnly)).toBe(expected);
  });
});

describe("createMcpToolSpec", () => {
  it("builds name, label, prefixed description, parameters and hints", () => {
    const spec = createMcpToolSpec({
      name: "mcp__github__create_issue",
      serverName: "github",
      serverDescription: "Issues and PRs",
      tool: makeTool({
        title: "Create issue",
        description: "Creates an issue.\u200B\u{E0041}",
        inputSchema: { properties: { title: { type: "string" } }, required: ["title", "ghost"] },
        annotations: { destructiveHint: false },
      }),
      target: makeTarget({ current: "auto" }),
    });
    expect(spec.name).toBe("mcp__github__create_issue");
    expect(spec.label).toBe("Create issue");
    expect(spec.description).toBe("[github: Issues and PRs] Creates an issue.");
    expect(spec.parameters).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    });
    expect(spec.safety).toMatchObject({ readOnly: false, destructive: false, openWorld: true });
    expect(spec.safety.alwaysRequireApproval).toBe(false);
    expect(spec.safety.category).toBeUndefined();
  });

  it("prefers the annotation title and falls back to a generated description", () => {
    const spec = createMcpToolSpec({
      name: "n",
      serverName: "files",
      tool: makeTool({ name: "read", title: "Read", annotations: { title: "Read a file" } }),
      target: makeTarget({ current: "auto" }),
    });
    expect(spec.label).toBe("Read a file");
    expect(spec.description).toBe('[files] Tool "read" from MCP server "files".');
  });

  it("reads the approval posture live and fails closed when the server is gone", () => {
    const posture: Posture = { current: "writes" };
    const readOnly = createMcpToolSpec({
      name: "r",
      serverName: "files",
      tool: makeTool({ annotations: { readOnlyHint: true } }),
      target: makeTarget(posture),
    });
    const write = createMcpToolSpec({
      name: "w",
      serverName: "files",
      tool: makeTool(),
      target: makeTarget(posture),
    });
    expect(readOnly.safety.alwaysRequireApproval).toBe(false);
    expect(write.safety.alwaysRequireApproval).toBe(true);
    posture.current = "always";
    expect(readOnly.safety.alwaysRequireApproval).toBe(true);
    posture.current = "auto";
    expect(write.safety.alwaysRequireApproval).toBe(false);
    posture.current = undefined;
    expect(readOnly.safety.alwaysRequireApproval).toBe(true);
    expect({ ...write.safety }.alwaysRequireApproval).toBe(true);
  });

  it("executes through the target and projects the result", async () => {
    const seen: Array<{ args: unknown; signal: AbortSignal | undefined }> = [];
    const updates: ToolResult[] = [];
    const spec = createMcpToolSpec({
      name: "n",
      serverName: "srv",
      tool: makeTool(),
      target: makeTarget({ current: "auto" }, async (args, options) => {
        seen.push({ args, signal: options.signal });
        options.onProgress?.({ progress: 1, total: 2, message: "half way" });
        return { content: [{ type: "text", text: "created #7" }], structuredContent: { id: 7 } };
      }),
    });
    const controller = new AbortController();
    const result = await spec.execute(
      { title: "Fix login" },
      { ...ctx, signal: controller.signal, onUpdate: (partial) => updates.push(partial) },
    );
    expect(seen).toEqual([{ args: { title: "Fix login" }, signal: controller.signal }]);
    expect(updates).toEqual([{ content: [{ type: "text", text: "Progress 1/2: half way" }] }]);
    expect(result).toEqual({
      content: [{ type: "text", text: "created #7" }],
      details: { server: "srv", tool: "create_issue", structuredContent: { id: 7 } },
    });
    await spec.execute(undefined, ctx);
    expect(seen.at(-1)).toEqual({ args: {}, signal: undefined });
  });

  it("returns server protocol errors to the model and throws infrastructure failures", async () => {
    let failure: Error = new McpError(
      ErrorCode.InvalidParams,
      "Invalid arguments: title is required",
    );
    const spec = createMcpToolSpec({
      name: "n",
      serverName: "srv",
      tool: makeTool(),
      target: makeTarget({ current: "auto" }, async () => {
        throw failure;
      }),
    });
    await expect(spec.execute({}, ctx)).resolves.toEqual({
      content: [
        {
          type: "text",
          text: 'MCP server "srv" returned error -32602: Invalid arguments: title is required',
        },
      ],
      details: { server: "srv", tool: "create_issue" },
      isError: true,
    });
    failure = new McpTransportError("srv", "disconnected");
    await expect(spec.execute({}, ctx)).rejects.toBe(failure);
    await expect(spec.execute("not an object", ctx)).resolves.toMatchObject({ isError: true });
  });
});

describe("describeMcpCall", () => {
  it("renders a compact call signature", () => {
    expect(
      describeMcpCall("github", "create_issue", {
        owner: "acme",
        title: "Fix login",
        draft: false,
      }),
    ).toBe('github · create_issue(owner: "acme", title: "Fix login", draft: false)');
    expect(describeMcpCall("files", "list", undefined)).toBe("files · list()");
    expect(describeMcpCall("files", "list", "raw")).toBe('files · list("raw")');
  });

  it("masks credential-like keys and token-looking values", () => {
    const githubToken = ["gh", "p_", "x".repeat(36)].join("");
    const described = describeMcpCall("svc", "call", {
      api_key: "k",
      password: 1234,
      max_tokens: 100,
      note: `use Bearer ${"y".repeat(20)} here`,
      body: githubToken,
      nested: { client_secret: "s", ok: true },
    });
    expect(described).toBe(
      'svc · call(api_key: •••, password: •••, max_tokens: 100, note: "use Bearer ••• here", ' +
        'body: "•••", nested: {client_secret: •••, ok: true})',
    );
  });

  it("truncates long values and keeps the whole line short", () => {
    const described = describeMcpCall("svc", "write", {
      content: "z".repeat(500),
      tags: ["a", "b", "c", "d", "e"],
      deep: { level: { again: 1 }, list: [1, 2], more: 1, extra: 2 },
    });
    expect(described).toContain(`content: "${"z".repeat(59)}…"`);
    expect(described).toContain('tags: ["a", "b", "c", …+2]');
    expect(described).toContain("deep: {level: {…}, list: [2 items], more: 1, …+1}");
    const huge = describeMcpCall(
      "svc",
      "write",
      Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i])),
    );
    expect(huge.length).toBeLessThanOrEqual(240);
    expect(huge.endsWith("…")).toBe(true);
  });
});
