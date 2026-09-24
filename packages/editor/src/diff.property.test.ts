import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { minimalChange, normalizeLineEndings, type TextChange } from "./diff";
import { codePointBoundaries } from "./test-arbitraries";

function applyChange(text: string, change: TextChange | null): string {
  return change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : text;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** True when `pos` falls between the two halves of a surrogate pair. */
function splitsPair(text: string, pos: number): boolean {
  return (
    pos > 0 && pos < text.length && isHigh(text.charCodeAt(pos - 1)) && isLow(text.charCodeAt(pos))
  );
}

/** Well-formed text heavy in line breaks, repeats and astral characters (so edits are ambiguous). */
const unit = fc.constantFrom(
  "a",
  "b",
  "\n",
  "\n",
  " ",
  "😀",
  "😁",
  "👩‍💻",
  "é",
  "e\u0301",
  "- [ ] ",
);
const text = fc.array(unit, { maxLength: 30 }).map((parts) => parts.join(""));
/** Arbitrary UTF-16, including lone surrogates. */
const anyText = fc.string({ unit: "binary", maxLength: 30 });

/** `next` derived from `current` by one splice at code point boundaries (an external edit). */
const edited = text.chain((current) => {
  const at = fc.constantFrom(...codePointBoundaries(current));
  return fc.tuple(at, at, text).map(([a, b, insert]): [string, string] => {
    const [from, to] = a <= b ? [a, b] : [b, a];
    return [current, current.slice(0, from) + insert + current.slice(to)];
  });
});

describe("minimalChange (properties)", () => {
  test.prop([fc.oneof(edited, fc.tuple(text, text), fc.tuple(anyText, anyText))])(
    "applied to the current text always yields the next text",
    ([current, next]) => {
      const change = minimalChange(current, next);
      expect(applyChange(current, change)).toBe(next);
      if (current === next) {
        expect(change).toBeNull();
        return;
      }
      expect(change).not.toBeNull();
      expect(change!.from).toBeGreaterThanOrEqual(0);
      expect(change!.from).toBeLessThanOrEqual(change!.to);
      expect(change!.to).toBeLessThanOrEqual(current.length);
    },
  );

  test.prop([fc.oneof(edited, fc.tuple(text, text))])(
    "never splits a surrogate pair",
    ([current, next]) => {
      const change = minimalChange(current, next);
      if (!change) return;
      expect(splitsPair(current, change.from), "from").toBe(false);
      expect(splitsPair(current, change.to), "to").toBe(false);
      expect(splitsPair(next, change.from + change.insert.length), "end of insert").toBe(false);
    },
  );

  test.prop([edited])("is minimal up to surrogate pairs and line alignment", ([current, next]) => {
    const change = minimalChange(current, next);
    if (!change) return;
    const replaced = change.to - change.from;
    // Pure insertions and deletions stay pure; otherwise at most one extra code unit per side.
    let prefix = 0;
    while (prefix < Math.min(current.length, next.length) && current[prefix] === next[prefix]) {
      prefix++;
    }
    let suffix = 0;
    while (
      suffix < Math.min(current.length, next.length) - prefix &&
      current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
    ) {
      suffix++;
    }
    expect(replaced).toBeLessThanOrEqual(current.length - prefix - suffix + 2);
    // When the naive boundaries fall inside a surrogate pair the change widens to whole pairs.
    if (splitsPair(current, prefix) || splitsPair(current, current.length - suffix)) return;
    if (current.length - prefix - suffix === 0) expect(replaced).toBe(0);
    if (next.length - prefix - suffix === 0) expect(change.insert).toBe("");
  });

  const lines = fc.array(fc.constantFrom("- [ ] a", "- [ ] b", "b", "", "- [x] a"), {
    minLength: 1,
    maxLength: 8,
  });

  test.prop([
    lines.chain((ls) =>
      fc.tuple(
        fc.constant(ls),
        fc.nat({ max: ls.length }),
        fc.array(fc.constantFrom("- [ ] a", "- [ ] new", "b", ""), { minLength: 1, maxLength: 3 }),
      ),
    ),
  ])("aligns whole-line insertions to a line start", ([ls, at, inserted]) => {
    const current = ls.join("\n");
    const next = [...ls.slice(0, at), ...inserted, ...ls.slice(at)].join("\n");
    const change = minimalChange(current, next);
    if (!change) return;
    expect(applyChange(current, change)).toBe(next);
    expect(change.from).toBe(change.to);
    const insertedLines = inserted.join("\n");
    if (at < ls.length) {
      // Inserted before an existing line: a run of whole lines that starts at a line start.
      expect(change.from === 0 || current[change.from - 1] === "\n").toBe(true);
      expect(change.insert.length).toBe(insertedLines.length + 1);
    }
  });

  test.prop([
    lines.chain((ls) =>
      fc.tuple(fc.constant(ls), fc.nat({ max: ls.length - 1 }), fc.nat({ max: ls.length })),
    ),
  ])("aligns whole-line deletions to a line start", ([ls, a, b]) => {
    const [from, to] = a <= b ? [a, b] : [b, a];
    if (to === from || to === ls.length) return;
    const current = ls.join("\n");
    const next = [...ls.slice(0, from), ...ls.slice(to)].join("\n");
    const change = minimalChange(current, next);
    if (!change) return;
    expect(applyChange(current, change)).toBe(next);
    expect(change.insert).toBe("");
    expect(change.from === 0 || current[change.from - 1] === "\n").toBe(true);
  });
});

describe("normalizeLineEndings (properties)", () => {
  test.prop([fc.array(fc.constantFrom("a", "\r\n", "\r", "\n", "😀"), { maxLength: 20 })])(
    "only ever produces LF and is idempotent",
    (parts) => {
      const input = parts.join("");
      const normalized = normalizeLineEndings(input);
      expect(normalized).not.toContain("\r");
      expect(normalizeLineEndings(normalized)).toBe(normalized);
      expect(normalized.split("\n").length).toBe(input.split(/\r\n|\r|\n/).length);
    },
  );
});
