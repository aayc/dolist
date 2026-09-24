import { type ToolResult, type ToolSpec, textResult } from "@ddl/core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ToolCallLedger } from "./ledger";
import {
  type AnyToolDefinition,
  guardDefinition,
  ToolNotApprovedError,
  ToolResultError,
  toAgentToolResult,
  toolSpecToDefinition,
  toToolResult,
} from "./tools";

const ctx = {} as ExtensionContext;

function spec(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    name: "lookup",
    label: "Lookup",
    description: "Look something up",
    parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    safety: { readOnly: true },
    execute: async () => textResult("ok"),
    ...overrides,
  };
}

describe("toolSpecToDefinition", () => {
  it("maps metadata, schema and execution mode", () => {
    const ledger = new ToolCallLedger();
    const readOnly = toolSpecToDefinition(spec(), { ledger });
    expect(readOnly).toMatchObject({
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      executionMode: "parallel",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    });
    const writer = toolSpecToDefinition(spec({ safety: { destructive: true } }), { ledger });
    expect(writer.executionMode).toBe("sequential");
  });

  it("passes input, call id, signal and partial updates through and records the result", async () => {
    const ledger = new ToolCallLedger();
    const execute = vi.fn<ToolSpec["execute"]>(async (_input, context) => {
      context.onUpdate?.({ content: [{ type: "text", text: "half" }], details: { p: 50 } });
      return {
        content: [
          { type: "text", text: "done" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
        ],
        details: { p: 100 },
      };
    });
    const definition = toolSpecToDefinition(spec({ execute }), { ledger });
    const controller = new AbortController();
    const onUpdate = vi.fn();
    const result = await definition.execute("call_1", { q: "x" }, controller.signal, onUpdate, ctx);

    expect(execute).toHaveBeenCalledWith(
      { q: "x" },
      expect.objectContaining({ toolCallId: "call_1", signal: controller.signal }),
    );
    expect(onUpdate).toHaveBeenCalledWith({
      content: [{ type: "text", text: "half" }],
      details: { p: 50 },
    });
    expect(result).toEqual({
      content: [
        { type: "text", text: "done" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ],
      details: { p: 100 },
    });
    expect(ledger.settle("call_1").result?.details).toEqual({ p: 100 });
  });

  it("throws isError results so Pi marks them as errors, keeping the original for the UI", async () => {
    const ledger = new ToolCallLedger();
    const failure: ToolResult = {
      content: [{ type: "text", text: "not found" }],
      details: { code: 404 },
      isError: true,
    };
    const definition = toolSpecToDefinition(spec({ execute: async () => failure }), { ledger });
    const error = await definition
      .execute("call_2", { q: "x" }, undefined, undefined, ctx)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolResultError);
    expect((error as Error).message).toBe("Error: not found");
    expect(ledger.settle("call_2").result).toBe(failure);
  });

  it("does not double-prefix errors and describes empty ones", async () => {
    const ledger = new ToolCallLedger();
    const run = (result: ToolResult) =>
      toolSpecToDefinition(spec({ execute: async () => result }), { ledger })
        .execute("c", {}, undefined, undefined, ctx)
        .catch((e: Error) => e.message);
    expect(await run({ content: [{ type: "text", text: "Error: bad" }], isError: true })).toBe(
      "Error: bad",
    );
    expect(await run({ content: [], isError: true })).toMatch(/^Error: /);
  });

  it("propagates thrown errors and aborts", async () => {
    const ledger = new ToolCallLedger();
    const controller = new AbortController();
    const definition = toolSpecToDefinition(
      spec({
        execute: async (_input, context) => {
          controller.abort();
          throw context.signal?.reason ?? new Error("no signal");
        },
      }),
      { ledger },
    );
    await expect(
      definition.execute("c", {}, controller.signal, undefined, ctx),
    ).rejects.toBeDefined();
    expect(ledger.settle("c").result).toBeUndefined();
  });
});

describe("guardDefinition", () => {
  it("runs a call only once, and only after the gate approved it", async () => {
    const ledger = new ToolCallLedger();
    const execute = vi.fn(async () => ({ content: [], details: undefined }));
    const definition: AnyToolDefinition = {
      name: "t",
      label: "t",
      description: "",
      parameters: {},
      execute,
    };
    const guarded = guardDefinition(definition, ledger);
    await expect(guarded.execute("call_1", {}, undefined, undefined, ctx)).rejects.toBeInstanceOf(
      ToolNotApprovedError,
    );
    ledger.approve("call_1");
    await guarded.execute("call_1", {}, undefined, undefined, ctx);
    await expect(guarded.execute("call_1", {}, undefined, undefined, ctx)).rejects.toBeInstanceOf(
      ToolNotApprovedError,
    );
    ledger.approve("call_2");
    ledger.block("call_2", "no");
    await expect(guarded.execute("call_2", {}, undefined, undefined, ctx)).rejects.toBeInstanceOf(
      ToolNotApprovedError,
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("result conversion", () => {
  it("round-trips content and details", () => {
    const result: ToolResult = {
      content: [
        { type: "text", text: "a" },
        { type: "image", data: "eA==", mimeType: "image/jpeg" },
      ],
      details: { n: 1 },
    };
    expect(toToolResult(toAgentToolResult(result), false)).toEqual(result);
  });

  it("tolerates Pi-shaped oddities", () => {
    expect(toToolResult(undefined, true)).toEqual({ content: [], isError: true });
    expect(
      toToolResult(
        {
          content: [{ type: "text", text: "x", textSignature: "s" }, { type: "audio" }, null],
          details: null,
        },
        false,
      ),
    ).toEqual({ content: [{ type: "text", text: "x" }] });
  });
});
