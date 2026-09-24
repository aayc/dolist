import { describe, expect, it } from "vitest";
import { buildTree } from "./tree";

describe("buildTree", () => {
  it("nests entries, shows note names without .md and sorts folders first, naturally", () => {
    const tree = buildTree([
      { path: "Day 10.md", kind: "file" },
      { path: "Day 2.md", kind: "file" },
      { path: "attachments/photo.png", kind: "file" },
      { path: "Projects", kind: "folder" },
      { path: "Projects/b.md", kind: "file" },
      { path: "Projects/A.md", kind: "file" },
      { path: "Daily/2026-09-23.md", kind: "file" },
    ]);
    expect(tree.map((n) => n.name)).toEqual([
      "attachments",
      "Daily",
      "Projects",
      "Day 2",
      "Day 10",
    ]);
    expect(tree[0]?.children.map((n) => n.name)).toEqual(["photo.png"]);
    expect(tree[2]?.children.map((n) => n.name)).toEqual(["A", "b"]);
    expect(tree[1]?.kind).toBe("folder");
  });
});
