import { basename, dirname, isMarkdownPath, stem, type VaultEntry } from "@ddl/core";

export interface TreeNode {
  path: string;
  name: string;
  kind: "file" | "folder";
  children: TreeNode[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Obsidian order: folders first, then case-insensitive natural sort ("Day 2" < "Day 10"). */
export function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return (
    collator.compare(a.name, b.name) ||
    collator.compare(a.path, b.path) ||
    // "Note" and "note" (or "resume" and "résumé") are equal to the collator: keep a total order.
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  );
}

export function displayName(path: string, kind: "file" | "folder"): string {
  return kind === "file" && isMarkdownPath(path) ? stem(path) : basename(path);
}

export function buildTree(entries: Iterable<VaultEntry>): TreeNode[] {
  const root: TreeNode = { path: "", name: "", kind: "folder", children: [] };
  const folders = new Map<string, TreeNode>([["", root]]);

  const folderNode = (path: string): TreeNode => {
    const existing = folders.get(path);
    if (existing) return existing;
    const node: TreeNode = { path, name: basename(path), kind: "folder", children: [] };
    folders.set(path, node);
    folderNode(dirname(path)).children.push(node);
    return node;
  };

  for (const entry of entries) {
    if (entry.kind === "folder") {
      folderNode(entry.path);
      continue;
    }
    folderNode(dirname(entry.path)).children.push({
      path: entry.path,
      name: displayName(entry.path, "file"),
      kind: "file",
      children: [],
    });
  }

  const sort = (node: TreeNode) => {
    node.children.sort(compareNodes);
    for (const child of node.children) if (child.kind === "folder") sort(child);
  };
  sort(root);
  return root.children;
}
