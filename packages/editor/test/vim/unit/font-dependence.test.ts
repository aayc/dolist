import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseVectors, type VectorCase } from "../format";
import { fontDependentCases, VECTORS_PATH } from "../scripts/vectors";

function vector(name: string, doc: string, keys: string[]): VectorCase {
  const expect = { doc, selection: [[0, 0]] as VectorCase["selection"], mode: "normal" as const };
  return { name, origin: "catalog", doc, selection: [[0, 0]], steps: [{ keys, expect }] };
}

describe("fontDependentCases", () => {
  it("flags pixel-measuring commands over text outside the oracle font", () => {
    const cases = [
      vector("gj over CJK", "日本語\nabc", ["g", "j"]),
      vector("page down over emoji", "👍\n".repeat(40), ["<C-d>"]),
      vector("typed accent then g$", "abc", ["i", "é", "<Esc>", "g", "$"]),
      vector("gj over ASCII", "abc\n\tdef", ["g", "j"]),
      vector("column motion over CJK", "日本語\nabc", ["<Down>", "j"]),
    ];
    expect(fontDependentCases(cases)).toEqual([
      "gj over CJK",
      "page down over emoji",
      "typed accent then g$",
    ]);
  });

  it("finds none in the committed vectors", () => {
    const { cases } = parseVectors(readFileSync(VECTORS_PATH, "utf8"));
    expect(fontDependentCases(cases)).toEqual([]);
  });
});
