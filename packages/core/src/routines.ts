/**
 * Routine files: one markdown file per routine in the vault's `Routines/` folder. The frontmatter
 * holds the settings (schedule, notify, uses, paused), the body the instructions:
 *
 * ```markdown
 * ---
 * schedule: every weekday at 7:30      # natural language, local time
 * notify: when changed                 # always | when changed | never (default: always)
 * uses: [web, connectors]              # optional capability hints
 * paused: false                        # optional
 * ---
 * Brief me for the day: my calendar, the weather and what I didn't finish yesterday.
 * ```
 *
 * Plain files: editable in Obsidian, synced, versioned. Reading never throws; problems are
 * reported on the routine. The scheduler's state lives in the sidecar, never in the file.
 */
import type { RoutineNotify, RoutineTemplate, RoutineUse } from "./agent-types";
import { basename, isHiddenPath, stem } from "./paths";
import { describeSchedule, parseSchedule, type RoutineSchedule } from "./routine-schedule";
import { hashString } from "./text";

export const ROUTINES_FOLDER = "Routines";
export const ROUTINE_NOTIFY_VALUES: readonly RoutineNotify[] = ["always", "when_changed", "never"];
export const ROUTINE_USES: readonly RoutineUse[] = [
  "web",
  "browser",
  "computer",
  "shell",
  "files",
  "connectors",
];
export const ROUTINE_NAME_MAX_LENGTH = 100;
export const ROUTINE_INSTRUCTIONS_MAX_LENGTH = 8_000;

/** A routine file as read: its settings, instructions and every problem found. */
export interface RoutineFile {
  /** The schedule as written; null when the file has none. */
  schedule: string | null;
  /** Parsed; absent when missing or unreadable (see `problems`). */
  parsedSchedule?: RoutineSchedule;
  notify: RoutineNotify;
  uses: RoutineUse[];
  paused: boolean;
  instructions: string;
  /** Why it can't run, most important first. Empty for a valid routine. */
  problems: string[];
}

/** What a new routine file says (also what `create_routine` and the "New routine" sheet send). */
export interface RoutineFileInput {
  schedule: string;
  notify?: RoutineNotify;
  uses?: readonly RoutineUse[];
  paused?: boolean;
  instructions: string;
}

/** `Routines/Morning briefing.md` (a direct child of the folder, not hidden). */
export function isRoutinePath(path: string): boolean {
  const prefix = `${ROUTINES_FOLDER}/`;
  if (!path.startsWith(prefix) || !path.toLowerCase().endsWith(".md")) return false;
  const rest = path.slice(prefix.length);
  return !rest.includes("/") && rest.length > 3 && !isHiddenPath(path);
}

export function routinePathForName(name: string): string {
  return `${ROUTINES_FOLDER}/${name}.md`;
}

export function routineNameFromPath(path: string): string {
  return stem(basename(path));
}

/** Stable, URL-safe id of the routine at `path` (the same on every device). */
export function routineIdForPath(path: string): string {
  return `rtn_${hashString(path)}`;
}

