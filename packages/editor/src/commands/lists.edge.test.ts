import { indentLess, undo } from "@codemirror/commands";
import { deleteMarkupBackward } from "@codemirror/lang-markdown";
import type { StateCommand } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { markdownEditingKeymap } from "../keymap";
import { markedState, run, runMarked, showSelection } from "../test-helpers";
import { indentListItemOrInsertTab } from "./lists";

/** Enter exactly as bound: every markdown Enter binding in keymap order. */
const enter: StateCommand = (target) =>
  markdownEditingKeymap
    .filter((binding) => binding.key === "Enter")
    .some((binding) => binding.run?.(target as unknown as EditorView) ?? false);

const cases = (command: StateCommand, table: Array<[string, string | null]>) => {
  for (const [input, output] of table) {
    expect(runMarked(input, command), JSON.stringify(input)).toBe(output);
  }
};

describe("Enter: list and task continuation edge cases", () => {
  it("continues nested items with their indentation (spaces are kept unless a tab stop)", () => {
    cases(enter, [
      ["- a\n\t- b|", "- a\n\t- b\n\t- |"],
      ["- a\n  - b|", "- a\n  - b\n  - |"],
      // Four spaces are one indent unit, which is a tab in this editor.
      ["- a\n    - b|", "- a\n    - b\n\t- |"],
      ["\t\t- [ ] a|", "\t\t- [ ] a\n\t\t- [ ] |"],
      ["  - a|", "  - a\n  - |"],
    ]);
  });

  it("numbers ordered items (both delimiters) and renumbers the rest", () => {
    cases(enter, [
      ["1. a|", "1. a\n2. |"],
      ["1) a|", "1) a\n2) |"],
      ["9. a|", "9. a\n10. |"],
      ["1. a|\n2. b\n3. c", "1. a\n2. |\n3. b\n4. c"],
      // Known limitation (README): ordered tasks continue without a box.
      ["1. [ ] a|", "1. [ ] a\n2. |"],
    ]);
  });

  it("starts an unchecked task after a task of any status", () => {
    cases(enter, [
      ["- [ ] a|", "- [ ] a\n- [ ] |"],
      ["- [x] a|", "- [x] a\n- [ ] |"],
      ["- [X] a|", "- [X] a\n- [ ] |"],
      ["- [/] a|", "- [/] a\n- [ ] |"],
      ["- [-] a|", "- [-] a\n- [ ] |"],
      ["- [>] a|", "- [>] a\n- [ ] |"],
      ["- [?] a|", "- [?] a\n- [ ] |"],
      ["* [!] a|", "* [!] a\n* [ ] |"],
      ["\t- [/] nested|", "\t- [/] nested\n\t- [ ] |"],
      ["- a\n\t- [>] later|", "- a\n\t- [>] later\n\t- [ ] |"],
      ["* [ ] a|", "* [ ] a\n* [ ] |"],
      ["+ a|", "+ a\n+ |"],
    ]);
  });

  it("ends the list on an empty item, and outdents an empty nested item", () => {
    cases(enter, [
      ["- a\n- |", "- a\n|"],
      ["1. a\n2. |", "1. a\n|"],
      ["- [ ] a\n- [ ] |", "- [ ] a\n|"],
      ["- [/] |", "|"],
      ["\t- |", "|"],
      ["- |", "|"],
      ["- a\n\t- |", "- a\n- |"],
      ["- a\n\t- [ ] |", "- a\n- |"],
    ]);
  });

  it("continues lists inside blockquotes", () => {
    cases(enter, [
      ["> - a|", "> - a\n> - |"],
      ["> - [ ] a|", "> - [ ] a\n> - [ ] |"],
      ["> - |", "> |"],
      ["> a|", "> a\n> |"],
      ["> |", ">\n> |"],
      // Limitation: other statuses inside a quote continue with a plain bullet.
      ["> - [/] a|", "> - [/] a\n> - |"],
    ]);
  });

  it("splits items without losing text, wherever the caret is", () => {
    cases(enter, [
      ["- [ ] a|b", "- [ ] a\n- [ ] |b"],
      ["- [ ] |a", "- [ ]\n- [ ] |a"],
      ["- [|] a", "- [\n- |] a"],
      ["- a\n  continued|", "- a\n  continued\n  |"],
      ["- a\n\n- b|", "- a\n\n- b\n\n- |"],
    ]);
  });

  it("leaves code blocks, plain text and positions before the marker to the default Enter", () => {
    cases(enter, [
      ["```\n- a|\n```", null],
      ["text|", null],
      ["|- [ ] a", null],
      ["- «a»", null],
    ]);
  });

  const listLine = fc
    .tuple(
      fc.constantFrom("", "\t", "  ", "    ", "> ", "> > ", "\t\t"),
      fc.constantFrom("- ", "* ", "+ ", "1. ", "2) ", "- [ ] ", "- [x] ", "- [/] ", "1. [-] ", ""),
      fc.constantFrom("", "a", "task text", "[[Link]] and **bold**", "  "),
    )
    .map(([indent, marker, text]) => indent + marker + text);

  test.prop([
    fc
      .array(listLine, { minLength: 1, maxLength: 5 })
      .map((lines) => lines.join("\n"))
      .chain((doc) => fc.tuple(fc.constant(doc), fc.nat({ max: doc.length }))),
  ])(
    "never deletes non-whitespace text except the markup of an empty item, and undoes",
    ([doc, caret]) => {
      const state = markedState(`${doc.slice(0, caret)}|${doc.slice(caret)}`);
      const next = run(state, enter);
      if (!next) return;
      const line = state.doc.lineAt(caret).text;
      const emptyItem = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])?[ \t]*(?:\[.\])?[ \t]*$/.test(line);
      const before = doc.replace(/\s/g, "");
      const after = next.doc.toString().replace(/\s/g, "");
      if (!emptyItem) {
        let i = 0;
        for (const ch of after) if (ch === before[i]) i++;
        expect(i, `${JSON.stringify(doc)} → ${JSON.stringify(showSelection(next))}`).toBe(
          before.length,
        );
      }
      expect(run(next, undo)?.doc.toString()).toBe(doc);
    },
  );
});

