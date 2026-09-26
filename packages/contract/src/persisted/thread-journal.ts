/**
 * `.daily-do-list/state/journal/threads/<threadId>.jsonl` — the append-only journal of one agent
 * thread, its only persisted form. One event per line (compact JSON, `\n`-terminated), written by
 * the thread store (packages/agent/src/threads/store.ts); the thread is the fold of its events.
 *
 * Every event has a unique `id` and an `(epoch, seq)`: `epoch` is the agent lease's grant (0 until
 * leases carry one), `seq` grows with every append. Readers order events by `(epoch, seq, id)`, so
 * the union of two copies (the SyncEngine's merge rule) folds the same way on every device.
 *
 * v1: every line carries `v: 1`. A line with a greater `v` was written by a newer app: the whole
 * journal is left alone. A line that doesn't parse or validate is skipped and reported; the rest of
 * the journal still loads.
 */
import { compareStrings, hashString } from "@ddl/core";
import { z } from "zod";
import {
  describeZodError,
  isPersistedObject,
  PersistedCorruption,
  type PersistedIssue,
  PersistedListSchema,
  PersistedMapSchema,
  parsePersistedJson,
  salvageList,
} from "./common";
import {
  PERSISTED_FILE_ID_PATTERN,
  PERSISTED_PATHS,
  PersistedCountSchema,
  PersistedFileIdSchema,
  PersistedIdSchema,
  PersistedSurfaceKindSchema,
  PersistedTaskAgentStatusSchema,
  PersistedTimestampSchema,
} from "./primitives";
import {
  PersistedArtifactMetaSchema,
  type PersistedCitedSource,
  PersistedCitedSourceSchema,
  type PersistedThread,
  PersistedThreadMessageSchema,
  readPersistedThreadObject,
} from "./thread";

export const PERSISTED_THREAD_JOURNAL_VERSION = 1;

/** `thr_a` → `.daily-do-list/state/journal/threads/thr_a.jsonl`. */
export function persistedThreadJournalPath(threadId: string): string {
  return `${PERSISTED_PATHS.threadJournals}/${threadId}.jsonl`;
}

/** The thread a journal file belongs to, or null for any other path. */
export function persistedThreadIdFromJournalPath(path: string): string | null {
  const folder = `${PERSISTED_PATHS.threadJournals}/`;
  if (!path.startsWith(folder) || !path.endsWith(".jsonl")) return null;
  const id = path.slice(folder.length, -".jsonl".length);
  return PERSISTED_FILE_ID_PATTERN.test(id) ? id : null;
}

const envelope = {
  v: z.literal(PERSISTED_THREAD_JOURNAL_VERSION),
  id: z.string().min(1).max(128),
  epoch: z.int().min(0),
  seq: z.int().min(0),
  at: PersistedTimestampSchema,
};

const CallIdSchema = z.string().min(1).max(512);

/** What a thread starts as (`thread.created`). */
export const PersistedJournalThreadHeaderSchema = z.object({
  id: PersistedFileIdSchema,
  taskId: z.string().nullable(),
  notePath: z.string().nullable(),
  title: z.string(),
  status: PersistedTaskAgentStatusSchema,
  createdAt: PersistedTimestampSchema,
  routineId: PersistedIdSchema.optional(),
});

/** How the safety gate let a call through (`tool.decided`). */
export const PersistedJournalAllowedViaSchema = z.enum([
  "evaluator",
  "policy",
  "grant",
  "approval",
]);
export type PersistedJournalAllowedVia = z.infer<typeof PersistedJournalAllowedViaSchema>;

