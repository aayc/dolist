import { type ToolSpec, textResult } from "@ddl/core";
import { describe, expect, it, vi } from "vitest";
import type { ToolCallDecision, ToolCallRequest } from "../types";
import { decideToolCall, type GateOptions } from "./gate";
import { ToolCallLedger } from "./ledger";

const echo: ToolSpec = {
  name: "echo",
  label: "Echo",
  description: "",
  parameters: { type: "object" },
  safety: { readOnly: true },
  execute: async () => textResult("x"),
};

function options(
  beforeToolCall: (call: ToolCallRequest) => Promise<ToolCallDecision>,
  overrides: Partial<GateOptions> = {},
): GateOptions {
  return {
    sessionId: "thr_1",
    role: "subagent",
    specs: new Map([["echo", echo]]),
    beforeToolCall,
    ledger: new ToolCallLedger(),
    isClosed: () => false,
    onInstalled: () => {},
    ...overrides,
  };
}

const call = (toolName: string, toolCallId = "call_1") => ({
  toolCallId,
  toolName,
  input: { a: 1 },
});

describe("decideToolCall", () => {
  it("asks the gate with the full request and approves the exact call", async () => {
    const gate = vi.fn(async (_call: ToolCallRequest) => ({ allow: true }) as const);
    const opts = options(gate);
    expect(await decideToolCall(call("echo"), {}, opts)).toBeUndefined();
    expect(gate).toHaveBeenCalledWith({
      sessionId: "thr_1",
      role: "subagent",
      toolCallId: "call_1",
      toolName: "echo",
      input: { a: 1 },
      spec: echo,
    });
    expect(opts.ledger.consumeApproval("call_1")).toBe(true);
  });

  it("omits spec for built-ins", async () => {
    const gate = vi.fn(async (_call: ToolCallRequest) => ({ allow: true }) as const);
    await decideToolCall(call("bash"), {}, options(gate));
    expect(gate.mock.calls[0]?.[0]).not.toHaveProperty("spec");
  });

  it("blocks denied calls with the reason", async () => {
    const opts = options(async () => ({ allow: false, reason: "needs approval" }));
    expect(await decideToolCall(call("echo"), {}, opts)).toEqual({
      block: true,
      reason: "Blocked by safety policy: needs approval",
    });
    expect(opts.ledger.consumeApproval("call_1")).toBe(false);
    expect(opts.ledger.settle("call_1").blockedReason).toBe("needs approval");
  });

  it.each([
    ["throws", () => Promise.reject(new Error("boom"))],
    [
      "throws synchronously",
      () => {
        throw new Error("sync boom");
      },
    ],
    ["returns garbage", () => Promise.resolve({ allow: "yes" } as unknown as ToolCallDecision)],
    ["returns nothing", () => Promise.resolve(undefined as unknown as ToolCallDecision)],
  ])("fails closed when the gate %s", async (_label, gate) => {
    const opts = options(gate as GateOptions["beforeToolCall"]);
    const result = await decideToolCall(call("echo"), {}, opts);
    expect(result?.block).toBe(true);
    expect(opts.ledger.consumeApproval("call_1")).toBe(false);
  });

  it("stops waiting for a pending approval when the run is aborted", async () => {
    const controller = new AbortController();
    const opts = options(() => new Promise(() => {}));
    const pending = decideToolCall(call("echo"), { signal: controller.signal }, opts);
    controller.abort();
    expect(await pending).toEqual({
      block: true,
      reason: "Blocked by safety policy: the run was aborted",
    });
  });

  it("blocks everything once the session is closed", async () => {
    const gate = vi.fn(async (_call: ToolCallRequest) => ({ allow: true }) as const);
    const result = await decideToolCall(call("echo"), {}, options(gate, { isClosed: () => true }));
    expect(result?.block).toBe(true);
    expect(gate).not.toHaveBeenCalled();
  });
});
