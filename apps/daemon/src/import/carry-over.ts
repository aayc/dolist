/**
 * The current vault's side of an import: where each of its files lands in the new vault.
 *
 * - Daily notes move to the new vault's daily-note folder and format (Obsidian's, when this app
 *   can read them). For a date Obsidian also has, the Obsidian note is kept and this vault's note
 *   is appended under `## From Daily Do List`, so nothing is dropped.
 * - Every other file (routines, drawings, attachments, `.trash/`) keeps its path. One that
 *   collides with an Obsidian file (compared like macOS does: case- and normalization-insensitive)
 *   becomes `Name (Daily Do List).md`; files that don't collide keep their names first.
 * - Hidden files and folders other than the sidecar and `.trash/` stay behind, as do links that
 *   lead outside the vault. The sidecar is carried by `sidecar.ts`.
 */
import { basename } from "node:path";
import {
  type AppSettings,
  addDays,
  type CarryOverPlan,
  compareLocalDates,
  type DailyNoteSettings,
  type DailyNotesSource,
  DEFAULT_DAILY_NOTE_CONTENT,
  dailyNotePath,
  type ImportMove,
  isClosedStatus,
  isHiddenPath,
  isRoutinePath,
  isWithinWindow,
  type LocalDate,
  parseDailyNotePath,
  parseTasks,
  routineIdForPath,
  SIDECAR_DIR,
  today,
  toISODate,
} from "@ddl/core";
import { TRASH_DIR } from "../vault-ops";
import { readRegularFile } from "./files";
import type { ObsidianConfig } from "./obsidian-config";
import { freeName, pathKey } from "./places";
import { BoundedList, moveList, pathList } from "./report-lists";
import { DRAWING_SUFFIX, type SourceScan } from "./source-scan";
import { walkVault } from "./walk";

export const MERGE_HEADING = "## From Daily Do List";
export const COLLISION_LABEL = "Daily Do List";
/** Daily notes bigger than this aren't read to count open tasks. */
const MAX_NOTE_BYTES = 4 * 1024 * 1024;
/** Limits of `settings.json` (`PersistedSettingsOverridesSchema`). */
const DAILY_LIMITS = { folder: 512, format: 128, template: 512 };
const ROUND_TRIP_DATES: readonly LocalDate[] = [
  { year: 2026, month: 1, day: 5 },
  { year: 2026, month: 9, day: 25 },
  { year: 2027, month: 12, day: 31 },
];

export interface DailyMove {
  from: string;
  to: string;
  /** YYYY-MM-DD. */
  date: string;
  merged: boolean;
}

export interface FileMove {
  from: string;
  to: string;
  /** Where to read it in the current vault. */
  absolute: string;
  size: number;
  daily?: DailyMove;
}

export interface CarryOver {
  /** Agent counts and `watchedOpenTasks` are filled in by the caller. */
  plan: CarryOverPlan;
  moves: FileMove[];
  byFrom: Map<string, FileMove>;
  /** Daily notes appended to each Obsidian note, in order, by the Obsidian note's path. */
  merges: Map<string, FileMove[]>;
  /** Old → new routine id, for routines renamed on a collision. */
  routineIds: Map<string, string>;
  bytes: number;
  warnings: string[];
}

export interface CarryOverInput {
  /** The current vault's real path (null: no vault to carry over). */
  vault: string | null;
  settings: AppSettings;
  obsidian: ObsidianConfig;
  source: SourceScan;
  signal?: AbortSignal;
}

