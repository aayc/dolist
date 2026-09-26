/**
 * Moves the thread snapshots older apps wrote (`threads/<id>.json`, and sync conflict copies of
 * them) into the threads' journals. The thread store runs it at every load, before it reads the
 * journals, so only the device running the agent (the lease holder) ever writes here.
 *
 * - A snapshot holding something its journal lacks becomes a `thread.imported` event appended to
 *   the journal, in the order older apps merged them (the thread's own file, then copies from the
 *   most recently updated), so the journal folds to the thread they served. Its id comes from the
 *   snapshot's content: two devices migrating at once write the same line, which the union merge
 *   keeps once, and running it again appends nothing.
 * - A snapshot is removed only once the journal, read back, holds all of it; the removal is
 *   conditional, so one rewritten meanwhile (an older app on another device) stays for the next
 *   load. A partly invalid snapshot is copied into `corrupt/` first.
 * - Unreadable snapshots and ones a newer app wrote are left alone and reported. Nothing is written
 *   for a thread whose journal a newer app wrote, or whose own snapshot a newer app wrote while it
 *   has no journal.
 */
import {
  decodePersistedThread,
  decodePersistedThreadJournal,
  encodePersistedJournalEvent,
  PERSISTED_PATHS,
  type PersistedJournalEvent,
  type PersistedThread,
  persistedQuarantinePath,
  persistedThreadIdFromPath,
  persistedThreadImportEvent,
  persistedThreadJournalPath,
} from "@ddl/contract";
import type { Logger } from "@ddl/core";
import { appendToFile, type StorageProvider } from "@ddl/storage";
import { applyJournalPayload, foldJournal, snapshotAddsTo } from "./fold";

const CONCURRENCY = 16;
const MAX_ATTEMPTS = 4;
const MAX_NAME_ATTEMPTS = 20;

export interface SnapshotFile {
  path: string;
  text: string;
}

export interface ThreadSnapshot<F extends SnapshotFile = SnapshotFile> {
  file: F;
  thread: PersistedThread;
  /** Invalid entries were dropped while reading it. */
  repaired: boolean;
}

export interface ReadSnapshots<F extends SnapshotFile> {
  /** Readable snapshots by thread, in merge order. */
  threads: Map<string, ThreadSnapshot<F>[]>;
  /** Files left alone: unreadable, or written by a newer app. */
  skipped: Array<{ file: F; reason: string }>;
  /** Threads whose own snapshot a newer app wrote. */
  newer: Set<string>;
}

interface Context {
  storage: StorageProvider;
  logger: Logger;
  now: () => number;
}

type StoredFile = SnapshotFile & { version: string };

/** Whether a vault path is a snapshot (a file directly in `threads/`). */
export function isSnapshotPath(path: string): boolean {
  const prefix = `${PERSISTED_PATHS.threads}/`;
  return (
    path.startsWith(prefix) && path.endsWith(".json") && !path.slice(prefix.length).includes("/")
  );
}

/**
 * Decodes snapshot files. A file named like an id must hold that thread; any other name (a sync
 * conflict copy) counts for the thread it holds.
 */
export function readSnapshots<F extends SnapshotFile>(files: readonly F[]): ReadSnapshots<F> {
  const out: ReadSnapshots<F> = { threads: new Map(), skipped: [], newer: new Set() };
  for (const file of files) {
    const named = persistedThreadIdFromPath(file.path);
    const decoded = decodePersistedThread(file.text, named ?? undefined);
    if (!decoded.ok) {
      if (decoded.kind === "newer" && named) out.newer.add(named);
      const reason = decoded.kind === "newer" ? `format v${decoded.version}` : decoded.reason;
      out.skipped.push({ file, reason });
      continue;
    }
    const snapshot = { file, thread: decoded.value, repaired: decoded.issues.length > 0 };
    const list = out.threads.get(decoded.value.id);
    if (list) list.push(snapshot);
    else out.threads.set(decoded.value.id, [snapshot]);
  }
  for (const [id, list] of out.threads) {
    const own = (s: ThreadSnapshot<F>) => (persistedThreadIdFromPath(s.file.path) === id ? 0 : 1);
    list.sort(
      (a, b) =>
        own(a) - own(b) ||
        b.thread.updatedAt - a.thread.updatedAt ||
        (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0),
    );
  }
  return out;
}

