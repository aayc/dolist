import { undo } from "@codemirror/commands";
import { EditorSelection, type EditorState, type StateCommand } from "@codemirror/state";
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { codePointBoundaries, markdownDoc, selectionIn, toSelection } from "../test-arbitraries";
import { parsedState, run } from "../test-helpers";
import {
  insertLink,
  toggleBold,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleStrikethrough,
} from "./formatting";

const STYLES: Array<[name: string, command: StateCommand, marker: string]> = [
  ["bold", toggleBold, "*"],
  ["italic", toggleItalic, "*"],
  ["strikethrough", toggleStrikethrough, "~"],
  ["highlight", toggleHighlight, "="],
  ["inline code", toggleInlineCode, "`"],
];
const style = fc.constantFrom(...STYLES);

/** Text without any formatting marker characters, including line breaks and surrogate pairs. */
const safeChar = fc.constantFrom(
  ..."abc XYZ019.,;:!?()[]#-_|/\n".split(""),
  "é",
  "日本",
  "😀",
  "👩‍💻",
);
const safeDoc = fc.array(safeChar, { minLength: 1, maxLength: 30 }).map((cs) => cs.join(""));

const boundaryRange = (text: string) => {
  const at = fc.constantFrom(...codePointBoundaries(text));
  return fc.tuple(at, at);
};

function withSelection(doc: string, anchor: number, head: number): EditorState {
  return parsedState(doc, { selection: EditorSelection.single(anchor, head) });
}

function strip(text: string, marker: string): string {
  return text.split(marker).join("");
}

describe("inline formatting commands (properties)", () => {
  test.prop([style, safeDoc.chain((doc) => fc.tuple(fc.constant(doc), boundaryRange(doc)))])(
    "toggling twice restores the document and the selection",
    ([, command], [doc, [anchor, head]]) => {
      const start = withSelection(doc, anchor, head);
      const once = run(start, command);
      expect(once).not.toBeNull();
      const twice = run(once!, command);
      expect(twice?.doc.toString()).toBe(doc);
      expect(twice?.selection.main.anchor).toBe(anchor);
      expect(twice?.selection.main.head).toBe(head);
    },
  );

  test.prop([
    style,
    fc
      .array(
        safeDoc.map((line) => line.replace(/\n/g, " ")),
        { minLength: 2, maxLength: 5 },
      )
      .chain((lines) =>
        fc.tuple(
          fc.constant(lines),
          fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat()), { minLength: 2, maxLength: 5 }),
        ),
      ),
  ])(
    "toggling twice with one range per line restores the document",
    ([, command], [lines, picks]) => {
      const doc = lines.join("\n");
      const state0 = parsedState(doc);
      const used = new Set<number>();
      const ranges = [];
      for (const [lineIndex, a, b] of picks) {
        const n = (lineIndex % lines.length) + 1;
        if (used.has(n)) continue;
        used.add(n);
        const line = state0.doc.line(n);
        const offsets = codePointBoundaries(line.text);
        const anchor = line.from + offsets[a % offsets.length]!;
        const head = line.from + offsets[b % offsets.length]!;
        ranges.push(EditorSelection.range(anchor, head));
      }
      const start = parsedState(doc, { selection: EditorSelection.create(ranges) });
      const twice = run(run(start, command)!, command);
      expect(twice?.doc.toString()).toBe(doc);
    },
  );

  test.prop([
    style,
    markdownDoc(12).chain((doc) => fc.tuple(fc.constant(doc), selectionIn(doc.length))),
  ])(
    "only ever add or remove marker characters, and undo restores the document",
    ([, command, marker], [doc, selection]) => {
      const start = parsedState(doc, { selection: toSelection(selection) });
      const next = run(start, command);
      expect(next).not.toBeNull();
      expect(strip(next!.doc.toString(), marker)).toBe(strip(doc, marker));
      expect(run(next!, undo)?.doc.toString()).toBe(doc);
    },
  );

  test.prop([style, fc.constantFrom("«x»", "a |b", "«a\nb»")])(
    "do nothing in a read-only editor",
    ([, command], marked) => {
      const doc = marked.replace(/[|«»]/g, "");
      const state = parsedState(doc, { config: { readOnly: true } });
      expect(run(state, command)).toBeNull();
    },
  );
});

describe("insertLink (properties)", () => {
  test.prop([safeDoc.chain((doc) => fc.tuple(fc.constant(doc), boundaryRange(doc)))])(
    "wraps the selected text and puts the caret in the destination",
    ([doc, [anchor, head]]) => {
      const from = Math.min(anchor, head);
      const to = Math.max(anchor, head);
      const next = run(withSelection(doc, anchor, head), insertLink)!;
      const text = doc.slice(from, to);
      const expected = `${doc.slice(0, from)}[${text}]()${doc.slice(to)}`;
      expect(next.doc.toString()).toBe(expected);
      expect(next.selection.main.head).toBe(from === to ? from + 1 : from + text.length + 3);
    },
  );

  test.prop([
    fc.constantFrom("https://example.com/a?b=1", "www.example.com", "mailto:a@example.com"),
    fc.constantFrom("", " ", "  ", "\n", " \n"),
    fc.constantFrom("", " ", "\t", "\n"),
  ])(
    "turns a selected URL into the destination, keeping surrounding whitespace",
    (url, lead, trail) => {
      const doc = `before${lead}${url}${trail}after`;
      const from = "before".length;
      const next = run(
        withSelection(doc, from, from + lead.length + url.length + trail.length),
        insertLink,
      )!;
      expect(next.doc.toString()).toBe(`before${lead}[](${url})${trail}after`);
      expect(next.selection.main.head).toBe(from + lead.length + 1);
    },
  );
});
