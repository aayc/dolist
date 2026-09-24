import type { EditorState, TransactionSpec } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { AgentSparkleWidget, buildAgentLineDecorations } from "./agent-lines";
import type { VisibleRange } from "./live-preview/decorations";
import { markedState, parsedState } from "./test-helpers";

interface Shown {
  lines: number[];
  markers: string[];
  sparkles: Array<[text: string, threadId: string | null]>;
}

function show(
  state: EditorState,
  options: { livePreview?: boolean; focused?: boolean; ranges?: VisibleRange[] } = {},
): Shown {
  const { livePreview = true, focused = false } = options;
  const ranges = options.ranges ?? [{ from: 0, to: state.doc.length }];
  const set = buildAgentLineDecorations(state, ranges, { livePreview, focused });
  const shown: Shown = { lines: [], markers: [], sparkles: [] };
  set.between(0, state.doc.length, (from, to, deco: Decoration) => {
    const spec = deco.spec as { widget?: unknown; class?: string };
    if (spec.widget instanceof AgentSparkleWidget) {
      shown.sparkles.push([state.sliceDoc(from, to), spec.widget.threadId]);
    } else if (from === to) {
      shown.lines.push(state.doc.lineAt(from).number - 1);
    } else {
      shown.markers.push(state.sliceDoc(from, to));
    }
  });
  return shown;
}

const NOTE = [
  "- [ ] Book a table for Friday dinner",
  "\t- Trattoria Sole has a table at 7 %%agent:thr_ab12%%",
  "What's the tallest building in NYC?",
  "- [ ] Call the restaurant to confirm %%agent:thr_ab12%%  ",
  "- found it %%agent%%",
].join("\n");

describe("agent line decorations", () => {
  it("color agent lines and hide their markers behind a sparkle naming the thread", () => {
    expect(show(parsedState(NOTE))).toEqual({
      lines: [1, 3, 4],
      markers: [],
      sparkles: [
        ["%%agent:thr_ab12%%", "thr_ab12"],
        ["%%agent:thr_ab12%%  ", "thr_ab12"],
        ["%%agent%%", null],
      ],
    });
  });

  it("reveal the marker (faint) while the selection is on the line, like block syntax", () => {
    const state = markedState(NOTE.replace("at 7", "at| 7"));
    expect(show(state, { focused: true })).toMatchObject({
      markers: ["%%agent:thr_ab12%%"],
      sparkles: [
        ["%%agent:thr_ab12%%  ", "thr_ab12"],
        ["%%agent%%", null],
      ],
    });
    // Nothing is revealed without focus.
    expect(show(state).markers).toEqual([]);
  });

  it("show every marker faint in source mode", () => {
    expect(show(parsedState(NOTE), { livePreview: false })).toEqual({
      lines: [1, 3, 4],
      markers: ["%%agent:thr_ab12%%", "%%agent:thr_ab12%%  ", "%%agent%%"],
      sparkles: [],
    });
  });

  it("only decorate the visible ranges, once per line", () => {
    const state = parsedState(NOTE);
    const line = (n: number) => state.doc.line(n + 1);
    const shown = show(state, {
      ranges: [
        { from: line(1).from, to: line(1).to },
        { from: line(1).to, to: line(3).to },
      ],
    });
    expect(shown.lines).toEqual([1, 3]);
    expect(shown.sparkles).toHaveLength(2);
  });

  it("start the replaced range at the marker, after syntax the live preview hides", () => {
    const state = parsedState("# %%agent:thr_1%%\n> %%agent%%\n- [ ] %%agent%%");
    expect(show(state).sparkles.map(([text]) => text)).toEqual([
      "%%agent:thr_1%%",
      "%%agent%%",
      "%%agent%%",
    ]);
  });

  it("ignore markers that aren't at the end of the line", () => {
    expect(show(parsedState("%%agent%% then text\n- x %%agent%%y"))).toEqual({
      lines: [],
      markers: [],
      sparkles: [],
    });
  });
});

describe("typing on an agent line", () => {
  /** Types `text` at the caret like a user would, returning the marked document. */
  function type(marked: string, text: string): string {
    let state = markedState(marked);
    for (const ch of text) {
      const { from, to } = state.selection.main;
      state = state.update({
        changes: { from, to, insert: ch },
        selection: { anchor: from + ch.length },
        userEvent: "input.type",
      }).state;
    }
    const head = state.selection.main.head;
    const doc = state.doc.toString();
    return `${doc.slice(0, head)}|${doc.slice(head)}`;
  }

  it("keeps the marker last when typing after it", () => {
    expect(type("- Found it %%agent:thr_1%%|", " today")).toBe("- Found it today| %%agent:thr_1%%");
    expect(type("- [ ] Call %%agent:t%%  |", "!")).toBe("- [ ] Call!| %%agent:t%%  ");
    expect(type("- x%%agent%%|", "y")).toBe("- xy|%%agent%%");
    expect(type("- x %%age|nt%%", "y")).toBe("- xy| %%agent%%");
  });

  it("leaves typing elsewhere, and on the user's lines, as it is", () => {
    expect(type("- Fo|und %%agent%%", "x")).toBe("- Fox|und %%agent%%");
    expect(type("- Found| %%agent%%", "!")).toBe("- Found!| %%agent%%");
    expect(type("- mine|", " too")).toBe("- mine too|");
  });

  it("doesn't move line breaks, compositions or replacements", () => {
    const state = markedState("- Found %%agent%%|");
    const at = state.selection.main.head;
    const doc = (spec: TransactionSpec) => state.update(spec).state.doc.toString();
    expect(doc({ changes: { from: at, insert: "\n- " }, userEvent: "input" })).toBe(
      "- Found %%agent%%\n- ",
    );
    expect(doc({ changes: { from: at, insert: "é" }, userEvent: "input.type.compose" })).toBe(
      "- Found %%agent%%é",
    );
    expect(doc({ changes: { from: at - 2, to: at, insert: "x" }, userEvent: "input.type" })).toBe(
      "- Found %%agentx",
    );
    expect(doc({ changes: { from: at, insert: "y" } })).toBe("- Found %%agent%%y");
  });
});
