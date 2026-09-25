import type { ApprovalRequest, TaskAgentStatus, ThreadMessage, ToolCallMessage } from "@ddl/core";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_TEXT,
  activityLabel,
  clipText,
  deriveActivity,
  pendingApprovalOf,
  type ToolCallLike,
} from "./activity";

/*
 * Activity labels, shared with the macOS app (`ActivityLabelTests`): same cases, same wording.
 * Values are quoted with “ ”, clipped to 40 grapheme clusters, and never include typed text.
 */
const LABELS: ReadonlyArray<[ToolCallLike, string]> = [
  [{ toolName: "computer_open_app", input: { app: "Safari" } }, "Opening Safari…"],
  [{ toolName: "computer_open_app", input: {} }, "Opening an app…"],
  [{ toolName: "computer_app_state", input: { app: "Notes" } }, "Looking at Notes…"],
  [{ toolName: "computer_screenshot", input: { app: "Mail" } }, "Looking at Mail…"],
  [{ toolName: "computer_screenshot", input: {} }, "Looking at the screen…"],
  [
    { toolName: "computer_press", input: { app: "Mail", id: "e12", element: "Send" } },
    "Pressing “Send” in Mail…",
  ],
  [
    { toolName: "computer_press", input: { app: "Mail", id: "e12" } },
    "Pressing a control in Mail…",
  ],
  [
    { toolName: "computer_set_value", input: { app: "Notes", id: "e3", value: "secret plans" } },
    "Typing in Notes…",
  ],
  [{ toolName: "computer_type", input: { app: "TextEdit", text: "hello" } }, "Typing in TextEdit…"],
  [{ toolName: "computer_type", input: { text: "hello" } }, "Typing…"],
  [
    { toolName: "computer_key", input: { combo: "cmd+s", app: "Pages" } },
    "Pressing cmd+s in Pages…",
  ],
  [{ toolName: "computer_key", input: { combo: "return" } }, "Pressing return…"],
  [{ toolName: "computer_key", input: {} }, "Pressing a key…"],
  [
    { toolName: "computer_click", input: { app: "Finder", x: 10, y: 20, element: "Downloads" } },
    "Clicking in Finder…",
  ],
  [
    { toolName: "computer_click", input: { x: 10, y: 20, element: "Dock" } },
    "Clicking on the screen…",
  ],
  [{ toolName: "computer_scroll", input: { app: "Safari", dx: 0, dy: 5 } }, "Scrolling in Safari…"],
  [{ toolName: "computer_scroll", input: { dx: 0, dy: 5 } }, "Scrolling on the screen…"],
  [
    { toolName: "browser_navigate", input: { url: "https://www.example.com/a/b?q=1" } },
    "Opening example.com…",
  ],
  [{ toolName: "browser_navigate", input: { url: "shop.example/cart" } }, "Opening shop.example…"],
  [{ toolName: "browser_navigate", input: { url: "not a url" } }, "Opening a page…"],
  [{ toolName: "browser_snapshot", input: {} }, "Reading the page…"],
  [{ toolName: "browser_extract_text", input: { maxChars: 4000 } }, "Reading the page…"],
  [
    { toolName: "browser_click", input: { element: "Place order", ref: "e5" } },
    "Working in the browser…",
  ],
  [
    { toolName: "browser_type", input: { element: "Card", text: "4111" } },
    "Working in the browser…",
  ],
  [
    { toolName: "web_search", input: { query: "best espresso grinders under $300" } },
    "Searching the web for “best espresso grinders under $300”…",
  ],
  [
    {
      toolName: "web_search",
      input: { query: "a very long query about quiet mechanical keyboards for the office" },
    },
    "Searching the web for “a very long query about quiet mechanica…”…",
  ],
  [
    { toolName: "web_search", input: { query: "  line\nbreaks\tand   spaces " } },
    "Searching the web for “line breaks and spaces”…",
  ],
  [{ toolName: "web_search", input: {} }, "Searching the web…"],
  [
    { toolName: "web_fetch", input: { url: "https://docs.example.org/guide" } },
    "Reading docs.example.org…",
  ],
  [{ toolName: "web_fetch", input: {} }, "Reading a page…"],
  [{ toolName: "read_note", input: { path: "Daily/2026-09-24.md" } }, "Reading your notes…"],
  [{ toolName: "search_notes", input: { query: "garden" } }, "Reading your notes…"],
  [{ toolName: "edit_note", input: { edits: [] } }, "Editing your note…"],
  [{ toolName: "bash", input: { command: "ls -la" } }, "Running a command…"],
  [{ toolName: "read", input: { path: "a.txt" } }, "Looking through files…"],
  [{ toolName: "grep", input: {} }, "Looking through files…"],
  [{ toolName: "find", input: {} }, "Looking through files…"],
  [{ toolName: "ls", input: {} }, "Looking through files…"],
  [{ toolName: "write", input: { path: "a.txt", content: "x" } }, "Writing files…"],
  [{ toolName: "edit", input: {} }, "Writing files…"],
  [{ toolName: "mcp__calendar__create_event", input: {} }, "Using calendar…"],
  [{ toolName: "mcp__notes", input: {} }, "Using notes…"],
  [{ toolName: "post_update", label: "Post update", input: {} }, "Post update…"],
  [{ toolName: "create_artifact", label: "Create artifact…", input: {} }, "Create artifact…"],
  [{ toolName: "spawn_subagent", input: {} }, "Spawn subagent…"],
  [{ toolName: "computer_move", input: { x: 1, y: 2 } }, "Computer move…"],
  [
    {
      toolName: "computer_open_app",
      input: { app: "An App With A Remarkably Long Name, Pro Edition 2026" },
    },
    "Opening An App With A Remarkably Long Name, Pro…",
  ],
  [
    { toolName: "computer_press", input: { app: "Photos", id: "e1", element: "👍🏽 Like" } },
    "Pressing “👍🏽 Like” in Photos…",
  ],
  [{ toolName: "computer_open_app", input: { app: 42 } }, "Opening an app…"],
  [{ toolName: "web_search", input: null }, "Searching the web…"],
];

