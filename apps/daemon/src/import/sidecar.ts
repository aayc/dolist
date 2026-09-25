/**
 * Carries the agent sidecar (`.daily-do-list/`) into the new vault, remapped to where the notes
 * went (`carry-over.ts`):
 *
 * - Tracker state (task identities) of every moved or merged daily note is rebuilt at its new
 *   path with core's task parser and tracker, so each task keeps its id (and its thread and
 *   badge). Obsidian's own tasks in a merged note count as existing tasks: settled unless
 *   `actOnExistingTasks` is on, exactly as when the agent first sees a note.
 * - Task records get the new note path and line; threads the new note path and routine id. A
 *   thread whose task can't be found in its moved note is kept and marked detached (a system
 *   message says so).
 * - Routines state follows renamed routines; approvals, artifacts and anything unknown are copied
 *   byte for byte, as is every file that needs no change. The sync engine's snapshots and an
 *   earlier import's manifest belong to the old vault and stay behind; `settings.json` is merged
 *   by `settings-merge.ts`.
 *
 * With no sink it only counts, which is how the preview reports the same numbers the import uses.
 */
import { join } from "node:path";
import {
  decodePersistedRecords,
  decodePersistedRoutines,
  decodePersistedTaskState,
  decodePersistedThread,
  encodePersistedRecords,
  encodePersistedRoutines,
  encodePersistedTaskState,
  encodePersistedThread,
  type PersistedSettledTask,
  type PersistedTaskAgentRecord,
  type PersistedThread,
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
 * Hook for the agent journal (`journal/`, docs/specs/agent-journal.md), whose events will carry
 * note paths too. Its phase 1 still writes every thread's snapshot (`threads/<id>.json`), which
 * readers use and this import remaps, so journal files are copied as they are (null). Once readers
 * fold the journal, remap the paths and routine ids in its events here, with `remap`.
 */
export function remapJournalFile(
  _path: string,
  _text: string,
  _remap: SidecarRemap,
): string | null {
  return null;
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
  const files = new Map<Category, Array<{ path: string; absolute: string }>>();
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

  for (const file of files.get("thread") ?? []) {
    input.signal?.throwIfAborted();
    counts.threads++;
    const text = await readText(file.absolute);
    const decoded = text === null ? null : decodePersistedThread(text);
    if (!decoded?.ok) {
      await sink?.copy(file.path, file.absolute);
      continue;
    }
    const thread = decoded.value;
    const next: PersistedThread = {
      ...thread,
      notePath: thread.notePath === null ? null : remap.notePath(thread.notePath),
      ...(thread.routineId ? { routineId: remap.routineId(thread.routineId) } : {}),
    };
    const move = thread.notePath === null ? undefined : input.carry.byFrom.get(thread.notePath);
    if (thread.taskId && move?.daily && notes.changes(move)) {
      if (!(await notes.locates(move, thread.taskId))) {
        counts.detached++;
        next.messages = [
          ...thread.messages,
          {
            id: newId("msg"),
            kind: "text",
            role: "system",
            author: "system",
            text: DETACHED_NOTE,
            createdAt: input.now,
          },
        ];
      }
    }
    const changed =
      next.notePath !== thread.notePath ||
      next.routineId !== thread.routineId ||
      next.messages !== thread.messages;
    if (changed) await sink?.write(file.path, encodePersistedThread(next));
    else await sink?.copy(file.path, file.absolute);
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

  for (const file of files.get("journal") ?? []) {
    counts.journal++;
    const text = await readText(file.absolute);
    const remapped = text === null ? null : remapJournalFile(file.path, text, remap);
    if (remapped === null) await sink?.copy(file.path, file.absolute);
    else await sink?.write(file.path, remapped);
  }

  for (const file of files.get("copy") ?? []) {
    input.signal?.throwIfAborted();
    if (file.path === "state/approvals.json") counts.approvals += await countApprovals(file);
    await sink?.copy(file.path, file.absolute);
  }
  return counts;
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
  if (path.startsWith("journal/")) return "journal";
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
