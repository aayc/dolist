import { fc, test } from "@fast-check/vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect } from "vitest";
import {
  createMcpToolSpec,
  describeMcpCall,
  requiresApproval,
  safetyHintsFromAnnotations,
} from "./adapter";
import type { ApprovalPosture } from "./config";
import type { McpToolAnnotations } from "./tool-definition";

const runs = (factor: number) =>
  Math.max(1, Math.round((fc.readConfigureGlobal().numRuns ?? 100) * factor));

/** Hint values as servers send them: booleans, missing, or the wrong type (treated as missing). */
const hintValue = fc.constantFrom(true, false, undefined, "true", "false", 1, 0, null);
const posture = fc.constantFrom<ApprovalPosture | undefined>("auto", "writes", "always", undefined);

describe("annotations → safety hints (MCP defaults)", () => {
  test.prop([hintValue, hintValue, hintValue, posture], { numRuns: runs(3) })(
    "every combination maps as documented, and the posture is read live",
    (readOnlyHint, destructiveHint, openWorldHint, initial) => {
      const annotations = {
        readOnlyHint,
        destructiveHint,
        openWorldHint,
      } as unknown as McpToolAnnotations;
      const readOnly = readOnlyHint === true;
      const expected = {
        readOnly,
        destructive: !readOnly && destructiveHint !== false,
        openWorld: openWorldHint !== false,
      };
      expect(safetyHintsFromAnnotations(annotations)).toEqual(expected);

      let current = initial;
      const spec = createMcpToolSpec({
        name: "mcp__srv__tool",
        serverName: "srv",
        tool: { name: "tool", inputSchema: {}, annotations },
        target: { approval: () => current, call: async () => ({ content: [] }) },
      });
      expect(spec.safety).toMatchObject(expected);
      for (const next of ["auto", "writes", "always", undefined] as const) {
        current = next;
        const mustAsk = next === undefined || next === "always" || (next === "writes" && !readOnly);
        expect(spec.safety.alwaysRequireApproval, `${next}`).toBe(mustAsk);
        expect(requiresApproval(next, readOnly)).toBe(mustAsk);
      }
    },
  );
});

describe("describeMcpCall", () => {
  const secret = fc.oneof(
    fc.stringMatching(/^[A-Za-z0-9]{36}$/).map((s) => `ghp_${s}`),
    fc.stringMatching(/^[A-Za-z0-9_-]{24}$/).map((s) => `sk-${s}`),
    fc.stringMatching(/^[A-Za-z0-9]{24}$/).map((s) => `sk_live_${s}`),
    fc.stringMatching(/^[A-Z0-9]{16}$/).map((s) => `AKIA${s}`),
  );

  test.prop([fc.anything(), fc.string({ maxLength: 30 }), fc.string({ maxLength: 30 })], {
    numRuns: runs(2),
  })("never throws and stays short for any input", (input, server, tool) => {
    const line = describeMcpCall(server, tool, input);
    expect(typeof line).toBe("string");
    expect(line.length).toBeLessThanOrEqual(240);
  });

  test.prop([
    secret,
    fc.constantFrom(
      "token",
      "api_key",
      "password",
      "Authorization",
      "client_secret",
      "note",
      "body",
    ),
  ])("masks secrets under credential keys and in free text", (value, key) => {
    const line = describeMcpCall("svc", "call", {
      [key]: value,
      nested: { [key]: value },
      list: [value],
    });
    expect(line).not.toContain(value);
  });
});

describe("tool execution never leaks infrastructure failures as success", () => {
  test.prop([fc.anything()])("non-object arguments become an error result", async (args) => {
    fc.pre(
      args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args)),
    );
    let called = false;
    const spec = createMcpToolSpec({
      name: "n",
      serverName: "srv",
      tool: { name: "t", inputSchema: {}, annotations: {} },
      target: {
        approval: () => "auto",
        call: async () => {
          called = true;
          return { content: [] };
        },
      },
    });
    const result = await spec.execute(args, { toolCallId: "c" });
    expect(result.isError).toBe(true);
    expect(called).toBe(false);
  });

  test.prop([fc.string({ maxLength: 60 })])(
    "server protocol errors are masked error results",
    async (detail) => {
      const token = `ghp_${"Ab1".repeat(12)}`;
      const spec = createMcpToolSpec({
        name: "n",
        serverName: "srv",
        tool: { name: "t", inputSchema: {}, annotations: {} },
        target: {
          approval: () => "auto",
          call: async () => {
            throw new McpError(ErrorCode.InvalidParams, `${detail} ${token}`);
          },
        },
      });
      const result = await spec.execute({}, { toolCallId: "c" });
      expect(result.isError).toBe(true);
      const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      expect(text).not.toContain(token);
    },
  );
});
