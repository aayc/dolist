import { type ToolSpec, textResult } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { ScriptedHarness } from "./scripted";
import type { HarnessEvent, HarnessSessionOptions } from "./types";

const echo: ToolSpec<{ text: string }> = {
  name: "echo",
  label: "Echo",
  description: "Echo text back",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  safety: { readOnly: true },
  async execute(input) {
    return textResult(`echo: ${input.text}`);
  },
};

function baseOptions(overrides: Partial<HarnessSessionOptions> = {}): HarnessSessionOptions {
  return {
    sessionId: "s1",
    role: "subagent",
    systemPrompt: "test",
    tools: [echo as ToolSpec],
    model: "mock",
    cwd: "/tmp",
    beforeToolCall: async () => ({ allow: true }),
    ...overrides,
  };
}

describe("ScriptedHarness", () => {
  it("streams text and runs tools through beforeToolCall", async () => {
    const events: HarnessEvent[] = [];
    const seen: string[] = [];
    const harness = new ScriptedHarness({
      script: async (ctx) => {
        await ctx.say("hello there");
        const { result } = await ctx.callTool("echo", { text: ctx.message });
        seen.push(result.content[0]?.type === "text" ? result.content[0].text : "");
      },
    });
    const session = await harness.createSession(
      baseOptions({
        onEvent: (e) => events.push(e),
        beforeToolCall: async (call) => {
          seen.push(`gate:${call.toolName}`);
          return { allow: true };
        },
      }),
    );
    await session.prompt("ping");
    expect(seen).toEqual(["gate:echo", "echo: ping"]);
    expect(events.map((e) => e.type)).toEqual([
      "turn_start",
      "text_delta",
      "text_delta",
      "message_end",
      "tool_start",
      "tool_end",
      "idle",
    ]);
  });

  it("reports blocked tool calls without executing them", async () => {
    let executed = false;
    const tool: ToolSpec = {
      ...(echo as ToolSpec),
      execute: async () => {
        executed = true;
        return textResult("x");
      },
    };
    const harness = new ScriptedHarness({
      script: async (ctx) => {
        const r = await ctx.callTool("echo", { text: "x" });
        expect(r.blocked).toBe(true);
        expect(r.reason).toBe("nope");
      },
    });
    const session = await harness.createSession(
      baseOptions({
        tools: [tool],
        beforeToolCall: async () => ({ allow: false, reason: "nope" }),
      }),
    );
    await session.prompt("go");
    expect(executed).toBe(false);
  });

  it("supports per-session scripts", async () => {
    const roles: string[] = [];
    const harness = new ScriptedHarness({
      scriptFor: (opts) => async () => {
        roles.push(opts.role);
      },
    });
    await (await harness.createSession(baseOptions({ role: "orchestrator" }))).prompt("a");
    await (await harness.createSession(baseOptions({ role: "subagent" }))).prompt("b");
    expect(roles).toEqual(["orchestrator", "subagent"]);
  });

  it("queues prompts sent while running", async () => {
    const order: string[] = [];
    const harness = new ScriptedHarness({
      script: async (ctx) => {
        order.push(`start:${ctx.message}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end:${ctx.message}`);
      },
    });
    const session = await harness.createSession(baseOptions());
    await Promise.all([session.prompt("one"), session.prompt("two")]);
    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
  });
});
