import { describe, expect, it } from "vitest";
import { mergeLines, mergeText3 } from "./diff3";

// Stretched on slow CI runners (TEST_TIME_SCALE, see scripts/vitest/setup-fast-check.ts).
const TIME_SCALE = Number(process.env.TEST_TIME_SCALE) || 1;

describe("mergeText3", () => {
  const base = "# Today\n- [ ] one\n- [ ] two\n- [ ] three\n- [ ] four\n";

  it("merges edits to adjacent lines", () => {
    const ours = base.replace("- [ ] two", "- [x] two");
    const theirs = base.replace("- [ ] three", "- [x] three");
    expect(mergeText3(base, ours, theirs)).toEqual({
      clean: true,
      text: "# Today\n- [ ] one\n- [x] two\n- [x] three\n- [ ] four\n",
    });
  });

  it("merges an insertion next to an edit", () => {
    const ours = base.replace("- [ ] two\n", "- [ ] two\n- [ ] new task\n");
    const theirs = base.replace("- [ ] three", "- [x] three");
    expect(mergeText3(base, ours, theirs)).toEqual({
      clean: true,
      text: "# Today\n- [ ] one\n- [ ] two\n- [ ] new task\n- [x] three\n- [ ] four\n",
    });
  });

  it("reports conflicting edits to the same line with markers", () => {
    const ours = base.replace("two", "two (mine)");
    const theirs = base.replace("two", "two (theirs)");
    const result = mergeText3(base, ours, theirs);
    expect(result.clean).toBe(false);
    expect(result).toMatchObject({ conflicts: 1 });
    expect(result.text).toBe(
      "# Today\n- [ ] one\n<<<<<<< ours\n- [ ] two (mine)\n||||||| base\n- [ ] two\n=======\n- [ ] two (theirs)\n>>>>>>> theirs\n- [ ] three\n- [ ] four\n",
    );
  });

  it("treats a delete racing an edit of the same line as a conflict", () => {
    const ours = base.replace("- [ ] two\n", "");
    const theirs = base.replace("two", "two!");
    expect(mergeText3(base, ours, theirs).clean).toBe(false);
  });

  it("keeps both sides' insertions at the same spot, ours first", () => {
    const ours = `${base}- [ ] buy milk\n`;
    const theirs = `${base}- [ ] call the plumber\n`;
    expect(mergeText3(base, ours, theirs)).toEqual({
      clean: true,
      text: `${base}- [ ] buy milk\n- [ ] call the plumber\n`,
    });
  });

  it("never unions over a replaced base line", () => {
    expect(mergeText3("x", "a", "b").clean).toBe(false);
  });

  it("keeps a trailing newline one side added", () => {
    expect(mergeText3("a\nb", "a!\nb", "a\nb\n")).toEqual({ clean: true, text: "a!\nb\n" });
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
});
