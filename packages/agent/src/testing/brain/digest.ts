/**
 * Parses the orchestrator's event digest (`formatOrchestratorDigest` in `src/prompts/orchestrator.ts`)
 * back into structured data. The fake orchestrator relies on this exact format; the round-trip
 * tests fail when the two drift apart.
 */
import { readJsonString } from "./text";

export type DigestChangeKind = "added" | "updated" | "reopened" | "retry";

export interface ParsedChangedTask {
  change: DigestChangeKind;
  taskId: string;
  text: string;
  previousText?: string;
  parentText?: string;
  notes: string[];
}

export interface ParsedOtherTask {
  taskId: string;
  /** Checkbox character (" ", "x", "-", "/", ">"), when shown. */
  checkbox?: string;
  text: string;
  agentStatus?: string;
  agentSummary?: string;
}

/** A line of the note view: `12| text  ⟪tsk_ab · working — "Badge" · yours⟫`. */
export interface ParsedViewLine {
  n: number;
  text: string;
  /** Task or anchor id. */
  id?: string;
  agentStatus?: string;
  agentSummary?: string;
  /** The agent wrote it. */
  agent?: boolean;
}

export interface ParsedNote {
  notePath: string;
  /** "today", "tomorrow", "in 3 days", "2 days ago"… */
  relativeDay?: string;
  changed: ParsedChangedTask[];
  others: ParsedOtherTask[];
  /** Other tasks elided from the digest ("… N more"). */
  moreOthers: number;
  /** The user's changed non-task lines (1-based `n`). */
  changedLines: Array<{ n: number; text: string }>;
  view: ParsedViewLine[];
}

export interface ParsedReply {
  taskId: string | null;
  text: string;
  taskText?: string;
}

export interface ParsedReport {
  taskId: string;
  status: string;
  summary?: string;
  taskText: string;
}

/** A routine run due now (`- [routine] run_…: "name" (schedule)`). */
export interface ParsedRoutineRun {
  taskId: string;
  name: string;
  instructions: string;
}

/** One of the user's routines (`- "name": schedule · paused`). */
export interface ParsedRoutine {
  name: string;
  schedule: string;
  paused: boolean;
}

export interface ParsedSubagent {
  taskId: string;
  taskText: string;
  status: string;
  elapsed?: string;
  summary?: string;
}

export interface ParsedConnector {
  name: string;
  state: string;
  toolCount: number;
}

export interface ParsedCapabilities {
  available: string[];
  unavailable: string[];
  connectors: ParsedConnector[];
  /** The Mac's apps the computer capability can operate. */
  desktopApps: string[];
  /** `missing` when computer tasks can't run until the user allows access. */
  computerAccess?: "ready" | "limited" | "missing";
}

/** A message of the user's earlier chat with the orchestrator. */
export interface ParsedChatLine {
  author: "you" | "orchestrator";
  /** "3m", "<1m"… */
  ago: string;
  text: string;
}

