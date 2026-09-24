import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches subsequences case-insensitively and reports indices", () => {
    const match = fuzzyMatch("gdn", "Garden");
    expect(match).not.toBeNull();
    expect(match?.indices).toEqual([0, 3, 5]);
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyMatch("xyz", "Garden Redesign")).toBeNull();
    expect(fuzzyMatch("gardens", "Garden")).toBeNull();
  });

  it("treats an empty query as a match with score 0", () => {
    expect(fuzzyMatch("  ", "anything")).toEqual({ score: 0, indices: [] });
  });

  it("ignores whitespace in the query", () => {
    expect(fuzzyMatch("gar red", "Garden Redesign")).not.toBeNull();
  });

  it("prefers word-boundary characters over earlier interior ones", () => {
    const match = fuzzyMatch("gr", "Garden Redesign");
    expect(match?.indices).toEqual([0, 7]);
  });

  it("scores prefix and contiguous matches above scattered ones", () => {
    const prefix = fuzzyMatch("gro", "Grocery list")!;
    const scattered = fuzzyMatch("gro", "Garden Redesign Overview")!;
    expect(prefix.score).toBeGreaterThan(scattered.score);
  });
});

describe("fuzzyFilter", () => {
  const commands = [
    "Open today's daily note",
    "Open previous daily note",
    "Toggle agent panel",
    "Toggle light/dark theme",
    "Open settings",
  ];

  it("ranks the best match first and drops non-matches", () => {
    const results = fuzzyFilter("theme", commands, (c) => c);
    expect(results[0]?.item).toBe("Toggle light/dark theme");
    expect(results.every((r) => r.item !== "Open settings")).toBe(true);
  });

  it("prefers acronym-style boundary hits", () => {
    const results = fuzzyFilter("tap", commands, (c) => c);
    expect(results[0]?.item).toBe("Toggle agent panel");
  });

  it("respects the limit", () => {
    expect(fuzzyFilter("o", commands, (c) => c, 2)).toHaveLength(2);
  });
});
