/**
 * Carries the agent sidecar (`.daily-do-list/`) into the new vault, remapped to where the notes
 * went (`carry-over.ts`):
 *
 * - Tracker state (task identities) of every moved or merged daily note is rebuilt at its new
 *   path with core's task parser and tracker, so each task keeps its id (and its thread and
 *   badge). Obsidian's own tasks in a merged note count as existing tasks: settled unless
 *   `actOnExistingTasks` is on, exactly as when the agent first sees a note.
 * - Task records get the new note path and line. Threads arrive as journals with the new note path
 *   and routine id: the snapshots an older app wrote are migrated in on the way, exactly as the
 *   thread store would at its next start. A thread whose task can't be found in its moved note is
 *   kept and marked detached (a system message appended to its journal).
 * - Routines state follows renamed routines; approvals, artifacts and anything unknown are copied
 *   byte for byte, as is every file that needs no change. The sync engine's snapshots and an
 *   earlier import's manifest belong to the old vault and stay behind; `settings.json` is merged
 *   by `settings-merge.ts`.
 *
 * With no sink it only counts, which is how the preview reports the same numbers the import uses.
 */
import { join } from "node:path";
import { foldJournal, planSnapshotImports, readSnapshots } from "@ddl/agent";
import {
  decodePersistedJournalLine,
  decodePersistedRecords,
  decodePersistedRoutines,
  decodePersistedTaskState,
  decodePersistedThreadJournal,
  encodePersistedJournalEvent,
  encodePersistedRecords,
  encodePersistedRoutines,
  encodePersistedTaskState,
  type PersistedJournalEvent,
  type PersistedSettledTask,
  type PersistedTaskAgentRecord,
  persistedThreadIdFromJournalPath,
} from "@ddl/contract";
import {
  type CarryOverAgent,
  createId,
  hashString,
  isBlankTaskText,
  normalizeText,
  type ParsedTask,
  parseTasks,
  SIDECAR_DIR,
  type TrackedTask,
  trackTasks,
} from "@ddl/core";
import { type CarryOver, carriedDailyText, type FileMove } from "./carry-over";
import { readRegularFile } from "./files";
import { walkVault } from "./walk";

export interface SidecarSink {
  /** Writes a generated file at a sidecar-relative path. */
  write(path: string, text: string): Promise<void>;
  /** Copies a current-vault file byte for byte to a sidecar-relative path. */
  copy(path: string, absolute: string): Promise<void>;
}

export interface SidecarInput {
  /** The current vault's real path (null: none). */
  vault: string | null;
  carry: CarryOver;
  readObsidian(path: string): Promise<string | null>;
  actOnExistingTasks: boolean;
  now: number;
  signal?: AbortSignal;
  idFactory?: (prefix: string) => string;
}

/** Maps the old vault's references to the new vault's (used by the journal hook). */
export interface SidecarRemap {
  notePath(path: string): string;
  routineId(id: string): string;
}

export const DETACHED_NOTE =
  "Moved to a new vault: this task wasn't found in its daily note there, so the thread stays on its own.";

const MAX_STATE_BYTES = 64 * 1024 * 1024;

interface SidecarFile {
  /** Sidecar-relative. */
  path: string;
  absolute: string;
}

type Category =
  | "thread"
  | "tracker"
  | "records"
  | "routines"
  | "journal"
  | "settings"
  | "stays"
  | "copy";

/**
 * The agent journal (`state/journal/`, docs/specs/agent-journal.md) with the new vault's
 * references, or null to copy it as it is: a thread journal's thread events (`thread.created`,
 * `thread.imported`) get the new note path and routine id. Every other line stays byte for byte,
 * and a journal a newer app wrote is left alone.
 */
