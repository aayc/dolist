import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { mergeText } from "./merge";

/**
 * Notes whose lines are unique (blank lines aside), edited on both sides with lines that are
 * unique too, so where each output line came from is unambiguous. "edit" appends a word to lines
 * (still similar to what they were), "replace" puts new lines in their place.
 */
interface Edit {
  kind: "insert" | "delete" | "replace" | "edit";
  at: number;
  count: number;
}

const editArb: fc.Arbitrary<Edit> = fc.record({
  kind: fc.constantFrom("insert", "delete", "replace", "edit"),
  at: fc.nat(),
  count: fc.integer({ min: 1, max: 3 }),
});

const baseArb = fc
  .array(fc.boolean(), { maxLength: 14 })
  .map((blanks) => blanks.map((blank, i) => (blank ? "" : `- [ ] base ${i}`)));

function edit(base: readonly string[], edits: readonly Edit[], side: string): string[] {
  const lines = [...base];
  let n = 0;
  const fresh = () => `${side} ${n++}`;
  for (const { kind, at, count } of edits) {
    const i = at % (lines.length + 1);
    const added = Array.from({ length: count }, fresh);
    if (kind === "insert") lines.splice(i, 0, ...added);
    else if (kind === "delete") lines.splice(i, count);
    else if (kind === "replace") lines.splice(i, count, ...added);
    else {
      for (let k = i; k < Math.min(lines.length, i + count); k++) {
        if (lines[k] !== "") lines[k] = `${lines[k]} ${fresh()}`;
      }
    }
  }
  return lines;
}

const tripleArb = fc
  .tuple(baseArb, fc.array(editArb, { maxLength: 4 }), fc.array(editArb, { maxLength: 4 }))
  .map(([base, mine, theirs]) => ({
    base,
    local: edit(base, mine, "mine"),
    remote: edit(base, theirs, "theirs"),
  }));

const content = (lines: readonly string[]) => new Set(lines.filter((line) => line !== ""));

/** The other side (the agent, say) only adds lines and types on existing ones. */
const addingArb = fc
  .tuple(
    baseArb,
    fc.array(editArb, { maxLength: 4 }),
    fc.array(
      editArb.map((e) => ({
        ...e,
        kind: e.kind === "insert" ? ("insert" as const) : ("edit" as const),
      })),
      { maxLength: 4 },
    ),
  )
  .map(([base, mine, theirs]) => ({
    base,
    local: edit(base, mine, "mine"),
    remote: edit(base, theirs, "theirs"),
  }));

describe("mergeText (properties)", () => {
  test.prop([tripleArb])(
    "never brings back a line the other side deleted unless the user typed it",
    ({ base, local, remote }) => {
      const { text } = mergeText(base.join("\n"), local.join("\n"), remote.join("\n"));
      const typed = content(local.filter((line) => !base.includes(line)));
      const theirs = content(remote);
      for (const line of content(text.split("\n"))) {
        expect(theirs.has(line) || typed.has(line), `resurrected ${JSON.stringify(line)}`).toBe(
          true,
        );
      }
    },
  );

  test.prop([tripleArb])("never loses what the user typed", ({ base, local, remote }) => {
    const out = content(
      mergeText(base.join("\n"), local.join("\n"), remote.join("\n")).text.split("\n"),
    );
    for (const line of content(local.filter((line) => !base.includes(line)))) {
      expect(out.has(line), `lost ${JSON.stringify(line)}`).toBe(true);
    }
  });

  test.prop([tripleArb])(
    "keeps a line the user deleted deleted, and without a conflict everything the other side added",
    ({ base, local, remote }) => {
      const { text, conflict } = mergeText(base.join("\n"), local.join("\n"), remote.join("\n"));
      const out = content(text.split("\n"));
      for (const line of content(base)) {
        if (!local.includes(line) && remote.includes(line)) expect(out.has(line)).toBe(false);
      }
      if (conflict) return;
      for (const line of content(remote.filter((line) => !base.includes(line)))) {
        expect(out.has(line), `dropped ${JSON.stringify(line)}`).toBe(true);
      }
    },
  );

  test.prop([addingArb])(
    "keeps every line the other side added next to lines it typed on, whatever the user did",
    ({ base, local, remote }) => {
      const out = content(
        mergeText(base.join("\n"), local.join("\n"), remote.join("\n")).text.split("\n"),
      );
      for (const line of remote.filter((line) => line.startsWith("theirs"))) {
        expect(out.has(line), `dropped ${JSON.stringify(line)}`).toBe(true);
      }
    },
  );
});
