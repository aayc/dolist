import { describe, expect, it } from "vitest";
import { type DiffHunk, diff3Regions, diffLines, mergeLines, mergeText } from "./diff3";

// Stretched on slow CI runners (TEST_TIME_SCALE, see scripts/vitest/setup-fast-check.ts).
const TIME_SCALE = Number(process.env.TEST_TIME_SCALE) || 1;

/** Deterministic PRNG (mulberry32) so randomized tests are reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rebuilds `newer` from `older` + hunks, checking that everything outside the hunks matches. */
function applyHunks(older: string[], newer: string[], hunks: DiffHunk[]): string[] {
  const out: string[] = [];
  let i = 0;
  let j = 0;
  for (const h of hunks) {
    while (i < h.oldStart) {
      expect(older[i]).toBe(newer[j]);
      out.push(older[i]!);
      i++;
      j++;
    }
    expect(j).toBe(h.newStart);
    out.push(...newer.slice(h.newStart, h.newStart + h.newLength));
    i += h.oldLength;
    j += h.newLength;
  }
  out.push(...older.slice(i));
  return out;
}

/** Random edits (replace / insert / delete) with globally unique new lines. */
function mutate(lines: string[], random: () => number, tag: string, edits: number): string[] {
  const out = [...lines];
  for (let n = 0; n < edits; n++) {
    const at = Math.floor(random() * (out.length + 1));
    const op = random();
    if (op < 0.4 && at < out.length) out[at] = `${tag}-replaced-${n}`;
    else if (op < 0.7 || at >= out.length) out.splice(at, 0, `${tag}-inserted-${n}`);
    else out.splice(at, 1);
  }
  return out;
}

const lines = (text: string) => text.split("\n");

describe("diffLines", () => {
  it("returns no hunks for identical input", () => {
    expect(diffLines(["a", "b"], ["a", "b"])).toEqual([]);
    expect(diffLines([], [])).toEqual([]);
  });

  it("describes insertions, deletions and replacements", () => {
    expect(diffLines(["a", "c"], ["a", "b", "c"])).toEqual([
      { oldStart: 1, oldLength: 0, newStart: 1, newLength: 1 },
    ]);
    expect(diffLines(["a", "b", "c"], ["a", "c"])).toEqual([
      { oldStart: 1, oldLength: 1, newStart: 1, newLength: 0 },
    ]);
    expect(diffLines(["a", "b", "c", "d", "e"], ["a", "X", "c", "d", "Y"])).toEqual([
      { oldStart: 1, oldLength: 1, newStart: 1, newLength: 1 },
      { oldStart: 4, oldLength: 1, newStart: 4, newLength: 1 },
    ]);
    expect(diffLines([], ["a"])).toEqual([
      { oldStart: 0, oldLength: 0, newStart: 0, newLength: 1 },
    ]);
  });

  it("finds a minimal diff that reconstructs the new text (randomized)", () => {
    const random = rng(42);
    for (let round = 0; round < 200; round++) {
      const alphabet = ["a", "b", "c", "d", ""];
      const pick = () => alphabet[Math.floor(random() * alphabet.length)]!;
      const older = Array.from({ length: Math.floor(random() * 30) }, pick);
      const newer = Array.from({ length: Math.floor(random() * 30) }, pick);
      const hunks = diffLines(older, newer);
      expect(applyHunks(older, newer, hunks)).toEqual(newer);
    }
  });

  it("falls back to one hunk beyond the edit-distance budget", () => {
    const older = ["same", "a1", "a2", "a3", "same-end"];
    const newer = ["same", "b1", "b2", "b3", "same-end"];
    expect(diffLines(older, newer, { maxEditDistance: 2 })).toEqual([
      { oldStart: 1, oldLength: 3, newStart: 1, newLength: 3 },
    ]);
  });
});

describe("diff3Regions", () => {
  it("separates stable and conflicting regions", () => {
    expect(diff3Regions(["a", "b", "c"], ["a", "B", "c"], ["a", "b2", "c"])).toEqual([
      { stable: true, lines: ["a"] },
      { stable: false, ours: ["B"], base: ["b"], theirs: ["b2"] },
      { stable: true, lines: ["c"] },
    ]);
  });
});