export async function planCarryOver(input: CarryOverInput): Promise<CarryOver> {
  const { files, leftBehind } = input.vault
    ? await listCurrentVault(input.vault, input.signal)
    : { files: [], leftBehind: new BoundedList<string>() };
  const ddlDaily = input.settings.dailyNotes;
  const dated = files
    .map((file) => ({
      file,
      date: isInTrash(file.path) ? null : parseDailyNotePath(file.path, ddlDaily),
    }))
    .filter((entry): entry is { file: CurrentFile; date: LocalDate } => entry.date !== null)
    .sort((a, b) => compareLocalDates(a.date, b.date) || compare(a.file.path, b.file.path));
  const choice = chooseDailyNotes(
    input.obsidian,
    ddlDaily,
    dated.map((entry) => entry.date),
  );

  const moves: FileMove[] = [];
  const assigned = new Set<string>();
  const taken = (key: string) => input.source.byKey.has(key) || assigned.has(key);
  const colliding: Array<{ file: CurrentFile; to: string; date?: string }> = [];
  const merges = new Map<string, FileMove[]>();
  const dailyPaths = new Set<string>();

  for (const { file, date } of dated) {
    dailyPaths.add(file.path);
    const iso = toISODate(date);
    const to = dailyNotePath(date, choice.settings);
    const key = pathKey(to);
    const obsidianNote = input.source.byKey.get(key);
    if (obsidianNote !== undefined) {
      const move = fileMove(file, obsidianNote, { date: iso, merged: true });
      moves.push(move);
      merges.set(obsidianNote, [...(merges.get(obsidianNote) ?? []), move]);
    } else if (assigned.has(key)) {
      colliding.push({ file, to, date: iso });
    } else {
      assigned.add(key);
      moves.push(fileMove(file, to, { date: iso, merged: false }));
    }
  }
  for (const file of files) {
    if (dailyPaths.has(file.path)) continue;
    const key = pathKey(file.path);
    if (taken(key)) {
      colliding.push({ file, to: file.path });
    } else {
      assigned.add(key);
      moves.push(fileMove(file, file.path));
    }
  }
  const collisions = new BoundedList<ImportMove>();
  for (const { file, to, date } of colliding) {
    const renamed = freeName(to, COLLISION_LABEL, taken);
    assigned.add(pathKey(renamed));
    moves.push(fileMove(file, renamed, date ? { date, merged: false } : undefined));
    collisions.add({ from: file.path, to: renamed });
  }
  moves.sort((a, b) => compare(a.from, b.from));

  const notes = new BoundedList<ImportMove>();
  const daily = new BoundedList<CarryOverPlan["daily"]["items"][number]>();
  const routineIds = new Map<string, string>();
  let merged = 0;
  let routines = 0;
  let drawings = 0;
  let bytes = 0;
  for (const move of moves) {
    bytes += move.size;
    if (move.daily) {
      daily.add({ ...move.daily });
      if (move.daily.merged) merged++;
    } else {
      notes.add({ from: move.from, to: move.to });
    }
    if (isRoutinePath(move.from)) {
      routines++;
      if (move.to !== move.from && isRoutinePath(move.to)) {
        routineIds.set(routineIdForPath(move.from), routineIdForPath(move.to));
      }
    }
    if (move.from.toLowerCase().endsWith(DRAWING_SUFFIX)) drawings++;
  }

  return {
    plan: {
      vault: input.vault ?? "",
      dailyNotes: choice.settings,
      dailyNotesFrom: choice.from,
      notes: moveList(notes),
      daily: { count: daily.count, merged, items: [...daily.items] },
      collisions: moveList(collisions),
      routines,
      drawings,
      agent: {
        threads: 0,
        detached: 0,
        records: 0,
        approvals: 0,
        routines: 0,
        trackedNotes: 0,
        journal: 0,
      },
      watchedOpenTasks: 0,
      actOnExistingTasks: input.settings.agent.actOnExistingTasks,
      leftBehind: pathList(leftBehind),
    },
    moves,
    byFrom: new Map(moves.map((move) => [move.from, move])),
    merges,
    routineIds,
    bytes,
    warnings: choice.warning ? [choice.warning] : [],
  };
}

/**
 * The text of a carried daily note in the new vault, and the line its own content starts at
 * there (0 unless it was appended to an Obsidian note).
 */
export async function carriedDailyText(
  carry: CarryOver,
  move: FileMove,
  readObsidian: (path: string) => Promise<string | null>,
): Promise<{ text: string; offset: number }> {
  const own = await readText(move.absolute);
  if (!move.daily?.merged) return { text: own, offset: 0 };
  const group = carry.merges.get(move.to) ?? [move];
  let text = (await readObsidian(move.to)) ?? "";
  let offset = 0;
  for (const member of group) {
    const addition = member === move ? own : await readText(member.absolute);
    const next = appendSection(text, addition);
    if (member === move) offset = next.offset;
    text = next.text;
  }
  return { text, offset };
}

/**
 * `base` with `addition` appended under `MERGE_HEADING`, and the line `addition` starts at. A
 * code block left open at the end of `base` is closed first, so the addition stays markdown (and
 * its tasks stay tasks). A blank or untouched daily note adds nothing.
 */
export function appendSection(base: string, addition: string): { text: string; offset: number } {
  const body = addition.charCodeAt(0) === 0xfeff ? addition.slice(1) : addition;
  if (isBlankDailyNote(body)) return { text: base, offset: lineCount(base) };
  let text = base;
  if (text.length > 0 && !text.endsWith("\n")) text += "\n";
  const fence = openFence(text);
  if (fence) text += `${fence}\n`;
  if (text.trim().length > 0) text += "\n";
  text += `${MERGE_HEADING}\n\n`;
  return { text: text + body, offset: lineCount(text) };
}

