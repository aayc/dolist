import type { ToolSafetyHints, ToolSpec } from "@ddl/core";
import { textResult } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import type { ToolCallRequest } from "../harness/types";
import { createApprovalBroker } from "./approvals";
import { createSafetyEvaluator } from "./evaluator";
import { createSafetyGate } from "./gate";
import { ACTION_CATEGORIES, RISK_LEVELS, riskRank, SAFETY_DECISIONS } from "./policy";
import { SAFETY_RULES } from "./rules";
import { MAX_SHELL_COMMAND_CHARS, parseShell } from "./shell";
import { hints, hostileJson, hostileString, runs, toolName } from "./test-arbitraries";
import { actionContext, WORKSPACE } from "./test-helpers";
import type { SafetyVerdict } from "./types";

const evaluator = createSafetyEvaluator({ policy: { llmJudge: false } });
const REGISTERED = new Set(SAFETY_RULES.map((r) => r.id));
const SOURCES = ["policy", "grant", "rules", "llm", "fallback"];
const FLOOR: Record<string, number> = { allow: 0, require_approval: 1, deny: 2 };

function expectWellFormed(verdict: SafetyVerdict): void {
  expect(SAFETY_DECISIONS).toContain(verdict.decision);
  expect(RISK_LEVELS).toContain(verdict.risk);
  expect(riskRank(verdict.risk)).toBeGreaterThanOrEqual(FLOOR[verdict.decision]!);
  expect(Array.isArray(verdict.categories)).toBe(true);
  for (const c of verdict.categories) expect(ACTION_CATEGORIES).toContain(c);
  expect(new Set(verdict.categories).size).toBe(verdict.categories.length);
  expect(typeof verdict.reason).toBe("string");
  expect(verdict.reason.trim()).not.toBe("");
  expect(typeof verdict.summary).toBe("string");
  expect(verdict.summary.trim()).not.toBe("");
  expect(verdict.summary.length).toBeLessThanOrEqual(200);
  expect(SOURCES).toContain(verdict.source);
  expect(Number.isFinite(verdict.latencyMs)).toBe(true);
  expect(verdict.latencyMs).toBeGreaterThanOrEqual(0);
  for (const id of verdict.matchedRules ?? []) expect(REGISTERED.has(id), id).toBe(true);
}

const context = fc.record({
  role: fc.constantFrom("subagent" as const, "orchestrator" as const),
  taskId: fc.option(hostileString, { nil: null }),
  threadId: fc.option(hostileString, { nil: null }),
  taskText: fc.option(hostileString, { nil: undefined }),
  rationale: fc.option(hostileString, { nil: undefined }),
  workspaceDir: fc.constantFrom(WORKSPACE, undefined, "", "relative/dir", "/", "/tmp/x"),
});

describe("evaluate() under fuzzing", () => {
  test.prop([toolName, hostileJson, hints, context], { numRuns: runs(3) })(
    "never throws and always returns a well-formed verdict",
    async (tool, input, hint, ctx) => {
      const verdict = await evaluator.evaluate({
        toolName: tool,
        input,
        hints: hint,
        ...ctx,
        ...(ctx.workspaceDir === undefined ? { workspaceDir: undefined } : {}),
      } as never);
      expectWellFormed(verdict);
    },
  );

  test.prop([fc.constantFrom("bash", "mcp__srv__run", "custom_tool"), hostileString, hints])(
    "handles arbitrary shell command strings",
    async (tool, command, hint) => {
      expectWellFormed(await evaluator.evaluate(actionContext(tool, { command }, { hints: hint })));
    },
  );

  test.prop([
    fc.constantFrom(
      "browser_click",
      "browser_type",
      "browser_navigate",
      "browser_press_key",
      "computer_type",
      "computer_key",
      "web_fetch",
      "mcp__playwright__browser_type",
    ),
    fc.record(
      {
        element: hostileString,
        text: hostileString,
        url: hostileString,
        key: hostileString,
        combo: hostileString,
        submit: fc.oneof(fc.boolean(), hostileString),
        fields: fc.array(fc.record({ name: hostileString, value: hostileString }), {
          maxLength: 4,
        }),
      },
      { requiredKeys: [] },
    ),
  ])("handles arbitrary UI inputs", async (tool, input) => {
    expectWellFormed(await evaluator.evaluate(actionContext(tool, input)));
  });

  test.prop([toolName, hostileJson])(
    "is deterministic for the same action",
    async (tool, input) => {
      const a = await evaluator.evaluate(actionContext(tool, input));
      const b = await evaluator.evaluate(actionContext(tool, input));
      expect({ ...a, latencyMs: 0 }).toEqual({ ...b, latencyMs: 0 });
    },
  );
});

