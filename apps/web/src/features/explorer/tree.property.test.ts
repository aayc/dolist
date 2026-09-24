import { dirname, type VaultEntry } from "@ddl/core";
import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";
import { buildTree, compareNodes, displayName, type TreeNode } from "./tree";

/** Names that sort weirdly: numbers, case and accent variants, symbols, CJK, emoji, spaces. */
const segment = fc.constantFrom(
  "a",
  "A",
  "b",
  "B",
  "2",
  "9",
  "10",
  "Day 2",
  "Day 10",
  "Note",
  "note",
  "resume",
  "résumé",
  "Ä",
  "ä",
  "z",
  "日本",
  "😀",
  "_x",
  "-y",
  "x.y",
  "with space",
);

const entries: fc.Arbitrary<VaultEntry[]> = fc
  .uniqueArray(
    fc.tuple(
      fc.array(segment, { minLength: 1, maxLength: 8 }),
      fc.constantFrom(".md", ".md", ".png", ".MD", "", "folder"),
    ),
    {
      selector: ([parts, ext]) => `${parts.join("/")}|${ext === "folder" || ext === "" ? "" : ext}`,
      maxLength: 25,
    },
  )
  .map((items) => {
    const byPath = new Map<string, VaultEntry>();
    for (const [parts, ext] of items) {
      const kind = ext === "folder" ? "folder" : "file";
      const path = parts.join("/") + (ext === "folder" ? "" : ext);
      if (!byPath.has(path)) byPath.set(path, { path, kind });
    }
    // A path can't be both a file and a folder.
    const folders = new Set<string>();
    for (const path of byPath.keys()) {
      for (let dir = dirname(path); dir; dir = dirname(dir)) folders.add(dir);
    }
    return [...byPath.values()].filter((e) => !(e.kind === "file" && folders.has(e.path)));
  });

function flatten(nodes: readonly TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const node of nodes) {
    out.push(node);
    flatten(node.children, out);
  }
  return out;
}

function shape(nodes: readonly TreeNode[]): unknown {
  return nodes.map((n) => [n.path, n.kind, shape(n.children)]);
}

describe("buildTree (properties)", () => {
  test.prop([entries])("places every entry once, under its parent folder", (input) => {
    const tree = buildTree(input);
    const all = flatten(tree);
    const paths = all.map((n) => n.path);
    expect(new Set(paths).size, "no duplicate nodes").toBe(paths.length);
    for (const entry of input) expect(paths).toContain(entry.path);
    const check = (nodes: readonly TreeNode[], parent: string) => {
      for (const node of nodes) {
        expect(dirname(node.path)).toBe(parent);
        expect(node.name).toBe(displayName(node.path, node.kind));
        if (node.kind === "file") expect(node.children).toEqual([]);
        check(node.children, node.path);
      }
    };
    check(tree, "");
    // Every folder is either explicit or implied by something inside it.
    for (const node of all) {
      if (node.kind !== "folder") continue;
      const explicit = input.some((e) => e.path === node.path);
      expect(explicit || node.children.length > 0).toBe(true);
    }
  });

  test.prop([entries])("sorts folders first, then names naturally", (input) => {
    const visit = (nodes: readonly TreeNode[]) => {
      for (let i = 1; i < nodes.length; i++) {
        expect(compareNodes(nodes[i - 1]!, nodes[i]!)).toBeLessThanOrEqual(0);
      }
      const firstFile = nodes.findIndex((n) => n.kind === "file");
      if (firstFile >= 0) expect(nodes.slice(firstFile).every((n) => n.kind === "file")).toBe(true);
      for (const node of nodes) visit(node.children);
    };
    visit(buildTree(input));
  });

  test.prop([
    entries.chain((e) => fc.tuple(fc.constant(e), fc.shuffledSubarray(e, { minLength: e.length }))),
  ])("is deterministic: the same entries in any order give the same tree", ([input, shuffled]) => {
    expect(shape(buildTree(shuffled))).toEqual(shape(buildTree(input)));
  });

  it("orders names that differ only by case or accents deterministically", () => {
    const a = buildTree([
      { path: "note.md", kind: "file" },
      { path: "Note.md", kind: "file" },
      { path: "résumé.md", kind: "file" },
      { path: "resume.md", kind: "file" },
    ]).map((n) => n.path);
    const b = buildTree([
      { path: "resume.md", kind: "file" },
      { path: "Note.md", kind: "file" },
      { path: "note.md", kind: "file" },
      { path: "résumé.md", kind: "file" },
    ]).map((n) => n.path);
    expect(a).toEqual(b);
  });

  it("keeps deep nesting and empty folders", () => {
    const deep = "a/b/c/d/e/f/g/h/i/j/k.md";
    const tree = buildTree([
      { path: deep, kind: "file" },
      { path: "empty", kind: "folder" },
      { path: "empty/nested-empty", kind: "folder" },
    ]);
    const all = flatten(tree);
    expect(all.find((n) => n.path === deep)?.name).toBe("k");
    expect(all.find((n) => n.path === "empty/nested-empty")?.children).toEqual([]);
    expect(tree.map((n) => n.path)).toEqual(["a", "empty"]);
  });
});