describe("activityLabel (shared with macOS)", () => {
  it.each(LABELS)("%j → %s", (call, label) => {
    expect(activityLabel(call)).toBe(label);
  });

  it("clips by grapheme clusters", () => {
    expect(clipText("👍🏽".repeat(45))).toBe(`${"👍🏽".repeat(39)}…`);
    expect(clipText("x".repeat(40))).toBe("x".repeat(40));
  });
});

const T0 = 1_000_000;

function text(id: string, extra: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id,
    kind: "text",
    role: "agent",
    author: "orchestrator",
    createdAt: T0,
    text: "Hi",
    ...extra,
  } as ThreadMessage;
}

function tool(
  id: string,
  status: ToolCallMessage["status"],
  toolName = "web_search",
): ThreadMessage {
  return {
    id,
    kind: "tool_call",
    author: "subagent:research",
    createdAt: T0 + 5,
    toolCallId: `call-${id}`,
    toolName,
    input: { query: "robot vacuums" },
    status,
  };
}

function approval(id: string, threadId: string, status: ApprovalRequest["status"], at = T0) {
  return {
    id,
    threadId,
    taskId: null,
    toolName: "browser_click",
    input: {},
    summary: "Place order",
    risk: "high",
    categories: ["payment"],
    reason: "Spends money",
    status,
    createdAt: at,
  } satisfies ApprovalRequest;
}

describe("deriveActivity", () => {
  const base = { messages: [] as ThreadMessage[], approval: undefined, revealing: false };

  it("says nothing unless the agent is queued or running", () => {
    for (const status of ["idle", "waiting_user", "done", "failed", "cancelled", "ignored"]) {
      expect(deriveActivity({ ...base, status: status as TaskAgentStatus })).toBeNull();
    }
    expect(deriveActivity({ ...base, status: "queued" })).toEqual({ kind: "queued" });
    expect(deriveActivity({ ...base, status: "triaging" })).toEqual({ kind: "thinking" });
  });

  it("puts a pending approval first", () => {
    const pending = approval("a1", "t1", "pending", T0 + 9);
    expect(
      deriveActivity({
        ...base,
        status: "working",
        messages: [tool("m1", "running")],
        approval: pending,
      }),
    ).toEqual({ kind: "approval", approvalId: "a1", since: T0 + 9 });
    expect(deriveActivity({ ...base, status: "waiting_approval" })).toEqual({
      kind: "approval",
      approvalId: null,
      since: null,
    });
  });

  it("then the latest running tool call", () => {
    const messages = [tool("m1", "running", "bash"), tool("m2", "ok"), tool("m3", "running")];
    expect(deriveActivity({ ...base, status: "working", messages })).toEqual({
      kind: "tool",
      messageId: "m3",
      toolName: "web_search",
      label: "Searching the web for “robot vacuums”…",
      since: T0 + 5,
    });
  });

  it("then nothing while text streams or types out, else thinking", () => {
    const streaming = [tool("m1", "ok"), text("m2", { streaming: true } as Partial<ThreadMessage>)];
    expect(deriveActivity({ ...base, status: "working", messages: streaming })).toBeNull();
    expect(
      deriveActivity({ ...base, status: "working", messages: [text("m1")], revealing: true }),
    ).toBeNull();
    expect(deriveActivity({ ...base, status: "working", messages: [text("m1")] })).toEqual({
      kind: "thinking",
    });
  });

  it("picks the thread's newest pending approval", () => {
    const approvals = {
      a: approval("a", "t1", "pending", T0),
      b: approval("b", "t1", "pending", T0 + 2),
      c: approval("c", "t2", "pending", T0 + 5),
      d: approval("d", "t1", "approved", T0 + 9),
    };
    expect(pendingApprovalOf(approvals, "t1")?.id).toBe("b");
    expect(pendingApprovalOf(approvals, "t3")).toBeUndefined();
  });

  it("uses the shared wording", () => {
    expect(ACTIVITY_TEXT).toEqual({
      queued: "Waiting to start…",
      approval: "Waiting for your approval",
      thinking: "Thinking…",
    });
  });
});