const LineSchema = z.discriminatedUnion("type", [
  /** A new thread (always the first event of a journal the store started itself). */
  z.object({
    ...envelope,
    type: z.literal("thread.created"),
    thread: PersistedJournalThreadHeaderSchema,
  }),
  /**
   * A whole thread merged in with `mergePersistedThreads`: a snapshot an older app wrote
   * (`threads/<id>.json`) migrating into the journal, or the thread in memory restarting a journal
   * that disappeared.
   */
  z.object({ ...envelope, type: z.literal("thread.imported"), thread: PersistedMapSchema }),
  /** Adds a message, or replaces the one with the same id. */
  z.object({ ...envelope, type: z.literal("message"), message: PersistedThreadMessageSchema }),
  z.object({ ...envelope, type: z.literal("status"), status: PersistedTaskAgentStatusSchema }),
  z.object({ ...envelope, type: z.literal("title"), title: z.string() }),
  /** Drops the oldest messages beyond the newest `keep`. */
  z.object({ ...envelope, type: z.literal("trim"), keep: PersistedCountSchema }),
  z.object({ ...envelope, type: z.literal("surface"), surface: PersistedSurfaceKindSchema }),
  /** Pages the thread cites (merged by URL, newest kept, capped). */
  z.object({ ...envelope, type: z.literal("sources"), sources: PersistedListSchema }),
  z.object({ ...envelope, type: z.literal("artifact"), artifact: PersistedArtifactMetaSchema }),
  /** A tool call reached the safety gate. `input` is display-safe (secrets redacted, capped). */
  z.object({
    ...envelope,
    type: z.literal("tool.requested"),
    call: CallIdSchema,
    tool: z.string(),
    session: z.string(),
    input: z.unknown().optional(),
  }),
  /** The gate's decision; `approvalId` when a person approved it on a card. */
  z.object({
    ...envelope,
    type: z.literal("tool.decided"),
    call: CallIdSchema,
    allowed: z.boolean(),
    reason: z.string().optional(),
    via: PersistedJournalAllowedViaSchema.optional(),
    approvalId: z.string().optional(),
  }),
  /**
   * Write-ahead: the call is about to run (appended durably before it executes). Without a
   * `tool.finished` it is uncertain: it may or may not have happened, and is never re-run
   * automatically.
   */
  z.object({
    ...envelope,
    type: z.literal("tool.started"),
    call: CallIdSchema,
    tool: z.string(),
    /** What it does, in words ("Press Send in Slack"). */
    target: z.string(),
    approvalId: z.string().optional(),
    /** False for calls that change nothing (safe to redo); absent counts as true. */
    effectful: z.boolean().optional(),
  }),
  /** How it ended; `output` is what the model read (redacted, capped, images left out). */
  z.object({
    ...envelope,
    type: z.literal("tool.finished"),
    call: CallIdSchema,
    outcome: z.enum(["ok", "error", "blocked"]),
    output: z.string().optional(),
  }),
  /** A started call found without a result after a restart: shown as interrupted, never re-run. */
  z.object({ ...envelope, type: z.literal("tool.interrupted"), call: CallIdSchema }),
  /** A prompt sent to the thread's agent session (to rebuild the session after a restart). */
  z.object({ ...envelope, type: z.literal("run.prompted"), session: z.string(), text: z.string() }),
  /** The final text of one message the session's model wrote (the same rebuild). */
  z.object({ ...envelope, type: z.literal("run.text"), session: z.string(), text: z.string() }),
]);
type Line = z.output<typeof LineSchema>;

type WithThread<E, T> = E extends { thread: unknown } ? Omit<E, "thread"> & { thread: T } : never;

/** One decoded event. `thread.imported` carries a validated thread, `sources` validated pages. */
export type PersistedJournalEvent =
  | Exclude<Line, { type: "thread.imported" | "sources" }>
  | WithThread<Extract<Line, { type: "thread.imported" }>, PersistedThread>
  | (Omit<Extract<Line, { type: "sources" }>, "sources"> & { sources: PersistedCitedSource[] });

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** An event without its envelope: what a writer records. */
export type PersistedJournalPayload = DistributiveOmit<
  PersistedJournalEvent,
  "v" | "id" | "epoch" | "seq" | "at"
>;

export type PersistedJournalLineResult =
  | { ok: true; event: PersistedJournalEvent; issues: PersistedIssue[] }
  | { ok: false; kind: "corrupt"; reason: string }
  | { ok: false; kind: "newer"; version: number };

/** Decodes one line. Never throws; reasons never contain the line's content. */
export function decodePersistedJournalLine(line: string): PersistedJournalLineResult {
  const parsed = parsePersistedJson(line);
  if (!parsed.ok) return { ok: false, kind: "corrupt", reason: parsed.reason };
  if (!isPersistedObject(parsed.value)) {
    return { ok: false, kind: "corrupt", reason: "not a JSON object" };
  }
  const version = parsed.value.v;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    return { ok: false, kind: "corrupt", reason: "`v` is not a positive integer" };
  }
  if (version > PERSISTED_THREAD_JOURNAL_VERSION) return { ok: false, kind: "newer", version };
  const result = LineSchema.safeParse(parsed.value);
  if (!result.success) {
    return { ok: false, kind: "corrupt", reason: describeZodError(result.error) };
  }
  const issues: PersistedIssue[] = [];
  const data = result.data;
  if (data.type === "thread.imported") {
    const thread = readPersistedThreadObject(data.thread, issues);
    if (thread instanceof PersistedCorruption) {
      return { ok: false, kind: "corrupt", reason: `thread: ${thread.reason}` };
    }
    return { ok: true, event: { ...data, thread }, issues };
  }
  if (data.type === "sources") {
    const sources = salvageList(data.sources, PersistedCitedSourceSchema, "sources", issues);
    return { ok: true, event: { ...data, sources }, issues };
  }
  return { ok: true, event: data, issues };
}