/** The events that bring `snapshots` (in merge order) into a journal; none when it holds them. */
export function planSnapshotImports(
  threadId: string,
  events: readonly PersistedJournalEvent[],
  snapshots: readonly PersistedThread[],
): PersistedJournalEvent[] {
  const fold = foldJournal(events, threadId);
  let after = {
    epoch: events.at(-1)?.epoch ?? 0,
    seq: events.reduce((max, event) => Math.max(max, event.seq), 0),
  };
  const planned: PersistedJournalEvent[] = [];
  for (const thread of snapshots) {
    if (!snapshotAddsTo(fold, thread)) continue;
    const event = persistedThreadImportEvent(thread, after);
    applyJournalPayload(fold, event, event.at, threadId);
    after = event;
    planned.push(event);
  }
  return planned;
}

export async function migrateThreadSnapshots(context: Context): Promise<void> {
  const { storage, logger } = context;
  const paths = (await storage.list({ prefix: PERSISTED_PATHS.threads, includeHidden: true }))
    .map((entry) => entry.path)
    .filter(isSnapshotPath);
  if (paths.length === 0) return;
  const files: StoredFile[] = [];
  await forEachLimited(paths, CONCURRENCY, async (path) => {
    const file = await storage.read(path);
    if (file) files.push({ path, text: file.content, version: file.version });
  });
  const { threads, skipped, newer } = readSnapshots(files);
  for (const { file, reason } of skipped) {
    logger.warn("Left a thread snapshot alone", { path: file.path, reason });
  }
  let moved = 0;
  await forEachLimited([...threads], CONCURRENCY, async ([id, snapshots]) => {
    try {
      if (await migrateThread(context, id, snapshots, newer.has(id))) moved++;
    } catch (error) {
      logger.warn("Failed to migrate a thread's snapshots; will retry at the next start", {
        threadId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  if (moved > 0) logger.info("Moved thread snapshots into their journals", { threads: moved });
}

/** True once the journal holds every snapshot of the thread and they were removed. */
async function migrateThread(
  context: Context,
  id: string,
  snapshots: ThreadSnapshot<StoredFile>[],
  ownIsNewer: boolean,
): Promise<boolean> {
  const { storage, logger } = context;
  const path = persistedThreadJournalPath(id);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const journal = await storage.read(path);
    if (!journal && ownIsNewer) {
      logger.warn("Not journaling a thread whose own snapshot a newer version of the app wrote", {
        threadId: id,
      });
      return false;
    }
    const read = decodePersistedThreadJournal(journal?.content ?? "", id);
    if (read.newer !== null) {
      logger.warn("Left the snapshots of a thread whose journal a newer version of the app wrote", {
        threadId: id,
      });
      return false;
    }
    const planned = planSnapshotImports(
      id,
      read.events,
      snapshots.map((s) => s.thread),
    );
    if (planned.length === 0) {
      await removeSnapshots(context, snapshots);
      return true;
    }
    const known = new Set(read.events.map((event) => event.id));
    if (planned.some((event) => known.has(event.id))) {
      logger.warn("A thread's journal doesn't hold its snapshots after importing them; kept them", {
        threadId: id,
      });
      return false;
    }
    const text =
      (read.endsWithNewline ? "" : "\n") + planned.map(encodePersistedJournalEvent).join("");
    try {
      await appendToFile(storage, path, text, { ifMatch: journal?.version ?? null });
    } catch (error) {
      if (!isNamed(error, "ConflictError")) throw error;
    }
  }
  logger.warn("A thread's journal kept changing while its snapshots were migrated", {
    threadId: id,
  });
  return false;
}

async function removeSnapshots(
  context: Context,
  snapshots: ThreadSnapshot<StoredFile>[],
): Promise<void> {
  for (const { file, repaired } of snapshots) {
    if (repaired && !(await keepEvidence(context, file))) continue;
    try {
      await context.storage.delete(file.path, { ifMatch: file.version });
    } catch (error) {
      if (!isNamed(error, "ConflictError") && !isNamed(error, "NotFoundError")) throw error;
      context.logger.info("A thread snapshot changed while it was migrated; it moves next time", {
        path: file.path,
      });
    }
  }
}

/** Copies a partly invalid snapshot into `corrupt/` (false if that failed). */
async function keepEvidence(context: Context, file: StoredFile): Promise<boolean> {
  const at = new Date(context.now());
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const target = persistedQuarantinePath(file.path, at, attempt);
    try {
      await context.storage.write(target, file.text, { ifMatch: null });
      context.logger.warn("Kept a copy of a partly invalid thread snapshot", {
        path: file.path,
        copiedTo: target,
      });
      return true;
    } catch (error) {
      if (!isNamed(error, "ConflictError")) break;
    }
  }
  context.logger.warn("Could not keep a copy of a partly invalid thread snapshot; kept it", {
    path: file.path,
  });
  return false;
}

/** Runs `task` for every item, at most `limit` at a time. */
export async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function isNamed(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}
