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

function commit(entries: Map<string, VaultEntry>): void {
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
    if (isHiddenPath(path)) return;
    const current = useVaultStore.getState().entries;
    if (current.get(path)?.kind === "file") return;
    const entries = new Map(current);
    entries.set(path, { path, kind: "file", ...(version ? { version } : {}) });
    withAncestors(entries, path);
    commit(entries);
  },

  addFolder(path: string): void {
    const current = useVaultStore.getState().entries;
    if (current.has(path)) return;
    const entries = new Map(current);
    entries.set(path, { path, kind: "folder" });
    withAncestors(entries, path);
    commit(entries);
  },

  remove(path: string): void {
    const current = useVaultStore.getState().entries;
    if (!current.has(path)) return;
    const entries = new Map(current);
    entries.delete(path);
    for (const key of current.keys()) if (isUnder(key, path)) entries.delete(key);
    commit(entries);
  },

  rename(from: string, to: string): void {
    const current = useVaultStore.getState().entries;
    const entry = current.get(from);
    if (!entry) return;
    const entries = new Map(current);
    entries.delete(from);
    entries.set(to, { ...entry, path: to });
    withAncestors(entries, to);
    for (const [key, value] of current) {
      if (!isUnder(key, from)) continue;
      entries.delete(key);
      const moved = `${to}${key.slice(from.length)}`;
      entries.set(moved, { ...value, path: moved });
    }
    commit(entries);
  },

  has(path: string): boolean {
    return useVaultStore.getState().entries.has(path);
  },

  isFolder(path: string): boolean {
    return useVaultStore.getState().entries.get(path)?.kind === "folder";
  },

  files(): readonly string[] {
    return useVaultStore.getState().files;
  },
};
