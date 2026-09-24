import { errorResult, type ToolSpec, textResult } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { ScriptedHarness } from "../harness/scripted";
import type { HarnessEvent, HarnessSessionOptions, ToolCallRequest } from "../harness/types";
import { createFakeBrain, type FakeBrain } from "./brain/brain";
import type { BrainMessage } from "./brain/types";
import { createFakeAgentScript, modelText, type ScriptToolEvent } from "./script";

function tool(
  name: string,
  execute: ToolSpec["execute"] = async () => textResult(`${name} ok`),
): ToolSpec {
  return {
    name,
    label: name,
    description: name,
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    safety: { readOnly: true },
    execute,
  };
}

async function session(
  brain: FakeBrain,
  overrides: Partial<HarnessSessionOptions> = {},
  maxSteps?: number,
) {
  const events: HarnessEvent[] = [];
  const gate: ToolCallRequest[] = [];
  const calls: ScriptToolEvent[] = [];
  const harness = new ScriptedHarness({
    scriptFor: createFakeAgentScript(brain, {
      onToolCall: (e) => calls.push(e),
      ...(maxSteps ? { maxSteps } : {}),
    }),
  });
  const s = await harness.createSession({
    sessionId: "s1",
    role: "subagent",
    systemPrompt: "sys",
    tools: [tool("echo"), tool("fail", async () => errorResult("disk full")), tool("secret")],
    model: "m",
    cwd: "/tmp",
    beforeToolCall: async (call) => {
      gate.push(call);
      return call.toolName === "secret" ? { allow: false, reason: "not allowed" } : { allow: true };
    },
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  return { s, events, gate, calls };
}

const lastRequestMessages = (brain: FakeBrain): BrainMessage[] =>
  brain.decisions.at(-1)!.request.messages;

describe("createFakeAgentScript", () => {
  it("loops decide → tool → result until the brain stops, keeping the transcript across prompts", async () => {
    const brain = createFakeBrain().enqueue(
      { text: "Echoing.", toolCalls: [{ name: "echo", arguments: { text: "a" } }] },
      { text: "Done." },
      { text: "Second answer." },
    );
    const { s, events, gate } = await session(brain);
    await s.prompt("first");
    await s.prompt("second");
    expect(gate.map((g) => g.toolName)).toEqual(["echo"]);
    expect(
      events.filter((e) => e.type === "message_end").map((e) => e.type === "message_end" && e.text),
    ).toEqual(["Echoing.", "Done.", "Second answer."]);
    expect(lastRequestMessages(brain).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    expect(lastRequestMessages(brain)[2]).toMatchObject({
      role: "tool",
      name: "echo",
      content: "echo ok",
    });
  });

  it("reports unknown tools and invalid arguments without asking the gate, like Pi", async () => {
    const brain = createFakeBrain().enqueue(
      {
        toolCalls: [
          { name: "nope", arguments: {} },
          { name: "echo", arguments: { wrong: 1 } },
          { name: "echo", arguments: "{bad" },
        ],
      },
      {},
    );
    const { s, gate, calls } = await session(brain);
    await s.prompt("go");
    expect(gate).toEqual([]);
    expect(calls.map((c) => [c.outcome, c.toolCallId])).toEqual([
      ["invalid", undefined],
      ["invalid", undefined],
      ["invalid", undefined],
    ]);
    expect(calls[0]!.content).toBe("Tool nope not found");
    expect(calls[1]!.content).toMatch(
      /^Validation failed for tool "echo":\n {2}- text: is required\n {2}- wrong: is not an allowed property/,
    );
  });

  it("shows gate blocks and tool errors to the model the way the Pi harness does", async () => {
    const brain = createFakeBrain().enqueue(
      {
        toolCalls: [
          { name: "secret", arguments: { text: "x" } },
          { name: "fail", arguments: { text: "x" } },
        ],
      },
      {},
    );
    const { s, calls } = await session(brain);
    await s.prompt("go");
    expect(calls.map((c) => [c.outcome, c.content])).toEqual([
      ["blocked", "Blocked by safety policy: not allowed"],
      ["error", "Error: disk full"],
    ]);
    expect(calls.every((c) => typeof c.toolCallId === "string")).toBe(true);
    expect(modelText({ result: errorResult("Error: already prefixed"), blocked: false })).toBe(
      "Error: already prefixed",
    );
  });

  it("delivers steering at the next step", async () => {
    let release!: () => void;
    const gateOpen = new Promise<void>((resolve) => {
      release = resolve;
    });
    const brain = createFakeBrain().enqueue(
      { toolCalls: [{ name: "echo", arguments: { text: "slow" } }] },
      {},
    );
    const { s } = await session(brain, {
      tools: [
        tool("echo", async () => {
          await gateOpen;
          return textResult("slow done");
        }),
      ],
    });
    const run = s.prompt("start");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await s.steer("Also this");
    release();
    await run;
    expect(lastRequestMessages(brain).at(-1)).toEqual({ role: "user", content: "Also this" });
    expect(brain.decisions).toHaveLength(2);
  });

  it("a hanging model call ends quietly on abort; a failing one reports an error", async () => {
    const brain = createFakeBrain().hang().fail({ message: "model down" });
    const { s, events } = await session(brain);
    const run = s.prompt("hang");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await s.abort();
    await run;
    expect(events.some((e) => e.type === "error")).toBe(false);
    await s.prompt("fail");
    expect(events).toContainEqual({ type: "error", message: "model down" });
    expect(events.at(-1)).toEqual({ type: "idle" });
  });

  it("stops a runaway brain after maxSteps", async () => {
    const brain = createFakeBrain().when("generic", {
      toolCalls: [{ name: "echo", arguments: { text: "again" } }],
    });
    const { s, events } = await session(brain, { tools: [tool("echo")] }, 5);
    await s.prompt("loop");
    expect(events).toContainEqual({
      type: "error",
      message: "The fake agent made 5 model calls without finishing.",
    });
  });
});
