/**
 * Parses what the SubagentManager sends a subagent (`src/prompts/subagent.ts`): the kickoff prompt
 * and the steering / follow-up messages (user replies, orchestrator messages, task edits, the
 * finish nudge). Round-trip tests keep this in sync with the prompt builders.
 */
import { FINISH_NUDGE } from "../../prompts/subagent";
import { readJsonString } from "./text";

export interface ParsedKickoff {
  task: string;
  notes: string[];
  notePath: string;
  relativeDay?: string;
  goal: string;
  instructions?: string;
  /** Lines of the thread history block (retries, re-primed sessions), without the "- " prefix. */
  history: string[];
  /** Messages that arrived while the work was queued. */
  followUps: SteerMessage[];
  reassignment: boolean;
  retry: boolean;
}

export type SteerMessage =
  | { kind: "user_reply"; text: string }
  | { kind: "orchestrator"; text: string }
  | { kind: "task_update"; text: string; previousText?: string; notes: string[] }
  | { kind: "nudge" }
  | { kind: "other"; text: string };

const RETRY_LINE = "This is a retry of an earlier attempt.";
const REASSIGNMENT_LINE = "New assignment for the same task.";

export function isKickoff(text: string): boolean {
  return /^Task: "/m.test(text) && /^Goal: /m.test(text) && /\nStart now\.\s*$/.test(text);
}

export function parseKickoff(text: string): ParsedKickoff | null {
  if (!isKickoff(text)) return null;
  const lines = text.split("\n");
  const kickoff: ParsedKickoff = {
    task: "",
    notes: [],
    notePath: "",
    goal: "",
    history: [],
    followUps: [],
    reassignment: lines.includes(REASSIGNMENT_LINE),
    retry: lines.some((line) => line.startsWith(RETRY_LINE)),
  };
  let block: "notes" | "history" | "followUps" | "instructions" | null = null;
  for (const line of lines) {
    if (line.startsWith("Task: ")) {
      kickoff.task = readJsonString(line, 6)?.value ?? line.slice(6);
      block = null;
    } else if (line === "Notes under the task:") {
      block = "notes";
    } else if (line.startsWith("From the note: ")) {
      const from = line.slice("From the note: ".length);
      const match = /^(.*) \(([^()]+)\)$/.exec(from);
      if (match) {
        kickoff.notePath = match[1]!;
        kickoff.relativeDay = match[2]!;
      } else kickoff.notePath = from;
      block = null;
    } else if (line.startsWith("Goal: ")) {
      kickoff.goal = line.slice(6);
      block = null;
    } else if (line.startsWith("Instructions: ")) {
      kickoff.instructions = line.slice("Instructions: ".length);
      block = "instructions";
    } else if (line.startsWith("History of this task's thread")) {
      block = "history";
    } else if (line === "Messages received since this was assigned:") {
      block = "followUps";
    } else if (line === "Start now.") {
      block = null;
    } else if (line === "") {
      if (block === "instructions") block = null;
    } else if (block === "notes" && line.startsWith("- ")) {
      kickoff.notes.push(readJsonString(line, 2)?.value ?? line.slice(2));
    } else if (block === "history" && line.startsWith("- ")) {
      kickoff.history.push(line.slice(2));
    } else if (block === "followUps" && line.startsWith("- ")) {
      kickoff.followUps.push(...parseSteer(line.slice(2)));
    } else if (block === "instructions") {
      kickoff.instructions = `${kickoff.instructions ?? ""}\n${line}`;
    }
  }
  return kickoff;
}

/** A steering / follow-up prompt; several may be joined by blank lines. */
export function parseSteer(text: string): SteerMessage[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed === FINISH_NUDGE) return [{ kind: "nudge" }];
  const out: SteerMessage[] = [];
  for (const part of trimmed.split(/\n\n+/)) {
    const message = parseOne(part.trim());
    if (message) out.push(message);
  }
  return out;
}

function parseOne(part: string): SteerMessage | null {
  if (!part) return null;
  if (part === FINISH_NUDGE) return { kind: "nudge" };
  const reply = "The user replied in the thread: ";
  if (part.startsWith(reply)) {
    return { kind: "user_reply", text: readJsonString(part, reply.length)?.value ?? part };
  }
  const orchestrator = "Message from the orchestrator: ";
  if (part.startsWith(orchestrator)) {
    return { kind: "orchestrator", text: part.slice(orchestrator.length) };
  }
  const edited = "The user edited the task. Now: ";
  if (part.startsWith(edited)) {
    const now = readJsonString(part, edited.length);
    const update: SteerMessage = { kind: "task_update", text: now?.value ?? "", notes: [] };
    if (now) {
      const previous = ". Previously: ";
      if (part.startsWith(previous, now.end)) {
        const prev = readJsonString(part, now.end + previous.length);
        if (prev) update.previousText = prev.value;
      }
      const notesAt = part.indexOf(" Notes: ", now.end);
      if (notesAt !== -1) {
        let at = notesAt + " Notes: ".length;
        for (;;) {
          const note = readJsonString(part, at);
          if (!note) break;
          update.notes.push(note.value);
          if (!part.startsWith("; ", note.end)) break;
          at = note.end + 2;
        }
      }
    }
    return update;
  }
  return { kind: "other", text: part };
}
