import { diffLines } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { mergeLines, mergeText3 } from "./diff3";

/** Small alphabets make diffs ambiguous and matches plentiful: the interesting cases. */
const lineArb = fc.constantFrom("a", "b", "c", "- [ ] x", "- [x] x", "", "# h");
const linesArb = fc.array(lineArb, { maxLength: 14 });

type Edit = { at: number; kind: "insert" | "delete" | "replace" };
const editsArb = fc.array(
  fc.record({ at: fc.nat(), kind: fc.constantFrom<Edit["kind"]>("insert", "delete", "replace") }),
  { maxLength: 5 },
);

/** Applies edits whose new lines are unique to `tag`, so every added line is traceable. */
function edit(lines: readonly string[], edits: readonly Edit[], tag: string): string[] {
  const out = [...lines];
  edits.forEach((e, n) => {
    const at = e.at % (out.length + 1);
    if (e.kind === "insert" || at === out.length) out.splice(at, 0, `${tag}+${n}`);
    else if (e.kind === "delete") out.splice(at, 1);
    else out[at] = `${tag}~${n}`;
  });
  return out;
}

function addedLines(base: readonly string[], side: readonly string[]): string[] {
  return diffLines(base, side).flatMap((h) => h.lines);
}

describe("mergeLines", () => {
  test.prop([linesArb, editsArb])("takes the only side that changed", (base, edits) => {
    const changed = edit(base, edits, "o");
    expect(mergeLines(base, changed, base)).toEqual({ clean: true, lines: changed });
    expect(mergeLines(base, base, changed)).toEqual({ clean: true, lines: changed });
    expect(mergeLines(base, changed, changed)).toEqual({ clean: true, lines: changed });
  });

  test.prop([linesArb, editsArb, editsArb])(
    "conflicts the same whichever side is ours",
    (base, oursEdits, theirsEdits) => {
      const ours = edit(base, oursEdits, "o");
      const theirs = edit(base, theirsEdits, "t");
      const ab = mergeLines(base, ours, theirs);
      const ba = mergeLines(base, theirs, ours);
      expect(ab.clean ? 0 : ab.conflicts).toBe(ba.clean ? 0 : ba.conflicts);
    },
  );

  test.prop([
    fc.array(fc.string({ minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 10 }),
    fc.array(fc.string({ minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 10 }),
    editsArb,
    editsArb,
  ])(
    "merges edits separated by an untouched line cleanly and exactly",
    (head, tail, oursEdits, theirsEdits) => {
      const guard = "=== untouched guard ===";
      const base = [...head, guard, ...tail];
      const oursHead = edit(head, oursEdits, "o");
      const theirsTail = edit(tail, theirsEdits, "t");
      const result = mergeLines(
        base,
        [...oursHead, guard, ...tail],
        [...head, guard, ...theirsTail],
      );
      expect(result).toEqual({ clean: true, lines: [...oursHead, guard, ...theirsTail] });
    },
  );

  test.prop([linesArb, editsArb, editsArb])(
    "never loses a line either side added: it is merged or inside the conflict markers",
    (base, oursEdits, theirsEdits) => {
      const ours = edit(base, oursEdits, "o");
      const theirs = edit(base, theirsEdits, "t");
      const result = mergeLines(base, ours, theirs);
      for (const line of [...addedLines(base, ours), ...addedLines(base, theirs)]) {
        expect(result.lines).toContain(line);
      }
      if (!result.clean) {
        expect(result.lines.filter((l) => l === "<<<<<<< ours")).toHaveLength(result.conflicts);
      } else {
        expect(result.lines).not.toContain("<<<<<<< ours");
      }
    },
  );
});

describe("mergeText3", () => {
  const split = (text: string) => (text === "" ? [] : text.split("\n"));

  test.prop([linesArb, editsArb, editsArb, fc.constantFrom("\n", "\r\n"), fc.boolean()])(
    "is mergeLines over the texts' lines, and keeps their line endings",
    (base, oursEdits, theirsEdits, eol, trailing) => {
      const text = (lines: string[]) => lines.join(eol) + (trailing && lines.length > 0 ? eol : "");
      const [b, o, t] = [base, edit(base, oursEdits, "o"), edit(base, theirsEdits, "t")].map(
        text,
      ) as [string, string, string];
      const merged = mergeText3(b, o, t);
      if (b !== o && b !== t && o !== t) {
        const lines = mergeLines(split(b), split(o), split(t));
        expect(merged.clean).toBe(lines.clean);
        if (merged.clean)
          expect(merged.text.replace(/\r/g, "")).toBe(lines.lines.join("\n").replace(/\r/g, ""));
      }
      // Documents without any line break carry no line-ending style to keep.
      if (merged.clean && eol === "\r\n" && [b, o, t].some((x) => x.includes(eol))) {
        expect(merged.text.replace(/\r\n/g, "")).not.toContain("\n");
      }
    },
  );

  it("an emptied note merges like a deletion, and additions to an empty note union", () => {
    expect(mergeText3("a\na", "a\na\nnew", "")).toEqual({
      clean: true,
      text: "new",
    });
    expect(mergeText3("", "- [ ] mine", "- [ ] theirs")).toEqual({
      clean: true,
      text: "- [ ] mine\n- [ ] theirs",
    });
  });
});
