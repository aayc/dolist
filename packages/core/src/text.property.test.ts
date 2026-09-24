import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import {
  diceSimilarity,
  hashString,
  isPrefixExtension,
  normalizeText,
  splitLines,
  truncate,
} from "./text";

const textArb = fc.oneof(
  fc.string({ unit: "grapheme", maxLength: 40 }),
  fc.string({ unit: fc.constantFrom("a", "b", "A", " ", "\t", "é", "🎉"), maxLength: 12 }),
);

describe("normalizeText", () => {
  test.prop([textArb])("is idempotent, trimmed, lower-case and single-spaced", (text) => {
    const n = normalizeText(text);
    expect(normalizeText(n)).toBe(n);
    expect(n).toBe(n.trim());
    expect(n).toBe(n.toLowerCase());
    expect(n).not.toMatch(/\s{2}|[\t\n\r]/);
  });
});

describe("diceSimilarity", () => {
  test.prop([textArb, textArb])("is symmetric and within [0, 1]", (a, b) => {
    const s = diceSimilarity(a, b);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
    expect(diceSimilarity(b, a)).toBe(s);
  });

  test.prop([textArb, fc.constantFrom("", " ", "  ", "\t")])(
    "is 1 for texts equal up to surrounding whitespace and case",
    (text, padding) => {
      expect(diceSimilarity(text, text)).toBe(1);
      expect(diceSimilarity(text, `${padding}${text}${padding}`)).toBe(1);
      fc.pre(normalizeText(text.toUpperCase()) === normalizeText(text));
      expect(diceSimilarity(text, text.toUpperCase())).toBe(1);
    },
  );

  test.prop([fc.string({ maxLength: 1 }), fc.string({ minLength: 2, maxLength: 10 })])(
    "texts shorter than two characters only match themselves",
    (tiny, other) => {
      fc.pre(normalizeText(tiny) !== normalizeText(other));
      expect(diceSimilarity(tiny, other)).toBe(0);
    },
  );

  test.prop([
    fc.string({ unit: "grapheme-ascii", minLength: 3, maxLength: 30 }),
    fc.string({ minLength: 1, maxLength: 5 }),
  ])("appending to a text keeps it similar", (text, suffix) => {
    fc.pre(normalizeText(text).length >= 3);
    expect(diceSimilarity(text, text + suffix)).toBeGreaterThan(0);
  });
});

describe("isPrefixExtension", () => {
  test.prop([textArb, textArb, fc.integer({ min: 0, max: 5 })])(
    "matches its definition",
    (a, b, min) => {
      const x = normalizeText(a);
      const y = normalizeText(b);
      const expected = x.length >= min && y.length >= min && (x.startsWith(y) || y.startsWith(x));
      expect(isPrefixExtension(a, b, min)).toBe(expected);
      expect(isPrefixExtension(b, a, min)).toBe(expected);
    },
  );
});

describe("hashString", () => {
  test.prop([fc.string({ unit: "binary", maxLength: 100 }), fc.nat()])(
    "is deterministic 14-digit hex, and the seed matters",
    (text, seed) => {
      const h = hashString(text, seed);
      expect(h).toMatch(/^[0-9a-f]{14}$/);
      expect(hashString(text, seed)).toBe(h);
    },
  );

  it("has no collisions among 20k similar strings and differs for any one-character change", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(hashString(`- [ ] task ${i}`));
    expect(seen.size).toBe(20_000);
    expect(hashString("a")).not.toBe(hashString("b"));
    expect(hashString("")).not.toBe(hashString("", 1));
    expect(hashString("\uD800")).not.toBe(hashString("\uFFFD"));
  });

  test.prop([fc.string({ minLength: 1, maxLength: 60 }), fc.nat(), fc.nat({ max: 0xffff })])(
    "changing one code unit changes the hash",
    (text, at, code) => {
      const i = at % text.length;
      fc.pre(text.charCodeAt(i) !== code);
      const changed = text.slice(0, i) + String.fromCharCode(code) + text.slice(i + 1);
      expect(hashString(changed)).not.toBe(hashString(text));
    },
  );
});

describe("truncate", () => {
  test.prop([fc.string({ unit: "binary", maxLength: 80 }), fc.integer({ min: -2, max: 90 })])(
    "never exceeds the budget, keeps a prefix and never splits a surrogate pair",
    (text, max) => {
      const out = truncate(text, max);
      if (text.length <= max) {
        expect(out).toBe(text);
        return;
      }
      expect(out.length).toBeLessThanOrEqual(Math.max(0, max));
      if (max < 1) {
        expect(out).toBe("");
        return;
      }
      expect(out.endsWith("…")).toBe(true);
      const kept = out.slice(0, -1);
      expect(text.startsWith(kept)).toBe(true);
      expect(kept).toBe(kept.trimEnd());
      const last = kept.charCodeAt(kept.length - 1);
      const next = text.charCodeAt(kept.length);
      const splitPair = last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
      expect(splitPair).toBe(false);
    },
  );

  it.each([
    ["short", 10, "short"],
    ["exactly ten", 11, "exactly ten"],
    ["a sentence that goes on", 10, "a sentenc…"],
    ["trailing space here", 10, "trailing…"],
    ["😀😀😀", 4, "😀…"],
    ["😀😀😀", 2, "…"],
    ["anything", 1, "…"],
    ["anything", 0, ""],
  ])("truncate(%j, %i) is %j", (text, max, expected) => {
    expect(truncate(text, max)).toBe(expected);
  });
});

describe("splitLines", () => {
  test.prop([
    fc.array(
      fc.string({ unit: "grapheme", maxLength: 10 }).map((s) => s.replace(/[\r\n]/g, "")),
      { minLength: 1, maxLength: 8 },
    ),
    fc.boolean(),
  ])("splits LF and CRLF text into the same lines", (lines, crlf) => {
    expect(splitLines(lines.join(crlf ? "\r\n" : "\n"))).toEqual(lines);
  });
});
