import { ancestorFolders, isHiddenPath, type VaultEntry, type VaultTreeResponse } from "@ddl/core";
import { create } from "zustand";

export interface VaultState {
  vaultName: string;
  loaded: boolean;
  entries: ReadonlyMap<string, VaultEntry>;
  /** Sorted file paths; recomputed on structural changes only (never per keystroke). */
  files: readonly string[];
}

export const useVaultStore = create<VaultState>(() => ({
  vaultName: "",
  loaded: false,
  entries: new Map(),
  files: [],
}));

function filesOf(entries: ReadonlyMap<string, VaultEntry>): string[] {
  const out: string[] = [];
  for (const entry of entries.values()) if (entry.kind === "file") out.push(entry.path);
  return out.sort();
}

/**
 * Changes not published yet. A burst of vault events (sync, an import) is published once, on the
 * next frame, instead of rebuilding the file list and the explorer per event.
 */
let draft: Map<string, VaultEntry> | null = null;

function current(): ReadonlyMap<string, VaultEntry> {
  return draft ?? useVaultStore.getState().entries;
}

function edit(): Map<string, VaultEntry> {
  if (!draft) {
    draft = new Map(useVaultStore.getState().entries);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(publish);
    else setTimeout(publish, 0);
  }
  return draft;
}

function publish(): void {
  if (!draft) return;
  const entries = draft;
  draft = null;
  useVaultStore.setState({ entries, files: filesOf(entries) });
}

function withAncestors(entries: Map<string, VaultEntry>, path: string): void {
  for (const folder of ancestorFolders(path)) {
    if (!entries.has(folder)) entries.set(folder, { path: folder, kind: "folder" });
  }
}

function isUnder(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}

export const vaultActions = {
  setTree(tree: VaultTreeResponse): void {
    draft = null;
    const entries = new Map<string, VaultEntry>();
    for (const entry of tree.entries) {
      if (isHiddenPath(entry.path)) continue;
      entries.set(entry.path, entry);
      withAncestors(entries, entry.path);
    }
    useVaultStore.setState({
      vaultName: tree.vaultName,
      loaded: true,
      entries,
      files: filesOf(entries),
    });
  },

  addFile(path: string, version?: string): void {
    if (isHiddenPath(path) || current().get(path)?.kind === "file") return;
    const entries = edit();
    entries.set(path, { path, kind: "file", ...(version ? { version } : {}) });
    withAncestors(entries, path);
  },

  addFolder(path: string): void {
    if (current().has(path)) return;
    const entries = edit();
    entries.set(path, { path, kind: "folder" });
    withAncestors(entries, path);
  },

  remove(path: string): void {
    if (!current().has(path)) return;
    const entries = edit();
    entries.delete(path);
    for (const key of [...entries.keys()]) if (isUnder(key, path)) entries.delete(key);
  },

  rename(from: string, to: string): void {
    const entry = current().get(from);
    if (!entry) return;
    const entries = edit();
    const moved = [...entries].filter(([key]) => isUnder(key, from));
    entries.delete(from);
    entries.set(to, { ...entry, path: to });
    withAncestors(entries, to);
    for (const [key, value] of moved) {
      entries.delete(key);
      const target = `${to}${key.slice(from.length)}`;
      entries.set(target, { ...value, path: target });
    }
  },

  has(path: string): boolean {
    return current().has(path);
  },

  isFolder(path: string): boolean {
    return current().get(path)?.kind === "folder";
  },

  files(): readonly string[] {
    publish();
    return useVaultStore.getState().files;
  },
};