export interface ParsedDigest {
  /** The `Now:` line as written. */
  now: string;
  /** Local ISO date parsed from the `Now:` line. */
  today?: string;
  notes: ParsedNote[];
  replies: ParsedReply[];
  reports: ParsedReport[];
  /** What the user wrote to the orchestrator in its chat. */
  direct: string[];
  chat: ParsedChatLine[];
  routineRuns: ParsedRoutineRun[];
  routines: ParsedRoutine[];
  subagents: ParsedSubagent[];
  capabilities: ParsedCapabilities;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const RELATIVE_DAY = /^(today|tomorrow|yesterday|in \d+ days|\d+ days ago)$/;

type Section =
  | "note"
  | "replies"
  | "reports"
  | "direct"
  | "chat"
  | "routineRuns"
  | "routines"
  | "subagents"
  | "capabilities"
  | null;

/** True for a message that looks like an orchestrator digest. */
export function isDigest(text: string): boolean {
  return /^Now: /.test(text) && text.includes("\n## Capabilities you can grant");
}

export function parseDigest(text: string): ParsedDigest {
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  const now = first.startsWith("Now: ") ? first.slice(5) : "";
  const digest: ParsedDigest = {
    now,
    notes: [],
    replies: [],
    reports: [],
    direct: [],
    chat: [],
    routineRuns: [],
    routines: [],
    subagents: [],
    capabilities: { available: [], unavailable: [], connectors: [], desktopApps: [] },
  };
  const today = isoFromNow(now);
  if (today) digest.today = today;

  let section: Section = null;
  let note: ParsedNote | null = null;
  let noteBlock: "changed" | "lines" | "others" | "view" | null = null;
  let lastChanged: ParsedChangedTask | null = null;

  for (const line of lines.slice(1)) {
    if (line.startsWith("## ")) {
      lastChanged = null;
      noteBlock = null;
      const heading = line.slice(3);
      if (heading === "Replies in task threads") section = "replies";
      else if (heading === "Subagent reports") section = "reports";
      else if (heading.startsWith("Messages to you")) section = "direct";
      else if (heading === "Your recent chat with the user") section = "chat";
      else if (heading === "Running subagents") section = "subagents";
      else if (heading.startsWith("Routine runs")) section = "routineRuns";
      else if (heading === "Routines") section = "routines";
      else if (heading === "Capabilities you can grant") section = "capabilities";
      else {
        section = "note";
        note = parseNoteHeading(heading);
        digest.notes.push(note);
      }
      continue;
    }
    if (section === "note" && note) {
      if (line === "Changed tasks:") {
        noteBlock = "changed";
        continue;
      }
      if (line === "Other tasks on this note:") {
        noteBlock = "others";
        lastChanged = null;
        continue;
      }
      if (line.startsWith("Changed lines (")) {
        noteBlock = "lines";
        lastChanged = null;
        continue;
      }
      if (line.startsWith("Note (the whole file")) {
        noteBlock = "view";
        lastChanged = null;
        continue;
      }
      if (noteBlock === "lines") {
        const head = /^- \[line\] (\d+): /.exec(line);
        const text = head ? readJsonString(line, head[0].length) : null;
        if (head && text) note.changedLines.push({ n: Number(head[1]), text: text.value });
        continue;
      }
      if (noteBlock === "view") {
        const viewLine = parseViewLine(line);
        if (viewLine) note.view.push(viewLine);
        continue;
      }
      if (line.startsWith("    - ") && lastChanged) {
        const parsed = readJsonString(line, 6);
        if (parsed) lastChanged.notes.push(parsed.value);
        continue;
      }
      if (noteBlock === "changed" && line.startsWith("- [")) {
        lastChanged = parseChangedLine(line);
        if (lastChanged) note.changed.push(lastChanged);
        continue;
      }
      if (noteBlock === "others" && line.startsWith("- ")) {
        const more = /^- … (\d+) more \(use list_tasks\)$/.exec(line);
        if (more) {
          note.moreOthers += Number(more[1]);
          continue;
        }
        const other = parseOtherLine(line);
        if (other) note.others.push(other);
      }
      continue;
    }
    if (section === "replies" && line.startsWith("- [reply] ")) {
      const reply = parseReplyLine(line);
      if (reply) digest.replies.push(reply);
      continue;
    }
    if (section === "reports" && line.startsWith("- [report] ")) {
      const report = parseReportLine(line);
      if (report) digest.reports.push(report);
      continue;
    }
    if (section === "direct" && line.startsWith("- [direct] ")) {
      const text = readJsonString(line, "- [direct] ".length);
      if (text) digest.direct.push(text.value);
      continue;
    }
    if (section === "chat") {
      const head = /^- \[(you|orchestrator), (\S+) ago\] /.exec(line);
      const text = head ? readJsonString(line, head[0].length) : null;
      if (head && text) {
        digest.chat.push({
          author: head[1] as ParsedChatLine["author"],
          ago: head[2]!,
          text: text.value,
        });
      }
      continue;
    }
    if (section === "routineRuns") {
      const head = /^- \[routine\] (\S+): /.exec(line);
      const name = head ? readJsonString(line, head[0].length) : null;
      if (head && name) {
        digest.routineRuns.push({ taskId: head[1]!, name: name.value, instructions: "" });
        continue;
      }
      const instructions = "    - instructions: ";
      const last = digest.routineRuns.at(-1);
      if (last && line.startsWith(instructions)) {
        last.instructions = readJsonString(line, instructions.length)?.value ?? "";
      }
      continue;
    }
    if (section === "routines" && line.startsWith('- "')) {
      const name = readJsonString(line, 2);
      if (name && line.startsWith(": ", name.end)) {
        const rest = line.slice(name.end + 2);
        digest.routines.push({
          name: name.value,
          schedule: rest.split(" · ")[0]!,
          paused: rest.endsWith(" · paused"),
        });
      }
      continue;
    }
    if (section === "subagents" && line.startsWith("- ")) {
      const agent = parseSubagentLine(line);
      if (agent) digest.subagents.push(agent);
      continue;
    }
    if (section === "capabilities" && line.startsWith("Available: ")) {
      digest.capabilities = { ...digest.capabilities, ...parseCapabilities(line) };
      continue;
    }
    if (section === "capabilities" && line.startsWith("Desktop apps (computer): ")) {
      digest.capabilities.desktopApps = line
        .slice("Desktop apps (computer): ".length)
        .replace(/(?: \(\+\d+ more\))?\.$/, "")
        .split(", ")
        .filter(Boolean);
      continue;
    }
    if (section === "capabilities" && line.startsWith("Computer access: ")) {
      const state = line.slice("Computer access: ".length);
      digest.capabilities.computerAccess = state.startsWith("missing")
        ? "missing"
        : state.startsWith("ready")
          ? "ready"
          : "limited";
    }
  }
  return digest;
}

function isoFromNow(now: string): string | undefined {
  const match = new RegExp(`(${MONTHS.join("|")}) (\\d{1,2}), (\\d{4})`).exec(now);
  if (!match) return undefined;
  const month = MONTHS.indexOf(match[1]!) + 1;
  return `${match[3]}-${String(month).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
}

function parseNoteHeading(heading: string): ParsedNote {
  const match = /^(.*) \(([^()]+)\)$/.exec(heading);
  const relative = match && RELATIVE_DAY.test(match[2]!) ? match[2]! : undefined;
  return {
    notePath: relative ? match![1]! : heading,
    ...(relative ? { relativeDay: relative } : {}),
    changed: [],
    others: [],
    moreOthers: 0,
    changedLines: [],
    view: [],
  };
}

function parseViewLine(line: string): ParsedViewLine | null {
  const head = /^\s*(\d+)\| ?/.exec(line);
  if (!head) return null;
  const rest = line.slice(head[0].length);
  const note = /^(.*?) {2}⟪([^⟫]*)⟫$/.exec(rest);
  const out: ParsedViewLine = { n: Number(head[1]), text: note ? note[1]! : rest };
  if (!note) return out;
  // `id · status — "summary" · yours`, each part optional; the summary is JSON and may contain " · ".
  let tail = note[2]!;
  const id = /^((?:tsk|anc)_\S+?)(?: · |$)/.exec(tail);
  if (id) {
    out.id = id[1]!;
    tail = tail.slice(id[0].length);
  }
  const status = /^([a-z_]+)(?= — "| · |$)/.exec(tail);
  if (status && status[1] !== "yours") {
    out.agentStatus = status[1]!;
    tail = tail.slice(status[0].length);
    if (tail.startsWith(" — ")) {
      const summary = readJsonString(tail, 3);
      if (summary) {
        out.agentSummary = summary.value;
        tail = tail.slice(summary.end);
      }
    }
    if (tail.startsWith(" · ")) tail = tail.slice(3);
  }
  if (tail === "yours") out.agent = true;
  return out;
}

function parseChangedLine(line: string): ParsedChangedTask | null {
  const head = /^- \[(added|updated|reopened|retry)\] (\S+): /.exec(line);
  if (!head) return null;
  const text = readJsonString(line, head[0].length);
  if (!text) return null;
  const task: ParsedChangedTask = {
    change: head[1] as DigestChangeKind,
    taskId: head[2]!,
    text: text.value,
    notes: [],
  };
  let rest = text.end;
  const was = " (was: ";
  if (line.startsWith(was, rest)) {
    const previous = readJsonString(line, rest + was.length);
    if (previous && line[previous.end] === ")") {
      task.previousText = previous.value;
      rest = previous.end + 1;
    }
  }
  const parent = " (subtask of ";
  if (line.startsWith(parent, rest)) {
    const parentText = readJsonString(line, rest + parent.length);
    if (parentText && line[parentText.end] === ")") task.parentText = parentText.value;
  }
  return task;
}

function parseOtherLine(line: string): ParsedOtherTask | null {
  const head = /^- (?:\[(.)\] )?(\S+): /.exec(line);
  if (!head) return null;
  const text = readJsonString(line, head[0].length);
  if (!text) return null;
  const task: ParsedOtherTask = { taskId: head[2]!, text: text.value };
  if (head[1] !== undefined) task.checkbox = head[1];
  let rest = line.slice(text.end);
  const agent = /^ · agent: (\S+)/.exec(rest);
  if (agent) {
    task.agentStatus = agent[1]!;
    rest = rest.slice(agent[0].length);
  }
  if (rest.startsWith(" — ")) {
    const summary = readJsonString(rest, 3);
    if (summary) task.agentSummary = summary.value;
  }
  return task;
}

function parseReplyLine(line: string): ParsedReply | null {
  const head = /^- \[reply\] (\S+): /.exec(line);
  if (!head) return null;
  const text = readJsonString(line, head[0].length);
  if (!text) return null;
  const reply: ParsedReply = { taskId: head[1] === "no-task" ? null : head[1]!, text: text.value };
  const marker = " (task: ";
  if (line.startsWith(marker, text.end)) {
    const taskText = readJsonString(line, text.end + marker.length);
    if (taskText) reply.taskText = taskText.value;
  }
  return reply;
}

function parseReportLine(line: string): ParsedReport | null {
  const head = /^- \[report\] (\S+): (\S+)/.exec(line);
  if (!head) return null;
  let rest = head[0].length;
  let summary: string | undefined;
  if (line.startsWith(" — ", rest)) {
    const parsed = readJsonString(line, rest + 3);
    if (parsed) {
      summary = parsed.value;
      rest = parsed.end;
    }
  }
  const marker = " (task: ";
  let taskText = "";
  if (line.startsWith(marker, rest)) {
    const parsed = readJsonString(line, rest + marker.length);
    if (parsed) taskText = parsed.value;
  }
  return {
    taskId: head[1]!,
    status: head[2]!,
    taskText,
    ...(summary !== undefined ? { summary } : {}),
  };
}

function parseSubagentLine(line: string): ParsedSubagent | null {
  const head = /^- (\S+): /.exec(line);
  if (!head) return null;
  const text = readJsonString(line, head[0].length);
  if (!text) return null;
  const rest = line.slice(text.end);
  const status = /^ · (\S+)(?: (<1m|\d+m|\d+h\d{2}m))?/.exec(rest);
  if (!status) return null;
  const agent: ParsedSubagent = { taskId: head[1]!, taskText: text.value, status: status[1]! };
  if (status[2]) agent.elapsed = status[2];
  const after = rest.slice(status[0].length);
  if (after.startsWith(" — ")) {
    const summary = readJsonString(after, 3);
    if (summary) agent.summary = summary.value;
  }
  return agent;
}

function parseCapabilities(
  line: string,
): Pick<ParsedCapabilities, "available" | "unavailable" | "connectors"> {
  const match = /^Available: (.*?)\. Unavailable: (.*?)\. Connectors: (.*)\.$/.exec(line);
  if (!match) return { available: [], unavailable: [], connectors: [] };
  const list = (value: string) =>
    value === "none"
      ? []
      : value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
  const connectors: ParsedConnector[] = [];
  if (match[3] !== "none") {
    for (const c of match[3]!.matchAll(/([^,]+?) \((\w+), (\d+) tools\)/g)) {
      connectors.push({ name: c[1]!.trim(), state: c[2]!, toolCount: Number(c[3]) });
    }
  }
  return { available: list(match[1]!), unavailable: list(match[2]!), connectors };
}
