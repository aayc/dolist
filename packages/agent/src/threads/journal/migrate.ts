/**
 * Brings thread files other than journals into the journals, at every load of the thread store and
 * before it reads them, so only the device running the agent (the lease holder) writes here:
 *
 * - **Snapshots older apps wrote** (`threads/<id>.json`, and sync conflict copies of them). One
 *   that holds something its journal lacks becomes a `thread.imported` event, in the order older
 *   apps merged them (the thread's own file, then copies from the most recently updated), so the
 *   journal folds to the thread they served. Its id comes from the snapshot's content: two devices
 *   migrating at once write the same line, which the union merge keeps once, and running it again
 *   appends nothing. Unreadable snapshots and ones a newer app wrote are left alone and reported;
 *   nothing is written for a thread whose own snapshot a newer app wrote while it has no journal.
 * - **Conflict copies of journals a third-party sync made** (`thr_a 2.jsonl`,
 *   `thr_a (conflicted copy).jsonl`): the events the journal lacks are appended as they are, the
 *   union the SyncEngine would have made.
 *
 * A file is removed only once the journal, read back, holds every event planned from it, and
 * conditionally, so one rewritten meanwhile (an older app on another device) stays for the next
 * load; a partly unreadable one is copied into `corrupt/` first. Nothing is written to a journal a
 * newer app wrote.
 */

import {
  decodePersistedThread,
  decodePersistedThreadJournal,
  encodePersistedJournalEvent,
  PERSISTED_PATHS,
  type PersistedJournalEvent,
  type PersistedJournalRead,
  type PersistedThread,
  persistedQuarantinePath,
  persistedThreadIdFromJournalPath,
  persistedThreadIdFromPath,
  persistedThreadImportEvent,
  persistedThreadJournalPath,
} from "@ddl/contract";
import type { Logger } from "@ddl/core";
import { errorMessage } from "@ddl/core";
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