export function remapJournalFile(path: string, text: string, remap: SidecarRemap): string | null {
  const threadId = persistedThreadIdFromJournalPath(`${SIDECAR_DIR}/${path}`);
  if (threadId === null) return null;
  const bom = text.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const lines = text.slice(bom.length).split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const cr = raw.endsWith("\r") ? "\r" : "";
    const line = cr ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    const decoded = decodePersistedJournalLine(line);
    if (!decoded.ok) {
      if (decoded.kind === "newer") return null;
      continue;
    }
    const { type } = decoded.event;
    if (type !== "thread.created" && type !== "thread.imported") continue;
    const event = JSON.parse(line) as { thread: Record<string, unknown> };
    const { notePath, routineId } = event.thread;
    const next = {
      ...event.thread,
      ...(typeof notePath === "string" ? { notePath: remap.notePath(notePath) } : {}),
      ...(typeof routineId === "string" ? { routineId: remap.routineId(routineId) } : {}),
    };
    if (next.notePath === notePath && next.routineId === routineId) continue;
    event.thread = next;
    lines[i] = `${JSON.stringify(event)}${cr}`;
    changed = true;
  }
  return changed ? bom + lines.join("\n") : null;
}

export async function carrySidecar(
  input: SidecarInput,
  sink: SidecarSink | null,
): Promise<CarryOverAgent> {
  const counts: CarryOverAgent = {
    threads: 0,
    detached: 0,
    records: 0,
    approvals: 0,
    routines: 0,
    trackedNotes: 0,
    journal: 0,
  };
  if (!input.vault) return counts;
  const root = join(input.vault, SIDECAR_DIR);
  const files = new Map<Category, SidecarFile[]>();
  try {
    for await (const entry of walkVault(root, input.signal ? { signal: input.signal } : {})) {
      if (entry.kind !== "file") continue;
      const category = categorize(entry.path);
      files.set(category, [...(files.get(category) ?? []), entry]);
    }
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return counts;
  }
  const newId = input.idFactory ?? ((prefix: string) => createId(prefix));
  const notes = new NoteRemaps(input);
  const remap: SidecarRemap = {
    notePath: (path) => input.carry.byFrom.get(path)?.to ?? path,
    routineId: (id) => input.carry.routineIds.get(id) ?? id,
  };

  const trackerOf = new Map<string, FileMove>();
  for (const move of input.carry.moves) {
    if (move.daily) trackerOf.set(trackerPath(move.from), move);
  }
  for (const file of files.get("tracker") ?? []) {
    input.signal?.throwIfAborted();
    const text = await readText(file.absolute);
    const decoded = text === null ? null : decodePersistedTaskState(text);
    const move = decoded?.ok
      ? input.carry.byFrom.get(decoded.value.notePath)
      : trackerOf.get(file.path);
    if (!move?.daily) continue;
    counts.trackedNotes++;
    if (!notes.changes(move)) {
      await sink?.copy(trackerPath(move.to), file.absolute);
      if (decoded?.ok) notes.adopt(move, decoded.value.tasks);
      continue;
    }
    const note = await notes.get(move);
    // Unreadable state still means the note isn't new: its tasks become a baseline, as the
    // watcher does, rather than work to redo under fresh ids.
    const state = decoded?.ok ? decoded.value : { tasks: [], settled: {} };
    const previous = state.tasks.map((task) => ({ ...task, line: task.line + note.offset }));
    const { tasks } = trackTasks(previous, note.parsed, {
      now: input.now,
      idFactory: () => newId("tsk"),
    });
    const known = new Set(state.tasks.map((task) => task.id));
    const settled: Record<string, PersistedSettledTask> = {};
    const current = new Map(tasks.map((task) => [task.id, task]));
    for (const [id, snapshot] of Object.entries(state.settled)) {
      const task = current.get(id);
      settled[id] = task ? { ...snapshot, task: { ...snapshot.task, line: task.line } } : snapshot;
    }
    const baseline = !decoded?.ok || !input.actOnExistingTasks;
    for (const task of tasks) {
      if (known.has(task.id) || !baseline) continue;
      settled[task.id] = {
        task: { ...task, notes: [...task.notes] },
        announced: !isBlankTaskText(task.text) && !task.agent,
      };
    }
    note.lines = new Map(tasks.map((task) => [task.id, task.line]));
    await sink?.write(
      trackerPath(move.to),
      encodePersistedTaskState({ notePath: move.to, contentVersion: null, tasks, settled }),
    );
  }

  for (const file of files.get("records") ?? []) {
    const text = await readText(file.absolute);
    const decoded = text === null ? null : decodePersistedRecords(text);
    if (!decoded?.ok) {
      await sink?.copy(file.path, file.absolute);
      continue;
    }
    counts.records += decoded.value.records.length;
    let changed = false;
    const records: PersistedTaskAgentRecord[] = [];
    for (const record of decoded.value.records) {
      const next = await notes.remapRecord(record);
      if (next !== record) changed = true;
      records.push(next);
    }
    if (changed) {
      await sink?.write(file.path, encodePersistedRecords({ ...decoded.value, records }));
    } else {
      await sink?.copy(file.path, file.absolute);
    }
  }

  for (const file of files.get("routines") ?? []) {
    const text = await readText(file.absolute);
    const decoded = text === null ? null : decodePersistedRoutines(text);
    if (!decoded?.ok) {
      await sink?.copy(file.path, file.absolute);
      continue;
    }
    counts.routines += Object.keys(decoded.value.routines).length;
    let changed = false;
    const routines: typeof decoded.value.routines = {};
    for (const [id, state] of Object.entries(decoded.value.routines)) {
      const nextId = remap.routineId(id);
      const path = remap.notePath(state.path);
      if (nextId !== id || path !== state.path) changed = true;
      routines[nextId] = path === state.path ? state : { ...state, path };
    }
    if (changed) await sink?.write(file.path, encodePersistedRoutines({ routines }));
    else await sink?.copy(file.path, file.absolute);
  }

  const journals = new Map<string, SidecarFile>();
  for (const file of files.get("journal") ?? []) {
    const id = persistedThreadIdFromJournalPath(`${SIDECAR_DIR}/${file.path}`);
    if (id) {
      journals.set(id, file);
      continue;
    }
    counts.journal++;
    await sink?.copy(file.path, file.absolute);
  }
  const snapshotFiles: Array<SidecarFile & { text: string }> = [];
  for (const file of files.get("thread") ?? []) {
    const text = await readText(file.absolute);
    if (text === null) await sink?.copy(file.path, file.absolute);
    else snapshotFiles.push({ ...file, text });
  }
  const snapshots = readSnapshots(snapshotFiles);
  for (const { file } of snapshots.skipped) await sink?.copy(file.path, file.absolute);
  for (const id of new Set([...snapshots.threads.keys(), ...journals.keys()])) {
    input.signal?.throwIfAborted();
    counts.threads++;
    counts.journal++;
    const own = snapshots.threads.get(id) ?? [];
    const journal = journals.get(id);
    const path = journal?.path ?? `state/journal/threads/${id}.jsonl`;
    const original = journal ? await readText(journal.absolute) : "";
    const read = decodePersistedThreadJournal(original ?? "", id);
    if (original === null || read.newer !== null || (!journal && snapshots.newer.has(id))) {
      // Left as it is, like the thread store leaves it.
      if (journal) await sink?.copy(journal.path, journal.absolute);
      for (const { file } of own) await sink?.copy(file.path, file.absolute);
      continue;
    }
    const planned = planSnapshotImports(
      id,
      read.events,
      own.map((snapshot) => snapshot.thread),
    );
    const merged = appendEvents(original, read.endsWithNewline, planned);
    const before = decodePersistedThreadJournal(merged, id);
    const thread = foldJournal(before.events, id).thread;
    let text = remapJournalFile(path, merged, remap) ?? merged;
    const move = thread?.notePath ? input.carry.byFrom.get(thread.notePath) : undefined;
    if (thread?.taskId && move?.daily && notes.changes(move)) {
      if (!(await notes.locates(move, thread.taskId))) {
        counts.detached++;
        text = appendEvents(text, before.endsWithNewline, [
          {
            v: 1,
            id: newId("evt"),
            epoch: before.events.at(-1)?.epoch ?? 0,
            seq: before.maxSeq + 1,
            at: input.now,
            type: "message",
            message: {
              id: newId("msg"),
              kind: "text",
              role: "system",
              author: "system",
              text: DETACHED_NOTE,
              createdAt: input.now,
            },
          },
        ]);
      }
    }
    if (journal && text === original) await sink?.copy(path, journal.absolute);
    else await sink?.write(path, text);
  }

  for (const file of files.get("copy") ?? []) {
    input.signal?.throwIfAborted();
    if (file.path === "state/approvals.json") counts.approvals += await countApprovals(file);
    await sink?.copy(file.path, file.absolute);
  }
  return counts;
}