describe("mergeText", () => {
  const base = "# Today\n- [ ] one\n- [ ] two\n- [ ] three\n- [ ] four\n";

  it("takes the only side that changed", () => {
    const changed = base.replace("one", "ONE");
    expect(mergeText(base, changed, base)).toEqual({ clean: true, text: changed });
    expect(mergeText(base, base, changed)).toEqual({ clean: true, text: changed });
    expect(mergeText(base, changed, changed)).toEqual({ clean: true, text: changed });
  });

  it("merges edits to different parts of the note", () => {
    const ours = base.replace("- [ ] one", "- [x] one");
    const theirs = base.replace("- [ ] four", "- [ ] four (moved to Friday)");
    expect(mergeText(base, ours, theirs)).toEqual({
      clean: true,
      text: "# Today\n- [x] one\n- [ ] two\n- [ ] three\n- [ ] four (moved to Friday)\n",
    });
  });

  it("merges edits to adjacent lines", () => {
    const ours = base.replace("- [ ] two", "- [x] two");
    const theirs = base.replace("- [ ] three", "- [x] three");
    expect(mergeText(base, ours, theirs)).toEqual({
      clean: true,
      text: "# Today\n- [ ] one\n- [x] two\n- [x] three\n- [ ] four\n",
    });
  });

  it("merges an insertion next to an edit", () => {
    const ours = base.replace("- [ ] two\n", "- [ ] two\n- [ ] new task\n");
    const theirs = base.replace("- [ ] three", "- [x] three");
    expect(mergeText(base, ours, theirs)).toEqual({
      clean: true,
      text: "# Today\n- [ ] one\n- [ ] two\n- [ ] new task\n- [x] three\n- [ ] four\n",
    });
  });

  it("reports conflicting edits to the same line with markers", () => {
    const ours = base.replace("two", "two (mine)");
    const theirs = base.replace("two", "two (theirs)");
    const result = mergeText(base, ours, theirs);
    expect(result.clean).toBe(false);
    expect(result).toMatchObject({ conflicts: 1 });
    expect(result.text).toBe(
      "# Today\n- [ ] one\n<<<<<<< ours\n- [ ] two (mine)\n||||||| base\n- [ ] two\n=======\n- [ ] two (theirs)\n>>>>>>> theirs\n- [ ] three\n- [ ] four\n",
    );
  });

  it("treats a delete racing an edit of the same line as a conflict", () => {
    const ours = base.replace("- [ ] two\n", "");
    const theirs = base.replace("two", "two!");
    expect(mergeText(base, ours, theirs).clean).toBe(false);
  });

  it("handles insertions at the same spot: identical, union or conflict", () => {
    const ours = `${base}- [ ] buy milk\n`;
    const theirs = `${base}- [ ] call the plumber\n`;
    expect(mergeText(base, ours, ours)).toEqual({ clean: true, text: ours });
    expect(mergeText(base, ours, theirs).clean).toBe(false);
    expect(mergeText(base, ours, theirs, { unionInsertions: true })).toEqual({
      clean: true,
      text: `${base}- [ ] buy milk\n- [ ] call the plumber\n`,
    });
  });

  it("never unions over a replaced base line", () => {
    expect(mergeText("x", "a", "b", { unionInsertions: true }).clean).toBe(false);
  });

  it("preserves CRLF line endings and trailing newlines", () => {
    const crlfBase = "a\r\nb\r\nc\r\n";
    const result = mergeText(crlfBase, "A\r\nb\r\nc\r\n", "a\r\nb\r\nC\r\n");
    expect(result).toEqual({ clean: true, text: "A\r\nb\r\nC\r\n" });
    expect(mergeText("a\nb", "a!\nb", "a\nb\n")).toEqual({ clean: true, text: "a!\nb\n" });
  });

  it("merges disjoint random edits exactly (randomized)", () => {
    const random = rng(7);
    for (let round = 0; round < 100; round++) {
      const head = Array.from({ length: 15 }, (_, i) => `head-${i}`);
      const middle = Array.from({ length: 5 }, (_, i) => `middle-${i}`);
      const tail = Array.from({ length: 15 }, (_, i) => `tail-${i}`);
      const oursHead = mutate(head, random, `o${round}`, 1 + Math.floor(random() * 4));
      const theirsTail = mutate(tail, random, `t${round}`, 1 + Math.floor(random() * 4));
      const result = mergeLines(
        [...head, ...middle, ...tail],
        [...oursHead, ...middle, ...tail],
        [...head, ...middle, ...theirsTail],
      );
      expect(result).toEqual({ clean: true, lines: [...oursHead, ...middle, ...theirsTail] });
    }
  });

  it("merges edits at both ends of a long note quickly", () => {
    const long = Array.from({ length: 5_000 }, (_, i) => `- [ ] task ${i}`);
    const ours = ["# edited title", ...long.slice(1)];
    const theirs = [...long.slice(0, -1), "- [x] last task done"];
    const started = performance.now();
    const result = mergeLines(long, ours, theirs);
    expect(performance.now() - started).toBeLessThan(1_000 * TIME_SCALE);
    expect(result).toEqual({
      clean: true,
      lines: ["# edited title", ...long.slice(1, -1), "- [x] last task done"],
    });
  });

  it("stays correct when the texts are completely different", () => {
    const older = lines(Array.from({ length: 3_000 }, (_, i) => `old ${i}`).join("\n"));
    const newer = lines(Array.from({ length: 3_000 }, (_, i) => `new ${i}`).join("\n"));
    const hunks = diffLines(older, newer);
    expect(applyHunks(older, newer, hunks)).toEqual(newer);
  });
});