describe("Backspace at the start of item text", () => {
  it("removes list markup (the whole task prefix at once)", () => {
    cases(deleteMarkupBackward, [
      ["- |a", "|a"],
      ["- [ ] |a", "|a"],
      ["> |a", "|a"],
      ["1. |a", "|a"],
      ["- a\n\t- |", "- a\n\t|"],
    ]);
  });

  it("leaves top-level items indented with a tab to the default Backspace", () => {
    // lang-markdown doesn't treat these as list context (see continueListItem for Enter).
    expect(runMarked("\t- |a", deleteMarkupBackward)).toBeNull();
  });
});

describe("Tab / Shift-Tab", () => {
  it("indents list items (any selected list line indents the whole selection)", () => {
    cases(indentListItemOrInsertTab, [
      ["- a\n- b|", "- a\n\t- b|"],
      ["- a|", "\t- a|"],
      ["1. a\n2. b|", "1. a\n\t2. b|"],
      ["«- a\nb»", "\t«- a\n\tb»"],
      ["a|b", "a\t|b"],
    ]);
  });

  it("outdents by one level, tabs or spaces, and is a no-op at the top level", () => {
    cases(indentLess, [
      ["\t- a|", "- a|"],
      ["  - a|", "- a|"],
      ["- a|", "- a|"],
      ["\t\t- [ ] a|", "\t- [ ] a|"],
    ]);
  });

  it("does nothing in a read-only editor", () => {
    expect(
      run(markedState("- a|", { config: { readOnly: true } }), indentListItemOrInsertTab),
    ).toBeNull();
  });
});