/** `text` with `events` appended, starting a line if its last one was cut off. */
function appendEvents(
  text: string,
  endsWithNewline: boolean,
  events: readonly PersistedJournalEvent[],
): string {
  if (events.length === 0) return text;
  return (endsWithNewline ? text : `${text}\n`) + events.map(encodePersistedJournalEvent).join("");
}

/** Sidecar-relative path of a note's tracker state (the watcher's `taskStatePath`). */
function trackerPath(notePath: string): string {
  return `state/tasks/${hashString(notePath)}.json`;
}

function categorize(path: string): Category {
  if (/^threads\/[^/]+\.json$/.test(path)) return "thread";
  if (/^state\/tasks\/[^/]+\.json$/.test(path)) return "tracker";
  if (path === "state/records.json") return "records";
  if (path === "state/routines.json") return "routines";
  if (path === "settings.json") return "settings";
  if (path.startsWith("state/journal/")) return "journal";
  if (path.startsWith("sync/") || path.startsWith("import/")) return "stays";
  return "copy";
}

interface NoteRemap {
  to: string;
  offset: number;
  parsed: ParsedTask[];
  /** New line of each tracked task (from its tracker state). */
  lines: Map<string, number>;
  /** Task ids located by their records. */
  located: Set<string>;
}

/** The new text and task positions of carried daily notes, computed once per note. */
class NoteRemaps {
  readonly #input: SidecarInput;
  readonly #notes = new Map<string, Promise<NoteRemap>>();
  readonly #adopted = new Map<string, Set<string>>();