const NAME_FORBIDDEN = /[\\/:*?"<>|#^[\]]/;

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Why `name` can't be a routine's file name, or null when it can. */
export function routineNameProblem(name: string): string | null {
  if (name.trim() !== name || name.length === 0) return "Give the routine a name.";
  if (name.length > ROUTINE_NAME_MAX_LENGTH) {
    return `Keep the name under ${ROUTINE_NAME_MAX_LENGTH} characters.`;
  }
  if (name.startsWith(".")) return "A routine's name can't start with a dot.";
  if (NAME_FORBIDDEN.test(name) || hasControlCharacter(name)) {
    return "A routine's name can't contain \\ / : * ? \" < > | # ^ [ or ].";
  }
  return null;
}

// ── Frontmatter ──────────────────────────────────────────────────────────────

const OPEN_RE = /^---\s*$/;
const CLOSE_RE = /^(?:---|\.\.\.)\s*$/;
const KEY_RE = /^([A-Za-z_][\w-]*)\s*:(.*)$/;
const MAX_FRONTMATTER_LINES = 200;

interface Frontmatter {
  /** Index of the closing line; -1 without frontmatter. */
  end: number;
  /** Raw values by lowercased key: a string, a list, or null for an empty value. */
  values: Map<string, string | string[] | null>;
  problems: string[];
}

function splitLines(content: string): string[] {
  return content.replace(/^\uFEFF/, "").split(/\r?\n/);
}

function frontmatterEnd(lines: readonly string[]): number {
  if (!OPEN_RE.test(lines[0] ?? "")) return -1;
  const limit = Math.min(lines.length, MAX_FRONTMATTER_LINES);
  for (let i = 1; i < limit; i++) if (CLOSE_RE.test(lines[i]!)) return i;
  return -1;
}

/** A scalar without its quotes, or without a trailing ` # comment` when unquoted. */
function scalar(raw: string): string {
  const value = raw.trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(value);
  if (quoted) return quoted[1]!.replace(/\\(["\\])/g, "$1");
  const single = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(value);
  if (single) return single[1]!.replace(/''/g, "'");
  return value.replace(/(?:^|\s+)#.*$/, "").trim();
}

function inlineList(raw: string): string[] | null {
  const match = /^\[(.*)\]\s*(?:#.*)?$/.exec(raw.trim());
  if (!match) return null;
  return match[1]!
    .split(",")
    .map((item) => scalar(item))
    .filter((item) => item.length > 0);
}

function readFrontmatter(lines: readonly string[]): Frontmatter {
  const end = frontmatterEnd(lines);
  const values = new Map<string, string | string[] | null>();
  const problems: string[] = [];
  if (end === -1) return { end, values, problems };
  let listKey: string | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const current = values.get(listKey);
      const list = Array.isArray(current) ? current : [];
      const value = scalar(item[1]!);
      if (value) list.push(value);
      values.set(listKey, list);
      continue;
    }
    const match = KEY_RE.exec(line);
    if (!match) {
      if (/^\s/.test(line)) continue;
      problems.push(`Couldn't read the frontmatter line “${line.trim().slice(0, 60)}”.`);
      listKey = null;
      continue;
    }
    const key = match[1]!.toLowerCase();
    const raw = match[2]!;
    const list = inlineList(raw);
    const value = list ?? scalar(raw);
    values.set(key, value === "" ? null : value);
    listKey = value === "" ? key : null;
  }
  return { end, values, problems };
}

function readNotify(
  value: string | string[] | null | undefined,
  problems: string[],
): RoutineNotify {
  if (value === undefined || value === null) return "always";
  const text = (Array.isArray(value) ? value.join(" ") : value).trim().toLowerCase();
  const normalized = text.replace(/[\s_-]+/g, " ");
  if (normalized === "always") return "always";
  if (normalized === "never") return "never";
  if (normalized === "when changed" || normalized === "changed" || normalized === "on change") {
    return "when_changed";
  }
  problems.push(`notify must be always, when changed or never (not “${text.slice(0, 40)}”).`);
  return "always";
}

function readUses(value: string | string[] | null | undefined, problems: string[]): RoutineUse[] {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value)
    ? value
    : value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  const uses: RoutineUse[] = [];
  for (const item of items) {
    const use = item.toLowerCase() as RoutineUse;
    if (ROUTINE_USES.includes(use)) {
      if (!uses.includes(use)) uses.push(use);
    } else {
      problems.push(
        `uses: “${item.slice(0, 40)}” isn't a capability (${ROUTINE_USES.join(", ")}).`,
      );
    }
  }
  return uses;
}

function readPaused(value: string | string[] | null | undefined, problems: string[]): boolean {
  if (value === undefined || value === null) return false;
  const text = (Array.isArray(value) ? value.join(" ") : value).trim().toLowerCase();
  if (text === "true" || text === "yes" || text === "on") return true;
  if (text === "false" || text === "no" || text === "off") return false;
  problems.push(`paused must be true or false (not “${text.slice(0, 40)}”).`);
  return false;
}

/** Reads a routine file. Never throws: whatever is wrong ends up in `problems`. */
export function parseRoutineFile(content: string): RoutineFile {
  const lines = splitLines(content);
  const frontmatter = readFrontmatter(lines);
  const problems: string[] = [];
  const settings: string[] = [...frontmatter.problems];
  const scheduleValue = frontmatter.values.get("schedule");
  const schedule =
    scheduleValue === undefined || scheduleValue === null
      ? null
      : Array.isArray(scheduleValue)
        ? scheduleValue.join(", ")
        : scheduleValue;
  let parsedSchedule: RoutineSchedule | undefined;
  if (frontmatter.end === -1) {
    problems.push(
      "Add a frontmatter block with a schedule at the top, e.g. “schedule: every weekday at 7:30”.",
    );
  } else if (schedule === null) {
    problems.push("Add a schedule to the frontmatter, e.g. “schedule: every weekday at 7:30”.");
  } else {
    const parsed = parseSchedule(schedule);
    if (parsed.ok) parsedSchedule = parsed.schedule;
    else problems.push(parsed.error);
  }
  const notify = readNotify(frontmatter.values.get("notify"), settings);
  const uses = readUses(frontmatter.values.get("uses"), settings);
  const paused = readPaused(frontmatter.values.get("paused"), settings);
  const instructions = lines
    .slice(frontmatter.end + 1)
    .join("\n")
    .trim();
  problems.push(...settings);
  if (instructions === "") {
    problems.push("Write what the routine should do below the frontmatter.");
  } else if (instructions.length > ROUTINE_INSTRUCTIONS_MAX_LENGTH) {
    problems.push(
      `Keep the instructions under ${ROUTINE_INSTRUCTIONS_MAX_LENGTH.toLocaleString("en-US")} characters.`,
    );
  }
  return {
    schedule,
    ...(parsedSchedule ? { parsedSchedule } : {}),
    notify,
    uses,
    paused,
    instructions,
    problems,
  };
}

/** The schedule in words, or null when it can't be read. */
export function describeSchedulePhrase(phrase: string): string | null {
  const parsed = parseSchedule(phrase);
  return parsed.ok ? describeSchedule(parsed.schedule) : null;
}

/** `when changed` for `when_changed`: how the file spells a notify value. */
export function notifyPhrase(notify: RoutineNotify): string {
  return notify === "when_changed" ? "when changed" : notify;
}

function yamlValue(value: string): string {
  const plain =
    value.length > 0 &&
    !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/:\s|\s#|[\r\n]/.test(value) &&
    value.trim() === value;
  return plain ? value : JSON.stringify(value);
}

function frontmatterLines(input: Omit<RoutineFileInput, "instructions">): string[] {
  const lines = [`schedule: ${yamlValue(input.schedule.trim())}`];
  lines.push(`notify: ${notifyPhrase(input.notify ?? "always")}`);
  if (input.uses && input.uses.length > 0) lines.push(`uses: [${input.uses.join(", ")}]`);
  if (input.paused) lines.push("paused: true");
  return lines;
}

/** A new routine file. */
export function renderRoutineFile(input: RoutineFileInput): string {
  return ["---", ...frontmatterLines(input), "---", input.instructions.trim(), ""].join("\n");
}

export interface RoutineFilePatch {
  schedule?: string;
  notify?: RoutineNotify;
  uses?: readonly RoutineUse[];
  paused?: boolean;
  instructions?: string;
}

const PATCH_KEYS = ["schedule", "notify", "uses", "paused"] as const;

function patchLine(key: (typeof PATCH_KEYS)[number], patch: RoutineFilePatch): string | null {
  switch (key) {
    case "schedule":
      return patch.schedule === undefined ? null : `schedule: ${yamlValue(patch.schedule.trim())}`;
    case "notify":
      return patch.notify === undefined ? null : `notify: ${notifyPhrase(patch.notify)}`;
    case "uses":
      return patch.uses === undefined ? null : `uses: [${patch.uses.join(", ")}]`;
    case "paused":
      return patch.paused === undefined ? null : `paused: ${patch.paused ? "true" : "false"}`;
  }
}

/**
 * Changes some settings (and/or the instructions) of a routine file, keeping everything else as
 * the user wrote it: other keys, comments, line order. Adds a frontmatter block when there is none.
 */
export function updateRoutineFile(content: string, patch: RoutineFilePatch): string {
  const lines = splitLines(content);
  let end = frontmatterEnd(lines);
  if (end === -1) {
    lines.unshift("---", "---");
    end = 1;
  }
  const head = lines.slice(0, end);
  let body = lines.slice(end + 1);
  for (const key of PATCH_KEYS) {
    const line = patchLine(key, patch);
    if (line === null) continue;
    const index = head.findIndex((raw, i) => i > 0 && KEY_RE.exec(raw)?.[1]?.toLowerCase() === key);
    if (index === -1) {
      head.push(line);
      continue;
    }
    // A block list (`uses:` followed by `- web` lines) goes with its key.
    let after = index + 1;
    while (after < head.length && /^\s+-\s|^-\s/.test(head[after]!)) after++;
    head.splice(index, after - index, line);
  }
  if (patch.instructions !== undefined) body = [patch.instructions.trim(), ""];
  return [...head, "---", ...body].join("\n");
}

// ── Starter templates ────────────────────────────────────────────────────────

/** What "New routine" offers: the everyday routines people ask for most. */
export const ROUTINE_TEMPLATES: readonly RoutineTemplate[] = [
  {
    id: "morning-briefing",
    name: "Morning briefing",
    description: "Your day at a glance: calendar, weather, leftovers and news.",
    schedule: "every weekday at 7:30",
    notify: "always",
    uses: ["web", "connectors"],
    instructions:
      "Brief me for the day: my calendar, the weather where I am, what I didn't finish yesterday (from yesterday's daily note), and anything new from my news sources. Under 10 lines.",
  },
  {
    id: "weekly-review",
    name: "Weekly review",
    description: "Sunday evening: what got done, what slipped, what's next.",
    schedule: "every sunday at 18:00",
    notify: "always",
    uses: [],
    instructions:
      "Review my week from this week's daily notes: what got done, what slipped and why, and what to carry into next week. End with my top 3 priorities for the coming week.",
  },
  {
    id: "carry-over",
    name: "Carry over unfinished tasks",
    description: "Moves yesterday's open tasks into today's note.",
    schedule: "every day at 6:00",
    notify: "when_changed",
    uses: [],
    instructions:
      "Read yesterday's daily note and add its unfinished tasks (open checkboxes) to today's note under a “Carried over” heading, as your own lines. If there were none, say so and change nothing.",
  },
  {
    id: "price-watch",
    name: "Price watch",
    description: "Checks a price or stock level and tells you when it moves.",
    schedule: "every 2 hours",
    notify: "when_changed",
    uses: ["web"],
    instructions:
      "Check the price and availability of <product> at <store link>. Tell me when the price drops below <amount> or it comes back in stock; otherwise report the current price in one line.",
  },
  {
    id: "news-digest",
    name: "News digest",
    description: "Evening digest of the topics you follow, with links.",
    schedule: "every day at 18:00",
    notify: "always",
    uses: ["web"],
    instructions:
      "Summarize today's most important news about <topics> from reputable sources: 5 bullets, one line each, each with its link. Skip anything I've already seen in earlier digests.",
  },
  {
    id: "inbox-triage",
    name: "Inbox triage",
    description: "Sorts new email twice a day and drafts easy replies.",
    schedule: "every weekday at 9:00 and 14:00",
    notify: "when_changed",
    uses: ["connectors"],
    instructions:
      "Go through my new email since the last run: list what needs a reply today, draft replies for the simple ones (save them as drafts, never send), and flag anything urgent.",
  },
];
