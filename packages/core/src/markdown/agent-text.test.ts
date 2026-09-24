import { describe, expect, it } from "vitest";
import { isAgentLine, markAgentLine, parseAgentLine, stripAgentMarker } from "./agent-text";
import { anchorableLines, resolveLineAnchors } from "./anchors";
import { trackTasks } from "./task-tracker";
import { parseTasks } from "./tasks";

describe("agent text markers", () => {
  it("marks a line with the thread that wrote it", () => {
    expect(markAgentLine("  - Booked Trattoria Sole, Fri 7pm", "thr_abc")).toBe(
      "  - Booked Trattoria Sole, Fri 7pm %%agent:thr_abc%%",
    );
    expect(markAgentLine("- Found 3 options")).toBe("- Found 3 options %%agent%%");
  });

  it("replaces an existing marker and never marks a blank line", () => {
    expect(markAgentLine("- x %%agent:thr_old%%", "thr_new")).toBe("- x %%agent:thr_new%%");
    expect(markAgentLine("   ", "thr_1")).toBe("");
    expect(markAgentLine("- y", "not a valid id!")).toBe("- y %%agent%%");
  });

  it("parses the text, the thread and where the marker starts", () => {
    expect(parseAgentLine("- Booked %%agent:thr_1%%")).toEqual({
      text: "- Booked",
      threadId: "thr_1",
      markerFrom: 8,
    });
    expect(parseAgentLine("- mine")).toBeNull();
    expect(parseAgentLine("%%agent%% in the middle is not a marker")).toBeNull();
    expect(isAgentLine("- ok %%agent%%  ")).toBe(true);
    expect(stripAgentMarker("- ok %%agent:t%%")).toBe("- ok");
  });

  it("keeps agent-written tasks' identity by their visible text and flags them", () => {
    const tasks = parseTasks(
      "- [ ] Call the restaurant to confirm %%agent:thr_9%%\n- [ ] Mine\n  - note %%agent%%",
    );
    expect(tasks.map((t) => [t.text, t.agent ?? false])).toEqual([
      ["Call the restaurant to confirm", true],
      ["Mine", false],
    ]);
    expect(tasks[1]!.notes).toEqual(["note"]);
    const { tasks: tracked } = trackTasks([], tasks, { idFactory: () => "t", now: 1 });
    expect(tracked[0]!.agent).toBe(true);
    expect(tracked[1]!.agent).toBeUndefined();
  });
});

describe("line anchors", () => {
  const doc = [
    "# Thursday",
    "- [ ] Book a table",
    "What's the tallest building in NYC?",
    "",
    "## Trip to Lisbon %%agent:thr_2%%",
  ].join("\n");

  it("offers every non-blank, non-task line, without agent markers", () => {
    expect(anchorableLines(doc)).toEqual([
      { line: 0, text: "# Thursday" },
      { line: 2, text: "What's the tallest building in NYC?" },
      { line: 4, text: "## Trip to Lisbon" },
    ]);
  });

  it("follows a line as the user edits around and inside it", () => {
    const anchors = [{ anchorId: "anc_q", text: "What's the tallest building in NYC?", line: 2 }];
    const moved = `- [ ] New task\n${doc}`;
    expect(resolveLineAnchors(moved, anchors).get("anc_q")).toEqual({
      line: 3,
      text: "What's the tallest building in NYC?",
    });
    const edited = doc.replace("in NYC?", "in New York City?");
    expect(resolveLineAnchors(edited, anchors).get("anc_q")?.line).toBe(2);
    const deleted = doc.replace("What's the tallest building in NYC?\n", "");
    expect(resolveLineAnchors(deleted, anchors).has("anc_q")).toBe(false);
  });
});