/** Open tasks of Obsidian's daily notes inside the agent's watch window (see `CarryOverPlan`). */
export async function countWatchedOpenTasks(
  sourceRoot: string,
  source: SourceScan,
  dailyNotes: DailyNoteSettings,
  settings: AppSettings,
  now: Date,
): Promise<number> {
  const { pastDays, futureDays } = settings.agent.watch;
  const from = today(now);
  let open = 0;
  for (let offset = -pastDays; offset <= futureDays; offset++) {
    const date = addDays(from, offset);
    if (!isWithinWindow(date, from, pastDays, futureDays)) continue;
    const path = source.byKey.get(pathKey(dailyNotePath(date, dailyNotes)));
    if (path === undefined) continue;
    const bytes = await readRegularFile(`${sourceRoot}/${path}`, MAX_NOTE_BYTES);
    if (!bytes) continue;
    for (const task of parseTasks(bytes.toString("utf8"))) {
      if (!isClosedStatus(task.status) && task.text.trim() !== "" && !task.agent) open++;
    }
  }
  return open;
}

interface CurrentFile {
  path: string;
  absolute: string;
  size: number;
}

async function listCurrentVault(
  root: string,
  signal?: AbortSignal,
): Promise<{ files: CurrentFile[]; leftBehind: BoundedList<string> }> {
  const files: CurrentFile[] = [];
  const leftBehind = new BoundedList<string>();
  const walk = walkVault(root, {
    ...(signal ? { signal } : {}),
    prune: (path) => {
      if (path === SIDECAR_DIR) return true;
      if (path === TRASH_DIR || !basename(path).startsWith(".")) return false;
      leftBehind.add(path);
      return true;
    },
  });
  for await (const entry of walk) {
    if (entry.kind === "folder") continue;
    if (entry.kind === "skipped") {
      leftBehind.add(entry.path);
      continue;
    }
    const name = basename(entry.path);
    if (name === ".DS_Store") continue;
    if (name.startsWith(".")) {
      leftBehind.add(entry.path);
      continue;
    }
    files.push({ path: entry.path, absolute: entry.absolute, size: entry.size });
  }
  return { files, leftBehind };
}

function chooseDailyNotes(
  obsidian: ObsidianConfig,
  current: DailyNoteSettings,
  dates: readonly LocalDate[],
): { settings: DailyNoteSettings; from: DailyNotesSource; warning?: string } {
  const candidate = obsidian.settings.dailyNotes;
  if (!candidate) return { settings: current, from: "daily_do_list" };
  if (!usableDailyNotes(candidate, dates)) {
    return {
      settings: current,
      from: "daily_do_list",
      warning: `Obsidian's daily-note format "${candidate.format}" can't be read here, so daily notes keep Daily Do List's folder and format.`,
    };
  }
  return {
    settings: candidate,
    from: obsidian.dailyNotesFrom === "file" ? "obsidian" : "obsidian_defaults",
  };
}

/** Within the settings limits, and every date's note path reads back as that date. */
function usableDailyNotes(settings: DailyNoteSettings, dates: readonly LocalDate[]): boolean {
  if (
    settings.folder.length > DAILY_LIMITS.folder ||
    settings.format.length === 0 ||
    settings.format.length > DAILY_LIMITS.format ||
    settings.template.length > DAILY_LIMITS.template
  ) {
    return false;
  }
  try {
    return [...ROUND_TRIP_DATES, ...dates].every((date) => {
      const path = dailyNotePath(date, settings);
      const parsed = parseDailyNotePath(path, settings);
      return !isHiddenPath(path) && parsed !== null && compareLocalDates(parsed, date) === 0;
    });
  } catch {
    return false;
  }
}

function fileMove(
  file: CurrentFile,
  to: string,
  daily?: { date: string; merged: boolean },
): FileMove {
  return {
    from: file.path,
    to,
    absolute: file.absolute,
    size: file.size,
    ...(daily ? { daily: { from: file.path, to, ...daily } } : {}),
  };
}

function isInTrash(path: string): boolean {
  return path.startsWith(`${TRASH_DIR}/`);
}

function isBlankDailyNote(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || trimmed === DEFAULT_DAILY_NOTE_CONTENT.trim();
}

const FENCE_OPEN_RE = /^[ \t]*(?:(`{3,})[^`\n]*|(~{3,})[^\n]*)$/;
const FENCE_CLOSE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

/** The fence that closes a code block still open at the end of `text`, or null. */
function openFence(text: string): string | null {
  let fence: string | null = null;
  const lines = text.split("\n");
  let start = 0;
  if (/^---\s*$/.test(lines[0] ?? "")) {
    const end = lines.findIndex((line, i) => i > 0 && i < 200 && /^(?:---|\.\.\.)\s*$/.test(line));
    if (end > 0) start = end + 1;
  }
  for (const rawLine of lines.slice(start)) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) fence = (open[1] ?? open[2])!;
  }
  return fence;
}

function lineCount(text: string): number {
  let count = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count++;
  return count;
}

async function readText(absolute: string): Promise<string> {
  const bytes = await readRegularFile(absolute, Number.MAX_SAFE_INTEGER);
  return bytes ? bytes.toString("utf8") : "";
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