/** A file directly in `folder` with the extension `ext`. */
function isChild(path: string, folder: string, ext: string): boolean {
  return (
    path.startsWith(`${folder}/`) &&
    path.endsWith(ext) &&
    !path.slice(folder.length + 1).includes("/")
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

export async function migrateThreadFiles(context: Context): Promise<void> {
  await mergeJournalCopies(context);
  await migrateSnapshots(context);
}

async function migrateSnapshots(context: Context): Promise<void> {
  const { storage, logger } = context;
  const files = await readFiles(storage, PERSISTED_PATHS.threads, ".json");
  if (files.length === 0) return;
  const { threads, skipped, newer } = readSnapshots(files);
  for (const { file, reason } of skipped) {
    logger.warn("Left a thread snapshot alone", { path: file.path, reason });
  }
  let moved = 0;
  await forEachLimited([...threads], CONCURRENCY, async ([id, snapshots]) => {
    const held = await appendUntilHeld(context, id, (read, exists) => {
      if (exists || !newer.has(id)) {
        return planSnapshotImports(
          id,
          read.events,
          snapshots.map((s) => s.thread),
        );
      }
      logger.warn("Not journaling a thread whose own snapshot a newer version of the app wrote", {
        threadId: id,
      });
      return null;
    });
    if (!held) return;
    for (const { file, repaired } of snapshots) {
      if (!repaired || (await keepEvidence(context, file))) await remove(context, file);
    }
    moved++;
  });
  if (moved > 0) logger.info("Moved thread snapshots into their journals", { threads: moved });
}

async function mergeJournalCopies(context: Context): Promise<void> {
  const copies = await readFiles(
    context.storage,
    PERSISTED_PATHS.threadJournals,
    ".jsonl",
    (path) => persistedThreadIdFromJournalPath(path) === null,
  );
  await forEachLimited(copies, CONCURRENCY, async (file) => {
    const read = decodePersistedThreadJournal(file.text);
    const owners = new Set(
      read.events.flatMap((e) =>
        e.type === "thread.created" || e.type === "thread.imported" ? [e.thread.id] : [],
      ),
    );
    const [id] = owners;
    if (read.newer !== null || owners.size !== 1 || !id) {
      context.logger.warn("Left a thread journal copy alone", {
        path: file.path,
        reason: read.newer !== null ? `format v${read.newer}` : "no single thread",
      });
      return;
    }
    if (!(await appendUntilHeld(context, id, () => read.events))) return;
    if (read.issues.length === 0 || (await keepEvidence(context, file)))
      await remove(context, file);
  });
}

async function readFiles(
  storage: StorageProvider,
  folder: string,
  ext: string,
  wanted: (path: string) => boolean = () => true,
) {
  const paths = (await storage.list({ prefix: folder, includeHidden: true }))
    .map((entry) => entry.path)
    .filter((path) => isChild(path, folder, ext) && wanted(path));
  const files: StoredFile[] = [];
  await forEachLimited(paths, CONCURRENCY, async (path) => {
    const file = await storage.read(path);
    if (file) files.push({ path, text: file.content, version: file.version });
  });
  return files;
}

/**
 * Appends to a thread's journal the events `plan` gives that it doesn't hold yet (by id), until it
 * holds them all (true), or gives up (false): `plan` refused (null), the journal is a newer app's,
 * or it kept changing. Failures are reported; the next load retries.
 */
async function appendUntilHeld(
  context: Context,
  id: string,
  plan: (read: PersistedJournalRead, exists: boolean) => PersistedJournalEvent[] | null,
): Promise<boolean> {
  const { storage, logger } = context;
  const path = persistedThreadJournalPath(id);
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const journal = await storage.read(path);
      const read = decodePersistedThreadJournal(journal?.content ?? "", id);
      if (read.newer !== null) {
        logger.warn("Not migrating into a journal a newer version of the app wrote", {
          threadId: id,
        });
        return false;
      }
      const planned = plan(read, journal !== null);
      if (planned === null) return false;
      const known = new Set(read.events.map((event) => event.id));
      const missing = planned.filter((event) => !known.has(event.id));
      if (missing.length === 0) return true;
      const text =
        (read.endsWithNewline ? "" : "\n") + missing.map(encodePersistedJournalEvent).join("");
      try {
        await appendToFile(storage, path, text, { ifMatch: journal?.version ?? null });
      } catch (error) {
        if (!isNamed(error, "ConflictError")) throw error;
      }
    }
    logger.warn("A thread's journal kept changing while files were migrated into it", {
      threadId: id,
    });
  } catch (error) {
    logger.warn("Failed to migrate into a thread's journal; will retry at the next start", {
      threadId: id,
      error: errorMessage(error),
    });
  }
  return false;
}

/** Removes a file unless it changed since it was read (then the next load looks at it again). */
async function remove(context: Context, file: StoredFile): Promise<void> {
  try {
    await context.storage.delete(file.path, { ifMatch: file.version });
  } catch (error) {
    if (isNamed(error, "ConflictError") || isNamed(error, "NotFoundError")) return;
    context.logger.warn("Could not remove a migrated thread file", {
      path: file.path,
      error: errorMessage(error),
    });
  }
}

/** Copies a partly unreadable file into `corrupt/` before it goes (false if that failed). */
async function keepEvidence(context: Context, file: StoredFile): Promise<boolean> {
  const at = new Date(context.now());
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const target = persistedQuarantinePath(file.path, at, attempt);
    try {
      await context.storage.write(target, file.text, { ifMatch: null });
      context.logger.warn("Kept a copy of a partly unreadable thread file", {
        path: file.path,
        copiedTo: target,
      });
      return true;
    } catch (error) {
      if (!isNamed(error, "ConflictError")) break;
    }
  }
  context.logger.warn("Could not keep a copy of a partly unreadable thread file; kept it", {
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
