import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

const char = fc.constantFrom(
  ..."abcdefgxyzABCDEFG0129 -_/.:#()".split(""),
  "é",
  "É",
  "İ",
  "ß",
  "Σ",
  "日",
  "本",
  "😀",
  "K",
);
const text = fc.array(char, { maxLength: 24 }).map((cs) => cs.join(""));
/** Query letters never overlap the padding (n–w) or the x/y/z fillers used to scatter them. */
const word = fc.stringMatching(/^[a-m]{2,6}$/);
const pad = fc.stringMatching(/^[n-w]{0,8}$/);

/** Case-insensitive subsequence test, character by character (the matcher's contract). */
function isSubsequence(query: string, target: string): boolean {
  const q = [...query.replace(/\s+/g, "")].map((c) => c.toLowerCase()[0]!);
  let k = 0;
  for (const ch of target) {
    if (k < q.length && ch.toLowerCase()[0] === q[k]) k++;
  }
  return k === q.length;
}

describe("fuzzyMatch (properties)", () => {
  test.prop([text, text])("matches exactly the case-insensitive subsequences", (query, target) => {
    expect(fuzzyMatch(query, target) !== null).toBe(isSubsequence(query, target));
  });

  test.prop([
    text
      .filter((target) => target.length > 0)
      .chain((target) =>
        fc.tuple(
          fc.constant(target),
          fc.subarray([...Array(target.length).keys()], { minLength: 1 }),
        ),
      ),
  ])("highlights characters of the target that spell the query", ([target, picked]) => {
    const query = picked.map((i) => target[i]).join("");
    const match = fuzzyMatch(query, target);
    if (query.trim() === "" || /[\uD800-\uDFFF]/.test(query)) return;
    expect(match).not.toBeNull();
    const q = query.replace(/\s+/g, "");
    expect(match!.indices).toHaveLength(q.length);
    let previous = -1;
    match!.indices.forEach((i, k) => {
      expect(i).toBeGreaterThan(previous);
      expect(i).toBeLessThan(target.length);
      expect(target[i]!.toLowerCase()[0], `index ${i} of ${JSON.stringify(target)}`).toBe(
        q[k]!.toLowerCase()[0],
      );
      previous = i;
    });
  });

  test.prop([text])("an empty or blank query matches everything with score 0", (target) => {
    expect(fuzzyMatch("", target)).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch(" \t ", target)).toEqual({ score: 0, indices: [] });
  });

  test.prop([word, fc.stringMatching(/^[a-z ]{0,12}$/), fc.stringMatching(/^[xyz]{1,3}$/)])(
    "a prefix match outranks the same letters scattered through a target",
    (query, tail, filler) => {
      const prefix = `${query}${tail}`;
      const scattered = `${filler}${[...query].join(filler)}`;
      const prefixScore = fuzzyMatch(query, prefix)!.score;
      const scatteredScore = fuzzyMatch(query, scattered)!.score;
      expect(prefixScore).toBeGreaterThan(scatteredScore);
    },
  );

  test.prop([word, pad, fc.stringMatching(/^[xyz]{1,2}$/)])(
    "a contiguous match outranks a scattered one in a target of the same length",
    (query, before, filler) => {
      const contiguous = `${before}${query}${filler.repeat(query.length - 1)}`;
      const scattered = `${before}${[...query].join(filler)}`;
      expect(contiguous.length).toBe(scattered.length);
      expect(fuzzyMatch(query, contiguous)!.score).toBeGreaterThan(
        fuzzyMatch(query, scattered)!.score,
      );
    },
  );

  test.prop([fc.array(text, { maxLength: 30 }), text, fc.integer({ min: 0, max: 10 })])(
    "fuzzyFilter keeps only matches, sorted by score, within the limit",
    (items, query, limit) => {
      const results = fuzzyFilter(query, items, (s) => s, limit);
      expect(results.length).toBeLessThanOrEqual(limit);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
      }
      for (const r of results) expect(items).toContain(r.item);
      const matching = items.filter((s) => fuzzyMatch(query, s) !== null).length;
      expect(results.length).toBe(Math.min(limit, matching));
    },
  );
});

describe("fuzzyMatch: word starts", () => {
  it("highlights a word-start character over an earlier interior one", () => {
    expect(fuzzyMatch("gr", "Garden Redesign")?.indices).toEqual([0, 7]);
  });

  it("scores a word prefix above letters scattered over word starts", () => {
    const wordPrefix = fuzzyMatch("tod", "Open today's daily note")!;
    const scattered = fuzzyMatch("tod", "Toggle Light/Dark Theme")!;
    expect(wordPrefix.score).toBeGreaterThan(scattered.score);
  });
});

describe("fuzzyMatch: unicode", () => {
  it("aligns highlights when lowercasing changes the length (Turkish İ)", () => {
    const match = fuzzyMatch("ist", "İstanbul notes");
    expect(match?.indices).toEqual([0, 1, 2]);
    expect(fuzzyMatch("İst", "İstanbul")?.indices).toEqual([0, 1, 2]);
    expect(fuzzyMatch("bul", "İstanbul")?.indices).toEqual([5, 6, 7]);
  });

  it("folds case without context (Greek final sigma)", () => {
    expect(fuzzyMatch("Σ", "ΟΔΟΣ")?.indices).toEqual([3]);
    expect(fuzzyMatch("οδοσ", "Οδός")).toBeNull(); // ό is a different letter (accent)
    expect(fuzzyMatch("ΟΔΟΣ", "οδοσ plan")?.indices).toEqual([0, 1, 2, 3]);
  });

  it("is case-insensitive but diacritic-sensitive (no accent folding)", () => {
    expect(fuzzyMatch("CAFÉ", "café")).not.toBeNull();
    expect(fuzzyMatch("cafe", "Café")).toBeNull();
    expect(fuzzyMatch("日本", "今日は日本")?.indices).toEqual([3, 4]);
    expect(fuzzyMatch("😀", "a😀b")?.indices).toEqual([1, 2]);
  });
});