  constructor(input: SidecarInput) {
    this.#input = input;
  }

  /** The note's path or content changes in the new vault. */
  changes(move: FileMove): boolean {
    return move.to !== move.from || move.daily?.merged === true;
  }

  /** A note carried unchanged: its tracked tasks keep their lines. */
  adopt(move: FileMove, tasks: readonly TrackedTask[]): void {
    this.#adopted.set(move.from, new Set(tasks.map((task) => task.id)));
  }

  get(move: FileMove): Promise<NoteRemap> {
    let note = this.#notes.get(move.from);
    if (!note) {
      note = carriedDailyText(this.#input.carry, move, this.#input.readObsidian).then(
        ({ text, offset }) => ({
          to: move.to,
          offset,
          parsed: parseTasks(text),
          lines: new Map(),
          located: new Set(),
        }),
      );
      this.#notes.set(move.from, note);
    }
    return note;
  }

  async locates(move: FileMove, taskId: string): Promise<boolean> {
    if (this.#adopted.get(move.from)?.has(taskId)) return true;
    const note = await this.get(move);
    return note.lines.has(taskId) || note.located.has(taskId);
  }

  async remapRecord(record: PersistedTaskAgentRecord): Promise<PersistedTaskAgentRecord> {
    const move = this.#input.carry.byFrom.get(record.notePath);
    if (!move) return record;
    if (!move.daily || !this.changes(move)) {
      return move.to === record.notePath ? record : { ...record, notePath: move.to };
    }
    const note = await this.get(move);
    let line = note.lines.get(record.taskId);
    if (line === undefined && record.anchor === "line") line = record.line + note.offset;
    if (line === undefined) line = closestTask(note.parsed, record.text, record.line + note.offset);
    if (line === undefined)
      return { ...record, notePath: move.to, line: record.line + note.offset };
    note.located.add(record.taskId);
    return { ...record, notePath: move.to, line };
  }
}

/** Line of the task with the same text nearest to `expected`. */
function closestTask(
  parsed: readonly ParsedTask[],
  text: string,
  expected: number,
): number | undefined {
  const wanted = normalizeText(text);
  let best: number | undefined;
  for (const task of parsed) {
    if (normalizeText(task.text) !== wanted) continue;
    if (best === undefined || Math.abs(task.line - expected) < Math.abs(best - expected)) {
      best = task.line;
    }
  }
  return best;
}

async function countApprovals(file: { absolute: string }): Promise<number> {
  const text = await readText(file.absolute);
  if (text === null) return 0;
  try {
    const value: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    const approvals = (value as { approvals?: unknown }).approvals;
    return Array.isArray(approvals) ? approvals.length : 0;
  } catch {
    return 0;
  }
}

async function readText(absolute: string): Promise<string | null> {
  const bytes = await readRegularFile(absolute, MAX_STATE_BYTES);
  return bytes ? bytes.toString("utf8") : null;
}