/** Canonical order: `(epoch, seq, id)`. Every device folds a journal in this order. */
export function comparePersistedJournalEvents(
  a: Pick<PersistedJournalEvent, "epoch" | "seq" | "id">,
  b: Pick<PersistedJournalEvent, "epoch" | "seq" | "id">,
): number {
  return a.epoch - b.epoch || a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface PersistedJournalRead {
  /** Valid events, each id once (its first occurrence), in canonical order. */
  events: PersistedJournalEvent[];
  /** Skipped lines and dropped entries (`line 3`, `line 7 sources[0]`); never content. */
  issues: PersistedIssue[];
  /** Set when a line was written by a newer app (its `v`): the journal must be left alone. */
  newer: number | null;
  /** False when the last line was cut off (a crash mid-append): the next append starts a line. */
  endsWithNewline: boolean;
  /** Highest `seq` of any valid event (0 for none). */
  maxSeq: number;
}

/**
 * Decodes a journal. With `threadId`, thread events (`thread.created`, `thread.imported`) of
 * another thread are skipped as invalid. A leading byte order mark and CRLF line ends are accepted.
 */
export function decodePersistedThreadJournal(
  text: string,
  threadId?: string,
): PersistedJournalRead {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const read: PersistedJournalRead = {
    events: [],
    issues: [],
    newer: null,
    endsWithNewline: body.length === 0 || body.endsWith("\n"),
    maxSeq: 0,
  };
  const seen = new Set<string>();
  let sorted = true;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    const where = `line ${i + 1}`;
    const decoded = decodePersistedJournalLine(line);
    if (!decoded.ok) {
      if (decoded.kind === "newer") read.newer = Math.max(read.newer ?? 0, decoded.version);
      else read.issues.push({ path: where, message: decoded.reason });
      continue;
    }
    const { event } = decoded;
    for (const issue of decoded.issues) {
      read.issues.push({ path: `${where} ${issue.path}`, message: issue.message });
    }
    if (
      threadId !== undefined &&
      (event.type === "thread.created" || event.type === "thread.imported") &&
      event.thread.id !== threadId
    ) {
      read.issues.push({ path: where, message: "belongs to another thread" });
      continue;
    }
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const previous = read.events.at(-1);
    if (previous && comparePersistedJournalEvents(previous, event) > 0) sorted = false;
    read.events.push(event);
    read.maxSeq = Math.max(read.maxSeq, event.seq);
  }
  if (!sorted) read.events.sort(comparePersistedJournalEvents);
  return read;
}

/** One line, envelope first, `\n`-terminated. */
export function encodePersistedJournalEvent(event: PersistedJournalEvent): string {
  const { v, id, epoch, seq, at, type, ...payload } = event;
  return `${JSON.stringify({ v, id, epoch, seq, at, type, ...payload })}\n`;
}

/**
 * The `thread.imported` event that brings `thread` into a journal right after the event at
 * `(epoch, seq)`. Its id comes from the thread's content, so two devices importing the same
 * snapshot write the same event, which the union merge keeps once.
 */
export function persistedThreadImportEvent(
  thread: PersistedThread,
  after: { epoch: number; seq: number } = { epoch: 0, seq: 0 },
): PersistedJournalEvent {
  const key = `${thread.id}\n${sortedJson(thread)}`;
  return {
    v: PERSISTED_THREAD_JOURNAL_VERSION,
    id: `evt_${hashString(key)}${hashString(key, 1)}`,
    epoch: after.epoch,
    seq: after.seq + 1,
    at: thread.updatedAt,
    type: "thread.imported",
    thread,
  };
}

/** JSON with every object's keys sorted: equal values give equal text, whatever their key order. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isPersistedObject(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => compareStrings(a, b)))
      : v,
  );
}
