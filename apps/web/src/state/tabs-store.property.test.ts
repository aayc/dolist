import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { placeInTabs, removeFromTabs, renameInTabs, type TabsState } from "./tabs-store";

const PATHS = ["a.md", "b.md", "Old/x.md", "Older/y.md", "Old/sub/z.md", "日本.md", "c.md"];
const path = fc.constantFrom(...PATHS);

type Op =
  | { kind: "open"; path: string; newTab: boolean }
  | { kind: "close"; path: string }
  | { kind: "closeActive" }
  | { kind: "rename"; from: string; to: string };

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("open"), path, newTab: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("close"), path }) },
  { weight: 2, arbitrary: fc.constant({ kind: "closeActive" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("rename"),
      from: fc.constantFrom("a.md", "Old", "Old/x.md", "日本.md"),
      to: fc.constantFrom("renamed.md", "New", "New/x.md", "日本語.md"),
    }),
  },
);

function expectValid(state: TabsState): void {
  expect(new Set(state.tabs).size, "no duplicate tabs").toBe(state.tabs.length);
  if (state.tabs.length === 0) expect(state.active).toBeNull();
  else expect(state.tabs).toContain(state.active);
}

describe("tabs (properties)", () => {
  test.prop([fc.array(op, { maxLength: 40 })])(
    "stay unique with a valid active tab through opens, closes and renames",
    (ops) => {
      let state: TabsState = { tabs: [], active: null };
      for (const o of ops) {
        const before = state;
        switch (o.kind) {
          case "open": {
            state = placeInTabs(state, o.path, o.newTab);
            expect(state.active).toBe(o.path);
            if (before.tabs.includes(o.path)) {
              expect(state.tabs).toEqual(before.tabs);
            } else if (before.active === null) {
              expect(state.tabs).toEqual([...before.tabs, o.path]);
            } else {
              const at = before.tabs.indexOf(before.active);
              if (o.newTab) expect(state.tabs[at + 1]).toBe(o.path);
              else expect(state.tabs[at]).toBe(o.path);
              expect(state.tabs.length).toBe(before.tabs.length + (o.newTab ? 1 : 0));
            }
            break;
          }
          case "close":
          case "closeActive": {
            const target = o.kind === "close" ? o.path : before.active;
            if (target === null) break;
            state = removeFromTabs(state, target);
            if (!before.tabs.includes(target)) {
              expect(state).toBe(before);
              break;
            }
            expect(state.tabs).toEqual(before.tabs.filter((p) => p !== target));
            if (before.active !== target) {
              expect(state.active).toBe(before.active);
            } else {
              const at = before.tabs.indexOf(target);
              expect(state.active).toBe(before.tabs[at + 1] ?? before.tabs[at - 1] ?? null);
            }
            break;
          }
          case "rename": {
            // The workspace refuses renames onto existing paths; mirror that precondition.
            if (before.tabs.some((p) => p === o.to || p.startsWith(`${o.to}/`))) break;
            state = renameInTabs(state, o.from, o.to);
            const moved = (p: string) =>
              p === o.from
                ? o.to
                : p.startsWith(`${o.from}/`)
                  ? `${o.to}${p.slice(o.from.length)}`
                  : p;
            expect(state.tabs).toEqual(before.tabs.map(moved));
            expect(state.active).toBe(before.active === null ? null : moved(before.active));
            break;
          }
        }
        expectValid(state);
      }
    },
  );

  it("renaming a folder never touches a sibling that shares its prefix", () => {
    const state = renameInTabs(
      { tabs: ["Old/x.md", "Older/y.md"], active: "Older/y.md" },
      "Old",
      "New",
    );
    expect(state).toEqual({ tabs: ["New/x.md", "Older/y.md"], active: "Older/y.md" });
  });

  it("closing the last tab leaves nothing active; reopening creates a single tab", () => {
    let state = removeFromTabs({ tabs: ["a.md"], active: "a.md" }, "a.md");
    expect(state).toEqual({ tabs: [], active: null });
    state = placeInTabs(state, "a.md", false);
    expect(state).toEqual({ tabs: ["a.md"], active: "a.md" });
  });
});
