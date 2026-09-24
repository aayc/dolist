import { describe, expect, it } from "vitest";
import { placeInTabs, removeFromTabs, renameInTabs } from "./tabs-store";

describe("tab placement", () => {
  it("opens the first note in a new tab and replaces the active tab afterwards", () => {
    let state = placeInTabs({ tabs: [], active: null }, "a.md", false);
    expect(state).toEqual({ tabs: ["a.md"], active: "a.md" });
    state = placeInTabs(state, "b.md", false);
    expect(state).toEqual({ tabs: ["b.md"], active: "b.md" });
  });

  it("inserts new tabs after the active one", () => {
    const state = placeInTabs({ tabs: ["a.md", "b.md"], active: "a.md" }, "c.md", true);
    expect(state).toEqual({ tabs: ["a.md", "c.md", "b.md"], active: "c.md" });
  });

  it("activates an already-open note instead of duplicating it", () => {
    const state = placeInTabs({ tabs: ["a.md", "b.md"], active: "a.md" }, "b.md", false);
    expect(state).toEqual({ tabs: ["a.md", "b.md"], active: "b.md" });
  });

  it("closing the active tab activates the right neighbour, then the left", () => {
    expect(removeFromTabs({ tabs: ["a", "b", "c"], active: "b" }, "b")).toEqual({
      tabs: ["a", "c"],
      active: "c",
    });
    expect(removeFromTabs({ tabs: ["a", "b"], active: "b" }, "b")).toEqual({
      tabs: ["a"],
      active: "a",
    });
    expect(removeFromTabs({ tabs: ["a"], active: "a" }, "a")).toEqual({ tabs: [], active: null });
    expect(removeFromTabs({ tabs: ["a", "b"], active: "a" }, "b")).toEqual({
      tabs: ["a"],
      active: "a",
    });
  });

  it("renames notes and notes inside renamed folders", () => {
    expect(renameInTabs({ tabs: ["Old/a.md", "b.md"], active: "Old/a.md" }, "Old", "New")).toEqual({
      tabs: ["New/a.md", "b.md"],
      active: "New/a.md",
    });
  });
});