describe("evaluate() on pathological structures", () => {
  function deep(levels: number): unknown {
    let value: unknown = { command: "rm -rf ~" };
    for (let i = 0; i < levels; i++) value = { nested: value, list: [value] };
    return value;
  }

  it.each<[string, () => unknown]>([
    ["10 000 levels of nesting", () => deep(10_000)],
    [
      "a cycle",
      () => {
        const a: Record<string, unknown> = { element: "Place order" };
        a.self = a;
        a.list = [a, [a]];
        return a;
      },
    ],
    ["100k-character strings", () => ({ element: "x".repeat(100_000), text: "y".repeat(100_000) })],
    ["5 000 keys", () => Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`k${i}`, i]))],
    ["a 20 000-item array", () => ({ to: Array.from({ length: 20_000 }, (_, i) => `u${i}@x.io`) })],
    [
      "getters that throw",
      () =>
        Object.defineProperty({}, "element", {
          enumerable: true,
          get() {
            throw new Error("getter bug");
          },
        }),
    ],
    ["a function", () => () => "hi"],
    ["a symbol", () => Symbol("s")],
    ["a bigint", () => ({ amount: 10n })],
    ["a null-prototype object", () => Object.assign(Object.create(null), { element: "Send" })],
    ["a Date and a Map", () => ({ when: new Date(0), map: new Map([["a", 1]]) })],
  ])("survives %s for every tool family", async (_label, make) => {
    for (const tool of [
      "bash",
      "browser_click",
      "browser_type",
      "computer_type",
      "web_fetch",
      "write",
      "read",
      "post_update",
      "mcp__gmail__send_email",
      "custom_tool",
    ]) {
      const started = performance.now();
      const verdict = await evaluator.evaluate(actionContext(tool, make()));
      expectWellFormed(verdict);
      expect(performance.now() - started, tool).toBeLessThan(1_000);
    }
  });

  it("never allows an effectful call whose input it could not read", async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    for (const tool of ["bash", "browser_click", "mcp__gmail__send_email", "write", "custom"]) {
      const verdict = await evaluator.evaluate(actionContext(tool, hostile));
      expect(verdict.decision, tool).not.toBe("allow");
      expectWellFormed(verdict);
    }
  });

  it("falls back to a readable summary when even the description fails", async () => {
    for (const tool of ["", "   ", "x".repeat(500)]) {
      const verdict = await evaluator.evaluate({
        ...actionContext(tool, {}),
        hints: new Proxy({} as ToolSafetyHints, {
          get() {
            throw new Error("hints exploded");
          },
        }),
      });
      expect(verdict).toMatchObject({ decision: "require_approval", source: "fallback" });
      expectWellFormed(verdict);
    }
  });
});

