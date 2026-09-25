import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { type DropGeometry, dropTarget } from "./drop";
import { insertEmbed, moveEmbed, removeEmbed, resizeEmbed } from "./edits";
import { embedAt, embedOfLine } from "./parse";
import type { BlockEmbed } from "./types";

function line(text: string, from = 0) {
  return { from, to: from + text.length, text };
}

function state(doc: string, cursor = 0): EditorState {
  return EditorState.create({ doc, selection: { anchor: cursor } });
}

function embedOn(s: EditorState, lineNumber: number): BlockEmbed {
  const embed = embedOfLine(s.doc.line(lineNumber));
  if (!embed) throw new Error(`no embed on line ${lineNumber}`);
  return embed;
}

describe("embedOfLine: which lines are embeds", () => {
  it("reads an embed alone on its line, with the plugin's modifiers", () => {
    expect(embedOfLine(line("![[Plan.excalidraw|360|right-wrap]]", 10))).toEqual({
      from: 10,
      to: 45,
      lineFrom: 10,
      lineTo: 45,
      text: "![[Plan.excalidraw|360|right-wrap]]",
      spec: { target: "Plan.excalidraw", width: 360, placement: "right-wrap" },
    });
  });

  it("defaults to full width and reads sizes, percentages and aligned rows", () => {
    expect(embedOfLine(line("![[Plan.excalidraw]]"))?.spec).toEqual({
      target: "Plan.excalidraw",
      placement: "full",
    });
    expect(embedOfLine(line("![[photo.png|300x200]]"))?.spec).toEqual({
      target: "photo.png",
      width: 300,
      height: 200,
      placement: "full",
    });
    expect(embedOfLine(line("![[Plan.excalidraw|50%|center]]"))?.spec).toMatchObject({
      widthPercent: 50,
      placement: "center",
    });
    expect(embedOfLine(line("![[Plan.excalidraw|Plan|240|left]]"))?.spec).toMatchObject({
      alias: "Plan",
      width: 240,
      placement: "left",
    });
  });

  it("allows whitespace around it, and keeps its offsets on the embed itself", () => {
    const embed = embedOfLine(line("  ![[a.excalidraw]] \t"));
    expect(embed).toMatchObject({ from: 2, to: 19, lineFrom: 0, lineTo: 21 });
  });

  it("leaves embeds among other text, links, and several embeds as text", () => {
    expect(embedOfLine(line("see ![[a.excalidraw]]"))).toBeNull();
    expect(embedOfLine(line("![[a.excalidraw]] and more"))).toBeNull();
    expect(embedOfLine(line("- ![[a.excalidraw]]"))).toBeNull();
    expect(embedOfLine(line("![[a.excalidraw]]![[b.excalidraw]]"))).toBeNull();
    expect(embedOfLine(line("[[a.excalidraw]]"))).toBeNull();
    expect(embedOfLine(line(""))).toBeNull();
  });

  it("finds the embed at its `![[` only", () => {
    const s = state("text\n![[a.excalidraw|200|left-wrap]]");
    expect(embedAt(s.doc, 5)?.spec.width).toBe(200);
    expect(embedAt(s.doc, 6)).toBeNull();
    expect(embedAt(s.doc, 0)).toBeNull();
    expect(embedAt(s.doc, 999)).toBeNull();
  });
});

describe("moveEmbed: dragging to another line or side", () => {
  const doc = "one\n![[a.excalidraw|360|right-wrap]]\ntwo\nthree";

  it("moves the line down, before the line it's dropped above", () => {
    const s = state(doc);
    const edit = moveEmbed(s, embedOn(s, 2), { before: 3, placement: "right-wrap" });
    const next = s.update(edit!.spec).state;
    expect(next.doc.toString()).toBe("one\ntwo\n![[a.excalidraw|360|right-wrap]]\nthree");
    expect(embedAt(next.doc, edit!.from)?.text).toBe("![[a.excalidraw|360|right-wrap]]");
    expect(edit!.spec.userEvent).toBe("move.embed");
  });

  it("moves it up and to the other side", () => {
    const s = state(doc);
    const edit = moveEmbed(s, embedOn(s, 2), { before: 0, placement: "left-wrap" });
    const next = s.update(edit!.spec).state;
    expect(next.doc.toString()).toBe("![[a.excalidraw|360|left-wrap]]\none\ntwo\nthree");
    expect(edit!.from).toBe(0);
  });

  it("moves it after the last line, and from the last line", () => {
    const s = state(doc);
    const toEnd = moveEmbed(s, embedOn(s, 2), { before: 4, placement: "right-wrap" })!;
    const end = s.update(toEnd.spec).state;
    expect(end.doc.toString()).toBe("one\ntwo\nthree\n![[a.excalidraw|360|right-wrap]]");
    expect(embedAt(end.doc, toEnd.from)).not.toBeNull();
    const back = moveEmbed(end, embedOn(end, 4), { before: 1, placement: "right-wrap" })!;
    expect(end.update(back.spec).state.doc.toString()).toBe(doc);
  });

  it("dropped next to its own line, only changes the placement", () => {
    const s = state(doc);
    const embed = embedOn(s, 2);
    expect(moveEmbed(s, embed, { before: 1, placement: "right-wrap" })).toBeNull();
    expect(moveEmbed(s, embed, { before: 2, placement: "right-wrap" })).toBeNull();
    const edit = moveEmbed(s, embed, { before: 2, placement: "left-wrap" })!;
    expect(s.update(edit.spec).state.doc.toString()).toBe(
      "one\n![[a.excalidraw|360|left-wrap]]\ntwo\nthree",
    );
    expect(edit.spec.userEvent).toBe("input.embed");
  });

  it("full width drops the size, and keeps a style that isn't a placement", () => {
    const s = state("![[a.excalidraw|360x200|right-wrap]]\nx");
    const edit = moveEmbed(s, embedOn(s, 1), { before: 1, placement: "full" })!;
    expect(s.update(edit.spec).state.doc.toString()).toBe("![[a.excalidraw]]\nx");
    const styled = state("![[a.excalidraw|360|dark]]\nx");
    const moved = moveEmbed(styled, embedOn(styled, 1), { before: 2, placement: "full" })!;
    expect(styled.update(moved.spec).state.doc.toString()).toBe("x\n![[a.excalidraw|dark]]");
  });

  it("keeps the caret on the text it was on", () => {
    const s = state(doc, doc.indexOf("three") + 2);
    const edit = moveEmbed(s, embedOn(s, 2), { before: 0, placement: "left-wrap" })!;
    const next = s.update(edit.spec).state;
    expect(next.doc.sliceString(next.selection.main.head - 2, next.selection.main.head + 3)).toBe(
      "three",
    );
  });
});

