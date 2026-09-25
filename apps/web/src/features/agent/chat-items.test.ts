import type { ThreadMessage, ToolCallMessage } from "@ddl/core";
import { describe, expect, it } from "vitest";
import { chatItems } from "./chat-items";

function tool(id: string, status: ToolCallMessage["status"] = "ok"): ThreadMessage {
  return {
    id,
    kind: "tool_call",
    author: "subagent:research",
    createdAt: 1,
    toolCallId: `c-${id}`,
    toolName: "web_search",
    input: {},
    status,
  };
}

function text(id: string): ThreadMessage {
  return { id, kind: "text", role: "agent", author: "orchestrator", createdAt: 1, text: id };
}

/** Rows as short strings: `t1` a message, `[t1 t2]` a group. */
function rows(messages: ThreadMessage[]): string[] {
  return chatItems(messages).map((item) =>
    item.kind === "tools" ? `[${item.calls.map((c) => c.id).join(" ")}]` : item.message.id,
  );
}

describe("chatItems", () => {
  it("collapses two or more consecutive finished calls", () => {
    expect(rows([text("a"), tool("1"), tool("2"), tool("3"), text("b")])).toEqual([
      "a",
      "[1 2 3]",
      "b",
    ]);
    expect(rows([text("a"), tool("1"), text("b")])).toEqual(["a", "1", "b"]);
  });

  it("keeps running and failed calls visible, splitting groups", () => {
    expect(
      rows([tool("1"), tool("2"), tool("3", "error"), tool("4"), tool("5"), tool("6", "running")]),
    ).toEqual(["[1 2]", "3", "[4 5]", "6"]);
    expect(rows([tool("1"), tool("2"), tool("3", "blocked"), text("z")])).toEqual([
      "[1 2]",
      "3",
      "z",
    ]);
  });

  it("leaves the call that just finished out while it's the last message", () => {
    expect(rows([text("a"), tool("1"), tool("2")])).toEqual(["a", "1", "2"]);
    expect(rows([text("a"), tool("1"), tool("2"), tool("3")])).toEqual(["a", "[1 2]", "3"]);
    // The next step folds it in: same group id, so an open group stays open.
    const before = chatItems([text("a"), tool("1"), tool("2"), tool("3")]);
    const after = chatItems([text("a"), tool("1"), tool("2"), tool("3"), tool("4", "running")]);
    expect(before[1]).toMatchObject({ kind: "tools", id: "1" });
    expect(after[1]).toMatchObject({ kind: "tools", id: "1" });
    expect(rows([tool("1"), tool("2"), tool("3"), tool("4", "running")])).toEqual(["[1 2 3]", "4"]);
  });

  it("passes everything else through in order", () => {
    expect(rows([])).toEqual([]);
    expect(rows([text("a"), text("b")])).toEqual(["a", "b"]);
  });
});