describe("the gate under fuzzing", () => {
  test.prop([
    fc.array(
      fc.record({
        toolName,
        input: hostileJson,
        withSpec: fc.boolean(),
        safety: hints,
        decision: fc.constantFrom("approve", "deny"),
        scope: fc.constantFrom("once" as const, "task" as const, "always" as const),
      }),
      { minLength: 1, maxLength: 8 },
    ),
  ])("never throws, never hangs and always answers allow or a reason", async (calls) => {
    const approvals = createApprovalBroker();
    const decisions = new Map<string, (typeof calls)[number]>();
    approvals.onUpsert((approval) => {
      if (approval.status !== "pending") return;
      const plan = decisions.get(approval.toolName) ?? calls[0]!;
      void approvals
        .decide(approval.id, { decision: plan.decision, scope: plan.scope })
        .catch(() => undefined);
    });
    const gate = createSafetyGate({
      evaluator,
      approvals,
      resolveContext: () => ({ taskId: "task-1", threadId: "thread-1", workspaceDir: WORKSPACE }),
    });
    for (const [i, c] of calls.entries()) {
      decisions.set(c.toolName, c);
      const spec: ToolSpec | undefined = c.withSpec
        ? {
            name: c.toolName,
            label: c.toolName,
            description: "",
            parameters: { type: "object" },
            safety: c.safety,
            execute: async () => textResult("ok"),
          }
        : undefined;
      const request: ToolCallRequest = {
        sessionId: "s",
        role: "subagent",
        toolCallId: `c${i}`,
        toolName: c.toolName,
        input: c.input,
        ...(spec ? { spec } : {}),
      };
      const result = await gate(request);
      if (result.allow) expect(result).toEqual({ allow: true });
      else expect(result.reason.trim()).not.toBe("");
    }
    expect(approvals.list({ status: "pending" })).toEqual([]);
  });
});

describe("parseShell under fuzzing", () => {
  const shellToken = fc.oneof(
    fc.constantFrom(
      "rm",
      "-rf",
      "~",
      "/",
      "ls",
      "echo",
      "bash",
      "-c",
      "eval",
      "sudo",
      "env",
      "find",
      "-exec",
      "{}",
      "\\;",
      "xargs",
      "|",
      "||",
      "&&",
      ";",
      "&",
      "(",
      ")",
      "{",
      "}",
      "$(",
      "`",
      "'",
      '"',
      "<<",
      "EOF",
      "<<<",
      ">",
      ">>",
      "2>&1",
      "<(",
      "$'\\x72'",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion under test
      "${IFS}",
      "$HOME",
      "\\",
      "#",
      "\n",
      "function",
      "alias",
      "f()",
      "=",
      "x=1",
    ),
    hostileString,
  );

  test.prop([fc.array(shellToken, { maxLength: 40 }).map((t) => t.join(" "))], {
    numRuns: runs(3),
  })("never throws and keeps its analysis bounded", (command) => {
    const analysis = parseShell(command, { workspaceDir: WORKSPACE });
    expect(typeof analysis.source).toBe("string");
    expect(analysis.commands.length).toBeLessThanOrEqual(400);
    for (const cmd of analysis.commands) {
      expect(cmd.argv.length).toBe(cmd.dynamicArgs.length);
      expect(cmd.depth).toBeLessThanOrEqual(7);
    }
  });

  test.prop([fc.string({ unit: "binary", maxLength: 300 })])(
    "never throws on arbitrary unicode",
    (command) => {
      expect(() => parseShell(command)).not.toThrow();
    },
  );

  it("stays fast on adversarial nesting and size", () => {
    const cases = [
      "$(".repeat(5_000),
      "'".repeat(10_001),
      `${"bash -c '".repeat(20)}rm -rf ~${"'".repeat(20)}`,
      `echo ${"a ".repeat(MAX_SHELL_COMMAND_CHARS / 2 - 10)}`,
      `${"(".repeat(3_000)}ls${")".repeat(3_000)}`,
      "a|".repeat(2_000),
      "<<EOF\n".repeat(1_000),
    ];
    for (const command of cases) {
      const started = performance.now();
      expect(() => parseShell(command)).not.toThrow();
      expect(performance.now() - started, command.slice(0, 20)).toBeLessThan(1_000);
    }
  });
});
