import { SIDECAR_DIR } from "@ddl/core";

/** Where sync bookkeeping lives inside the primary vault. Never synced itself. */
export const SYNC_STATE_DIR = `${SIDECAR_DIR}/sync`;

const FORMAT = 1;

/** What both sides looked like the last time a path was in sync. */
export interface SnapshotEntry {
  /** Primary version. */
  p: string;
  /** Target version. */
  t: string;
  /** The agreed content (mergeable text up to 256 KiB only): the base of a three-way merge. */
  b?: string;
}

export interface SyncSnapshot {
  entries: Map<string, SnapshotEntry>;
  /** Conflict copies created by sync that still exist in the vault. */
  conflicts: Set<string>;
}

export function emptySnapshot(): SyncSnapshot {
  return { entries: new Map(), conflicts: new Set() };
}

/** `.daily-do-list/sync/<target id>.json`, with the id made safe for any file system. */
export function snapshotPath(targetId: string): string {
  return `${SYNC_STATE_DIR}/${targetId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

export function serializeSnapshot(
  targetId: string,
  snapshot: SyncSnapshot,
  savedAt: number,
): string {
  const entries: Record<string, SnapshotEntry> = {};
  for (const [path, entry] of snapshot.entries) entries[path] = entry;
  return JSON.stringify({
    format: FORMAT,
    targetId,
    savedAt,
    entries,
    conflicts: [...snapshot.conflicts],
  });
}

/** Parses a persisted snapshot. Returns null if it is unreadable or belongs to another target. */
export function parseSnapshot(json: string, targetId: string): SyncSnapshot | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.format !== FORMAT || data.targetId !== targetId) return null;
  if (!isRecord(data.entries)) return null;
  const snapshot = emptySnapshot();
  for (const [path, value] of Object.entries(data.entries)) {
    if (!isRecord(value) || typeof value.p !== "string" || typeof value.t !== "string") continue;
    const entry: SnapshotEntry = { p: value.p, t: value.t };
    if (typeof value.b === "string") entry.b = value.b;
    snapshot.entries.set(path, entry);
  }
  if (Array.isArray(data.conflicts)) {
    for (const path of data.conflicts) if (typeof path === "string") snapshot.conflicts.add(path);
  }
  return snapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
