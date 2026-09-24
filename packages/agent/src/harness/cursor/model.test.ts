import { describe, expect, it } from "vitest";
import { MessageMapper } from "./events";
import { resolveCursorModel } from "./model";
import { parseSessionUpdate } from "./protocol";

const MODELS = [
  { modelId: "composer-2.5[fast=true]", name: "Composer 2.5" },
  { modelId: "gpt-5.5[context=272k,reasoning=medium,fast=false]", name: "GPT-5.5" },
  { modelId: "auto-smart[optimize_for=balanced]", name: "Auto" },
];

describe("resolveCursorModel", () => {
  it("matches an exact id, then the base id, then the display name", () => {
    expect(resolveCursorModel("composer-2.5[fast=true]", MODELS)).toBe("composer-2.5[fast=true]");
    expect(resolveCursorModel("composer-2.5", MODELS)).toBe("composer-2.5[fast=true]");
    expect(resolveCursorModel("GPT-5.5", MODELS)).toBe(
      "gpt-5.5[context=272k,reasoning=medium,fast=false]",
    );
    expect(resolveCursorModel("auto", MODELS)).toBe("auto-smart[optimize_for=balanced]");
  });

  it("keeps configured parameters for a known base model", () => {
    expect(resolveCursorModel("gpt-5.5[reasoning=high]", MODELS)).toBe("gpt-5.5[reasoning=high]");
  });

  it("explains unknown models with a few available ids", () => {
    expect(() => resolveCursorModel("claude-9", MODELS)).toThrow(
      'The Cursor model "claude-9" isn\'t available to this Cursor account (available: composer-2.5, gpt-5.5, auto-smart). Pick one from `agent models`.',
    );
    expect(() => resolveCursorModel(" ", MODELS)).toThrow(/No Cursor model/);
    expect(() => resolveCursorModel("x", [])).toThrow(/isn't available to this Cursor account\. /);
  });
});

describe("MessageMapper", () => {
  it("gives thinking and text of one message the same id and ends it at tool calls", () => {
    let n = 0;
    const mapper = new MessageMapper(() => `msg_${++n}`);
    expect([
      ...mapper.thinkingDelta("hmm"),
      ...mapper.textDelta("Hel"),
      ...mapper.textDelta("lo"),
      ...mapper.textDelta(""),
      ...mapper.flush(),
      ...mapper.flush(),
      ...mapper.textDelta("After"),
      ...mapper.flush(),
    ]).toEqual([
      { type: "thinking_delta", messageId: "msg_1", delta: "hmm" },
      { type: "text_delta", messageId: "msg_1", delta: "Hel" },
      { type: "text_delta", messageId: "msg_1", delta: "lo" },
      { type: "message_end", messageId: "msg_1", text: "Hello" },
      { type: "text_delta", messageId: "msg_2", delta: "After" },
      { type: "message_end", messageId: "msg_2", text: "After" },
    ]);
  });

  it("ends a thinking-only message with empty text", () => {
    const mapper = new MessageMapper(() => "m");
    mapper.thinkingDelta("just thinking");
    expect(mapper.flush()).toEqual([{ type: "message_end", messageId: "m", text: "" }]);
  });
});

describe("parseSessionUpdate", () => {
  it("parses chunks and tool calls of this session and ignores the rest", () => {
    const update = (value: unknown, sessionId = "s1") =>
      parseSessionUpdate({ sessionId, update: value }, "s1");
    expect(
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }),
    ).toEqual({
      type: "agent_message_chunk",
      text: "hi",
    });
    expect(
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "image", data: "x" } }),
    ).toEqual({
      type: "agent_thought_chunk",
      text: "",
    });
    expect(
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        rawOutput: { totalMatches: 2 },
        locations: [{ path: "/w" }, { nope: 1 }],
      }),
    ).toEqual({
      type: "tool_call_update",
      call: {
        toolCallId: "t1",
        status: "completed",
        rawOutput: { totalMatches: 2 },
        locations: [{ path: "/w" }],
      },
    });
    expect(update({ sessionUpdate: "tool_call" })).toEqual({ type: "other", name: "tool_call" });
    expect(update({ sessionUpdate: "plan", entries: [] })).toEqual({ type: "other", name: "plan" });
    expect(update({ sessionUpdate: "agent_message_chunk" }, "other-session")).toBeUndefined();
    expect(parseSessionUpdate(null, "s1")).toBeUndefined();
  });
});