describe("resizeEmbed and removeEmbed", () => {
  it("sets the width, keeping the placement and scaling a given height", () => {
    const s = state("![[a.excalidraw|360|right-wrap]]");
    const edit = resizeEmbed(embedOn(s, 1), 280.4)!;
    expect(s.update(edit.spec).state.doc.toString()).toBe("![[a.excalidraw|280|right-wrap]]");
    const sized = state("![[a.excalidraw|300x200|left]]");
    const scaled = resizeEmbed(embedOn(sized, 1), 450)!;
    expect(sized.update(scaled.spec).state.doc.toString()).toBe("![[a.excalidraw|450x300|left]]");
    expect(resizeEmbed(embedOn(s, 1), 360)).toBeNull();
  });

  it("replaces a percentage and never goes below the minimum", () => {
    const s = state("![[a.excalidraw|50%]]");
    const edit = resizeEmbed(embedOn(s, 1), 2)!;
    expect(s.update(edit.spec).state.doc.toString()).toBe("![[a.excalidraw|48]]");
  });

  it("removes the embed's line with one line break, wherever it is", () => {
    const middle = state("a\n![[x.excalidraw]]\nb");
    expect(middle.update(removeEmbed(middle, embedOn(middle, 2))).state.doc.toString()).toBe(
      "a\nb",
    );
    const last = state("a\n![[x.excalidraw]]");
    expect(last.update(removeEmbed(last, embedOn(last, 2))).state.doc.toString()).toBe("a");
    const only = state("![[x.excalidraw]]");
    expect(only.update(removeEmbed(only, embedOn(only, 1))).state.doc.toString()).toBe("");
    expect(removeEmbed(only, embedOn(only, 1)).userEvent).toBe("delete.embed");
  });
});

describe("insertEmbed: at the caret's line, with the caret off the embed", () => {
  it("goes above a line with text", () => {
    const s = state("first\nsecond line", 9);
    const edit = insertEmbed(s, "![[a.excalidraw|360|right-wrap]]");
    const next = s.update(edit.spec).state;
    expect(next.doc.toString()).toBe("first\n![[a.excalidraw|360|right-wrap]]\nsecond line");
    expect(edit.from).toBe(6);
    expect(next.doc.lineAt(next.selection.main.head).text).toBe("second line");
  });

  it("goes above the line even with the caret at its start", () => {
    const s = state("first\nsecond", 6);
    const next = s.update(insertEmbed(s, "![[a.excalidraw]]").spec).state;
    expect(next.doc.lineAt(next.selection.main.head).text).toBe("second");
  });

  it("takes a blank line, with a new line after it for the caret", () => {
    const s = state("first\n\nlast", 6);
    const edit = insertEmbed(s, "![[a.excalidraw]]");
    const next = s.update(edit.spec).state;
    expect(next.doc.toString()).toBe("first\n![[a.excalidraw]]\n\nlast");
    expect(next.doc.lineAt(next.selection.main.head).number).toBe(3);
    expect(embedAt(next.doc, edit.from)).not.toBeNull();
  });
});

describe("dropTarget: where a dragged embed lands", () => {
  const geometry: DropGeometry = {
    lineAt: (y) => {
      const index = Math.min(Math.max(Math.floor(y / 20), 0), 9);
      return { index, top: index * 20, bottom: index * 20 + 20 };
    },
    lineCount: 10,
    left: 100,
    right: 700,
  };

  it("goes between the two lines nearest the pointer", () => {
    expect(dropTarget({ x: 400, y: 45 }, geometry)).toEqual({
      before: 2,
      placement: "full",
      y: 40,
    });
    expect(dropTarget({ x: 400, y: 55 }, geometry)).toMatchObject({ before: 3, y: 60 });
  });

  it("floats left or right in the outer thirds of the column", () => {
    expect(dropTarget({ x: 150, y: 5 }, geometry).placement).toBe("left-wrap");
    expect(dropTarget({ x: 299, y: 5 }, geometry).placement).toBe("left-wrap");
    expect(dropTarget({ x: 301, y: 5 }, geometry).placement).toBe("full");
    expect(dropTarget({ x: 650, y: 5 }, geometry).placement).toBe("right-wrap");
  });

  it("stays within the document", () => {
    expect(dropTarget({ x: 400, y: -50 }, geometry).before).toBe(0);
    expect(dropTarget({ x: 400, y: 5000 }, geometry).before).toBe(10);
  });
});
