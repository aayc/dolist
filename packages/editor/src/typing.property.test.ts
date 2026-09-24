// @vitest-environment happy-dom
import { redo, undo } from "@codemirror/commands";
import { fc, test } from "@fast-check/vitest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMarkdownEditor } from "./editor";
import { typeText } from "./test-helpers";
import type { MarkdownEditor } from "./types";

let editor: MarkdownEditor;

beforeAll(() => {
  const parent = document.createElement("div");
  document.body.append(parent);
  editor = createMarkdownEditor(parent, { doc: "" });
});

afterAll(() => editor.destroy());

/** A fresh document with the caret at its end (and no undo history). */
function reset(doc: string): void {
  editor.setDocument(doc, { resetHistory: true });
  editor.view.dispatch({ selection: { anchor: doc.length } });
}

const CLOSING: Record<string, string> = { "(": ")", "[": "]", "{": "}" };

/**
 * What typing `text` at the end of `doc` yields. Documented auto-pairing: `(`, `[` and `{` insert
 * their closing bracket after the caret; typing that closing bracket steps over it. Quotes are
 * never paired.
 */
function expectedTyping(doc: string, text: string): string {
  let before = doc;
  const pending: string[] = [];
  for (const ch of text) {
    const closing = CLOSING[ch];
    if (closing) pending.unshift(closing);
    else if (pending[0] === ch) pending.shift();
    before += ch;
  }
  return before + pending.join("");
}

function undoAll(): void {
  for (let i = 0; i < 1000 && undo(editor.view); i++);
}

function redoAll(): void {
  for (let i = 0; i < 1000 && redo(editor.view); i++);
}

const printable = fc.constantFrom(
  ..."abcXYZ019 \t.,;:!?'\"`~*_=#<>-+|/\\@$%^&()[]{}".split(""),
  "é",
  "ß",
  "日",
  "😀",
  "👩‍💻",
  "\u00a0",
  "<b>",
  "</b>",
  "<span title=",
);
/** Markdown syntax typed at the start of a line; no backticks or tildes, so no fences. */
const syntax = fc.constantFrom(
  ..."- [ ] x/>#*_=|()1.".split(""),
  " ",
  " ",
  "- [ ] ",
  "[[",
  "]]",
  "**",
  "==",
  "task",
);

const typed = (alphabet: fc.Arbitrary<string>, max: number) =>
  fc.array(alphabet, { minLength: 1, maxLength: max }).map((chars) => chars.join(""));

const existingDoc = fc.constantFrom("", "# Today\n- [ ] one\n", "plain\n\n", "> quote\n");

describe("typing through the input handlers (properties)", () => {
  test.prop([existingDoc, typed(printable, 40)])(
    "produces the typed text, modulo bracket auto-pairing",
    (doc, text) => {
      const start = `${doc}x `;
      reset(start);
      typeText(editor.view, text);
      expect(editor.getDocument()).toBe(expectedTyping(start, text));
    },
  );

  test.prop([existingDoc, typed(syntax, 25)])(
    "types markdown syntax from the start of a line",
    (doc, text) => {
      reset(doc);
      typeText(editor.view, text);
      expect(editor.getDocument()).toBe(expectedTyping(doc, text));
    },
  );

  test.prop([existingDoc, typed(printable, 30)])(
    "undoing everything restores the original document, redoing restores the typed one",
    (doc, text) => {
      const start = `${doc}x `;
      reset(start);
      typeText(editor.view, text);
      const result = editor.getDocument();
      undoAll();
      expect(editor.getDocument()).toBe(start);
      redoAll();
      expect(editor.getDocument()).toBe(result);
    },
  );
});

describe("typing: auto-pairing edge cases", () => {
  it("never pairs quotes (apostrophes are prose)", () => {
    reset("");
    typeText(editor.view, `It's "quoted" and 'single'`);
    expect(editor.getDocument()).toBe(`It's "quoted" and 'single'`);
  });

  it("steps over only the bracket it auto-inserted", () => {
    reset("");
    typeText(editor.view, "([x)");
    expect(editor.getDocument()).toBe("([x)])");
  });

  it("wraps a selection instead of replacing it", () => {
    reset("pick this");
    editor.view.dispatch({ selection: { anchor: 5, head: 9 } });
    typeText(editor.view, "[");
    expect(editor.getDocument()).toBe("pick [this]");
  });

  it("does not pair before a word character", () => {
    reset("word");
    editor.view.dispatch({ selection: { anchor: 0 } });
    typeText(editor.view, "(");
    expect(editor.getDocument()).toBe("(word");
  });

  it("types HTML literally: no auto-closed tags, no paired quotes", () => {
    for (const text of [
      "<div>x</div>",
      "<details>\n<summary>More</summary>\n</details>",
      'a <u>"quoted"</u> b',
      "<p class='note'>hi</p>",
      "Press <kbd>Ctrl</kbd>+<kbd>S</kbd>",
      '<script>let s = "x";</script>',
    ]) {
      reset("");
      typeText(editor.view, text);
      expect(editor.getDocument(), text).toBe(text);
    }
  });
});
