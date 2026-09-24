import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiEventMapper } from "./events";
import { ToolCallLedger } from "./ledger";

function assistant(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openrouter",
    model: "deepseek/deepseek-v4.1-flash",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 0,
      totalTokens: 170,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

const user = { role: "user", content: "hi", timestamp: 0 } as const;

function delta(
  type: "text_delta" | "thinking_delta" | "toolcall_delta",
  text: string,
): AgentSessionEvent {
  const message = assistant([]);
  return {
    type: "message_update",
    message,
    assistantMessageEvent: { type, contentIndex: 0, delta: text, partial: message },
  } as AgentSessionEvent;
}

function mapper(ledger = new ToolCallLedger()) {
  let n = 0;
  return { ledger, mapper: new PiEventMapper({ ledger, newMessageId: () => `msg_${++n}` }) };
}

function run(m: PiEventMapper, events: AgentSessionEvent[]) {
  return events.flatMap((event) => m.map(event));
}

describe("PiEventMapper", () => {
  it("maps a streamed answer with a stable message id, usage and one run bracket", () => {
    const { mapper: m } = mapper();
    const final = assistant([
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "Hello there" },
    ]);
    const events = run(m, [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start", message: user },
      { type: "message_end", message: user },
      { type: "message_start", message: assistant([]) },
      delta("thinking_delta", "hmm"),
      delta("text_delta", "Hello "),
      delta("toolcall_delta", "{"),
      delta("text_delta", "there"),
      { type: "message_end", message: final },
      { type: "turn_end", message: final, toolResults: [] },
      { type: "agent_end", messages: [user, final], willRetry: false },
      { type: "agent_settled" },
    ] as AgentSessionEvent[]);
    expect(events).toEqual([
      { type: "turn_start" },
      { type: "thinking_delta", messageId: "msg_1", delta: "hmm" },
      { type: "text_delta", messageId: "msg_1", delta: "Hello " },
      { type: "text_delta", messageId: "msg_1", delta: "there" },
      { type: "message_end", messageId: "msg_1", text: "Hello there" },
      { type: "usage", inputTokens: 150, outputTokens: 20, costUsd: 0.0001 },
      { type: "idle" },
    ]);
  });

  it("emits one turn_start per run even when Pi restarts the loop (retries, follow-ups)", () => {
    const { mapper: m } = mapper();
    const events = run(m, [
      { type: "agent_start" },
      { type: "agent_end", messages: [], willRetry: true },
      { type: "agent_start" },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
      { type: "agent_start" },
    ] as AgentSessionEvent[]);
    expect(events.map((e) => e.type)).toEqual(["turn_start", "idle", "turn_start"]);
  });

  it("gives each assistant message its own id and closes tool-only turns", () => {
    const { mapper: m } = mapper();
    const toolTurn = assistant([{ type: "toolCall", id: "call_1", name: "echo", arguments: {} }], {
      stopReason: "toolUse",
      usage: { ...assistant([]).usage, cost: { ...assistant([]).usage.cost, total: 0 } },
    });
    const events = run(m, [
      { type: "message_start", message: assistant([]) },
      { type: "message_end", message: toolTurn },
      { type: "message_start", message: assistant([]) },
      delta("text_delta", "ok"),
      { type: "message_end", message: assistant([{ type: "text", text: "ok" }]) },
    ] as AgentSessionEvent[]);
    expect(events).toEqual([
      { type: "message_end", messageId: "msg_1", text: "" },
      { type: "usage", inputTokens: 150, outputTokens: 20 },
      { type: "text_delta", messageId: "msg_2", delta: "ok" },
      { type: "message_end", messageId: "msg_2", text: "ok" },
      { type: "usage", inputTokens: 150, outputTokens: 20, costUsd: 0.0001 },
    ]);
  });

  it("maps the tool lifecycle, preferring the ToolSpec's own result", () => {
    const { mapper: m, ledger } = mapper();
    ledger.recordResult("call_1", {
      content: [{ type: "text", text: "raw" }],
      details: { rich: true },
    });
    const events = run(m, [
      { type: "tool_execution_start", toolCallId: "call_1", toolName: "echo", args: { a: 1 } },
      {
        type: "tool_execution_update",
        toolCallId: "call_1",
        toolName: "echo",
        args: { a: 1 },
        partialResult: { content: [{ type: "text", text: "50%" }], details: { p: 50 } },
      },
      {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "echo",
        result: { content: [{ type: "text", text: "raw" }], details: {} },
        isError: false,
      },
    ] as AgentSessionEvent[]);
    expect(events).toEqual([
      { type: "tool_start", toolCallId: "call_1", toolName: "echo", input: { a: 1 } },
      {
        type: "tool_update",
        toolCallId: "call_1",
        partial: { content: [{ type: "text", text: "50%" }], details: { p: 50 } },
      },
      {
        type: "tool_end",
        toolCallId: "call_1",
        toolName: "echo",
        result: { content: [{ type: "text", text: "raw" }], details: { rich: true } },
        isError: false,
      },
    ]);
  });

  it("flags blocked calls and converts built-in results", () => {
    const { mapper: m, ledger } = mapper();
    ledger.block("call_2", "needs approval");
    const events = run(m, [
      {
        type: "tool_execution_end",
        toolCallId: "call_2",
        toolName: "delete_everything",
        result: {
          content: [{ type: "text", text: "Blocked by safety policy: needs approval" }],
          details: {},
        },
        isError: true,
      },
      {
        type: "tool_execution_end",
        toolCallId: "call_3",
        toolName: "bash",
        result: {
          content: [{ type: "text", text: "boom\n\nCommand exited with code 1" }],
          details: {},
        },
        isError: true,
      },
    ] as AgentSessionEvent[]);
    expect(events).toEqual([
      {
        type: "tool_end",
        toolCallId: "call_2",
        toolName: "delete_everything",
        result: {
          content: [{ type: "text", text: "Blocked by safety policy: needs approval" }],
          isError: true,
        },
        isError: true,
        blocked: true,
      },
      {
        type: "tool_end",
        toolCallId: "call_3",
        toolName: "bash",
        result: {
          content: [{ type: "text", text: "boom\n\nCommand exited with code 1" }],
          details: {},
          isError: true,
        },
        isError: true,
      },
    ]);
  });

  it("reports model failures once Pi stops retrying, and stays quiet on aborts", () => {
    const { mapper: m } = mapper();
    const failed = assistant([], {
      stopReason: "error",
      errorMessage: "401 invalid key",
      usage: { ...assistant([]).usage, input: 0, output: 0, cacheRead: 0 },
    });
    const aborted = assistant([], { stopReason: "aborted", usage: failed.usage });
    const events = run(m, [
      { type: "message_start", message: assistant([]) },
      { type: "message_end", message: failed },
      { type: "agent_end", messages: [user, failed], willRetry: true },
      { type: "message_start", message: assistant([]) },
      { type: "message_end", message: failed },
      { type: "agent_end", messages: [user, failed], willRetry: false },
      { type: "message_start", message: assistant([]) },
      { type: "message_end", message: aborted },
      { type: "agent_end", messages: [user, aborted], willRetry: false },
    ] as AgentSessionEvent[]);
    expect(events).toEqual([{ type: "error", message: "401 invalid key" }]);
  });

  it("closes a partially streamed message that then failed", () => {
    const { mapper: m } = mapper();
    const events = run(m, [
      { type: "message_start", message: assistant([]) },
      delta("text_delta", "par"),
      {
        type: "message_end",
        message: assistant([{ type: "text", text: "par" }], { stopReason: "aborted" }),
      },
    ] as AgentSessionEvent[]);
    expect(events.map((e) => e.type)).toEqual(["text_delta", "message_end", "usage"]);
  });

  it("ignores events it has no mapping for", () => {
    const { mapper: m } = mapper();
    expect(
      run(m, [
        { type: "queue_update", steering: ["x"], followUp: [] },
        { type: "compaction_start", reason: "threshold" },
        { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "503" },
      ] as AgentSessionEvent[]),
    ).toEqual([]);
  });
});
