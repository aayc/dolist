import {
  ancestorFolders,
  hashString,
  type NoteResponse,
  type SearchHit,
  type VaultEntry,
} from "@ddl/core";

export interface MockNote {
  content: string;
  version: string;
  mtime: number;
}

export interface PathMove {
  from: string;
  to: string;
}

function isUnder(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}

/** In-memory vault with the daemon's semantics (content-hash versions, implicit parent folders). */
export class MockVault {
  private readonly notes = new Map<string, MockNote>();
  private readonly folders = new Set<string>();

  has(path: string): boolean {
    return this.notes.has(path);
  }

  isFolder(path: string): boolean {
    return this.folders.has(path);
  }

  get(path: string): MockNote | undefined {
    return this.notes.get(path);
  }

  toResponse(path: string): NoteResponse | null {
    const note = this.notes.get(path);
    return note ? { path, content: note.content, version: note.version, mtime: note.mtime } : null;
  }

  write(path: string, content: string, now = Date.now()): MockNote {
    const note: MockNote = { content, version: hashString(content), mtime: now };
    this.notes.set(path, note);
    for (const folder of ancestorFolders(path)) this.folders.add(folder);
    return note;
  }

  delete(path: string): boolean {
    return this.notes.delete(path);
  }

  createFolder(path: string): void {
    for (const folder of ancestorFolders(path)) this.folders.add(folder);
    this.folders.add(path);
  }

  /** Removes a folder and everything under it; returns the deleted note paths. */
  deleteFolder(path: string): string[] {
    const removed: string[] = [];
    for (const notePath of [...this.notes.keys()]) {
      if (isUnder(notePath, path)) {
        this.notes.delete(notePath);
        removed.push(notePath);
      }
    }
    for (const folder of [...this.folders]) {
      if (folder === path || isUnder(folder, path)) this.folders.delete(folder);
    }
    return removed;
  }

  /** Renames a note or a folder (moving its contents); returns the moved note paths. */
  rename(from: string, to: string, now = Date.now()): PathMove[] {
    const moves: PathMove[] = [];
    const note = this.notes.get(from);
    if (note) {
      this.notes.delete(from);
      this.write(to, note.content, now);
      moves.push({ from, to });
      return moves;
    }
    if (!this.folders.has(from)) return moves;
    for (const [path, value] of [...this.notes]) {
      if (!isUnder(path, from)) continue;
      const target = `${to}${path.slice(from.length)}`;
      this.notes.delete(path);
      this.write(target, value.content, now);
      moves.push({ from: path, to: target });
    }
    for (const folder of [...this.folders]) {
      if (folder === from || isUnder(folder, from)) {
        this.folders.delete(folder);
        this.createFolder(`${to}${folder.slice(from.length)}`);
      }
    }
    this.createFolder(to);
    return moves;
  }

  paths(): string[] {
    return [...this.notes.keys()];
  }

  entries(): VaultEntry[] {
    const out: VaultEntry[] = [...this.folders].map((path) => ({ path, kind: "folder" as const }));
    for (const [path, note] of this.notes) {
      out.push({
        path,
        kind: "file",
        size: note.content.length,
        mtime: note.mtime,
        version: note.version,
      });
    }
    return out;
  }

  search(query: string, limit = 200): SearchHit[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const hits: SearchHit[] = [];
    const paths = [...this.notes.keys()].sort();
    for (const path of paths) {
      if (path.toLowerCase().includes(needle)) {
        hits.push({ path, kind: "name", line: 0, preview: path });
        if (hits.length >= limit) return hits;
      }
    }
    for (const path of paths) {
      const lines = this.notes.get(path)!.content.split("\n");
      for (let line = 0; line < lines.length; line++) {
        const text = lines[line]!;
        const at = text.toLowerCase().indexOf(needle);
        if (at === -1) continue;
        const start = Math.max(0, at - 60);
        const preview = `${start > 0 ? "…" : ""}${text.slice(start, at + needle.length + 100).trim()}`;
        hits.push({ path, kind: "content", line, preview });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }
}
