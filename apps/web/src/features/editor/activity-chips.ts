/**
 * What the orchestrator is doing, as the editor shows it: a chip at the end of each line that woke
 * it, the note-level indicator and the status bar item. Pure functions over `orchestrator.activity`
 * events; the wording, timings and rules are shared with the Mac app (see the web README).
 */
import {
  findEditedLine,
  isOrchestratorThread,
  isSameLineEdited,
  isTaskLine,
  type OrchestratorActivity,
  type OrchestratorOutcome,
  type OrchestratorPhase,
  stem,
} from "@ddl/core";
import type { ActivityChip } from "@ddl/editor";

/** How long an outcome shows before fading, and the fade (shared with the Mac app). */
export const CHIP_TIMING = {
  outcomeMs: 6_000,
  /** "Nothing to do" goes sooner. */
  nothingMs: 2_500,
  fadeMs: 600,
  /** A noticed line that never gets its turn (the agent paused, the connection dropped) goes. */
  noticedMs: 60_000,
} as const;

export interface ChipEntry {
  /** Stable while the chip lives: its id in the editor. */
  key: string;
  notePath: string;
  /** 0-based line, as the daemon last reported it. */
  line: number;
  /** The line's text, as the daemon last reported it. */
  text: string;
  phase: OrchestratorPhase;
  turnId?: string;
  outcome?: OrchestratorOutcome;
  /** When it starts fading and when it goes; absent: until the next event. */
  fadeAt?: number;
  removeAt?: number;
}

export interface ActivityView {
  /** The turn in progress (reading, thinking or acting): the note header and the status bar. */
  turn: OrchestratorActivity | null;
  chips: readonly ChipEntry[];
}

export const EMPTY_ACTIVITY: ActivityView = { turn: null, chips: [] };

type Line = { line: number; text: string };
type ChipState = Pick<ChipEntry, "phase" | "turnId" | "outcome" | "fadeAt" | "removeAt">;

/**
 * Applies one event. Noticed lines replace the note's earlier noticed ones; a turn's phases put
 * its chips on the lines of its trigger (taking over their dots); its end gives them the outcome,
 * or removes them when it has none (a failed or stopped turn). An `idle` without a turn withdraws
 * noticed lines, and one without a trigger at all means nothing is in progress any more.
 */
export function reduceActivity(
  state: ActivityView,
  activity: OrchestratorActivity,
  now: number,
  newKey: () => string,
): ActivityView {
  const { phase, turnId, trigger, outcome } = activity;
  const notePath = trigger?.notePath;
  const lines = trigger?.lines ?? [];
  switch (phase) {
    case "noticed": {
      if (!notePath) return state;
      const earlier = new Set(state.chips.filter((c) => isNoticed(c, notePath)).map((c) => c.key));
      const next = { phase, removeAt: now + CHIP_TIMING.noticedMs };
      const chips = upsert(state.chips, notePath, lines, next, newKey).filter(
        (c) => !earlier.has(c.key) || lines.some((l) => l.line === c.line && l.text === c.text),
      );
      return { ...state, chips };
    }
    case "reading":
    case "thinking":
    case "acting": {
      const next: ChipState = {
        phase,
        ...(turnId !== undefined ? { turnId } : {}),
        ...(phase === "acting" && outcome ? { outcome } : {}),
      };
      let chips = notePath ? upsert(state.chips, notePath, lines, next, newKey) : state.chips;
      if (turnId !== undefined) {
        chips = chips.map((c) => (c.turnId === turnId ? { ...withoutTimers(c), ...next } : c));
      }
      return { turn: activity, chips };
    }
    case "idle": {
      if (turnId !== undefined) {
        const turn = state.turn?.turnId === turnId ? null : state.turn;
        if (!outcome) {
          const chips = state.chips.filter(
            (c) =>
              c.turnId !== turnId &&
              !(notePath && c.notePath === notePath && onLines(c, lines) && c.phase !== "idle"),
          );
          return { turn, chips };
        }
        const shown = outcome.kind === "no_action" ? CHIP_TIMING.nothingMs : CHIP_TIMING.outcomeMs;
        const next: ChipState = {
          phase,
          turnId,
          outcome,
          fadeAt: now + shown,
          removeAt: now + shown + CHIP_TIMING.fadeMs,
        };
        let chips = notePath ? upsert(state.chips, notePath, lines, next, newKey) : state.chips;
        chips = chips.map((c) => (c.turnId === turnId ? { ...c, ...next } : c));
        return { turn, chips };
      }
      if (!trigger) return { turn: null, chips: state.chips.filter((c) => c.phase === "idle") };
      if (!notePath) return state;
      return {
        ...state,
        chips: state.chips.filter(
          (c) => !isNoticed(c, notePath) || (lines.length > 0 && !onLines(c, lines)),
        ),
      };
    }
  }
}

/** Chips whose time is up are gone. */
export function expireChips(state: ActivityView, now: number): ActivityView {
  const chips = state.chips.filter((c) => c.removeAt === undefined || c.removeAt > now);
  return chips.length === state.chips.length ? state : { ...state, chips };
}

/** The next moment a chip starts fading or goes, after `now`. */
export function nextChipChange(state: ActivityView, now: number): number | null {
  let next: number | null = null;
  for (const chip of state.chips) {
    for (const at of [chip.fadeAt, chip.removeAt]) {
      if (at !== undefined && at > now && (next === null || at < next)) next = at;
    }
  }
  return next;
}

function isNoticed(chip: ChipEntry, notePath: string): boolean {
  return chip.notePath === notePath && chip.phase === "noticed";
}

function onLines(chip: ChipEntry, lines: readonly Line[]): boolean {
  return lines.some((l) => sameLine(chip, l));
}

function sameLine(chip: ChipEntry, line: Line): boolean {
  return (
    (chip.line === line.line && isSameLineEdited(chip.text, line.text)) || chip.text === line.text
  );
}

function withoutTimers(chip: ChipEntry): ChipEntry {
  const { fadeAt: _fade, removeAt: _remove, outcome: _outcome, ...rest } = chip;
  return rest;
}

/**
 * Puts `next` on each line: on the chip already there (same line and still that text, or the
 * nearest chip with that text), else on a new one. One chip per line.
 */
function upsert(
  chips: readonly ChipEntry[],
  notePath: string,
  lines: readonly Line[],
  next: ChipState,
  newKey: () => string,
): ChipEntry[] {
  const out = [...chips];
  for (const line of lines) {
    let index = out.findIndex(
      (c) => c.notePath === notePath && c.line === line.line && isSameLineEdited(c.text, line.text),
    );
    if (index === -1) {
      let best = Number.POSITIVE_INFINITY;
      out.forEach((c, i) => {
        if (c.notePath !== notePath || !isSameLineEdited(c.text, line.text)) return;
        const distance = Math.abs(c.line - line.line);
        if (distance < best) {
          best = distance;
          index = i;
        }
      });
    }
    const key = index === -1 ? newKey() : out[index]!.key;
    const chip: ChipEntry = { key, notePath, line: line.line, text: line.text, ...next };
    if (index === -1) out.push(chip);
    else out[index] = chip;
  }
  const seen = new Set<string>();
  return out
    .reverse()
    .filter((c) => {
      const id = `${c.notePath}\u0000${c.line}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .reverse();
}

// ── Wording ─────────────────────────────────────────────────────────────────

type ChipLook = Omit<ActivityChip, "id" | "line">;

const OUTCOME_LABELS: Record<OrchestratorOutcome["kind"], (count: number) => string> = {
  no_action: () => "Nothing to do",
  tasks_added: (n) => (n > 1 ? `Added ${n} tasks ↗` : "Added a task ↗"),
  note_edited: () => "Edited the note ↗",
  replied: () => "Replied ↗",
  delegated: (n) => (n > 1 ? `Started ${n} tasks ↗` : "Started a task ↗"),
  routine_created: () => "Made a routine ↗",
  asked_approval: () => "Needs your approval ↗",
};

const OUTCOME_TOOLTIPS: Record<OrchestratorOutcome["kind"], string> = {
  no_action: "Nothing for the orchestrator to do here",
  tasks_added: "The orchestrator added tasks to your note",
  note_edited: "The orchestrator wrote in your note",
  replied: "The orchestrator replied",
  delegated: "The orchestrator started a task for this",
  routine_created: "The orchestrator made a routine",
  asked_approval: "The orchestrator needs your approval to go on",
};

/** A chip's label, tooltip and look, by its phase and outcome. */
export function chipLook(chip: ChipEntry, now: number): ChipLook {
  const fading = chip.fadeAt !== undefined && now >= chip.fadeAt;
  const withFade = (look: ChipLook): ChipLook => (fading ? { ...look, fading: true } : look);
  if (chip.outcome && (chip.phase === "idle" || chip.outcome.kind === "asked_approval")) {
    return withFade(outcomeLook(chip.outcome));
  }
  switch (chip.phase) {
    case "noticed":
      return withFade({
        label: "",
        tooltip: "The orchestrator noticed this line",
        tone: "quiet",
        pulse: true,
        kind: "noticed",
      });
    case "reading":
    case "thinking":
      return {
        label: "Orchestrator is looking…",
        tooltip: "The orchestrator is looking at this line",
        tone: "working",
        pulse: true,
        kind: "looking",
      };
    default:
      return {
        label: "Working…",
        tooltip: "The orchestrator is working on this line",
        tone: "working",
        pulse: true,
        kind: "working",
      };
  }
}

function outcomeLook(outcome: OrchestratorOutcome): ChipLook {
  const label = OUTCOME_LABELS[outcome.kind](outcome.count ?? 1);
  const text = outcome.text?.trim();
  const plain = label.replace(/ ↗$/, "");
  return {
    label,
    tooltip: text ? `${plain}: ${text}` : OUTCOME_TOOLTIPS[outcome.kind],
    tone: outcome.kind === "asked_approval" ? "needs-you" : "quiet",
    kind:
      outcome.kind === "asked_approval"
        ? "needs-you"
        : outcome.kind === "no_action"
          ? "nothing"
          : "outcome",
  };
}

/** Where clicking a chip goes: the outcome's thread, else the orchestrator's chat at the turn. */
export function chipTarget(chip: ChipEntry): { threadId: string } | { turnId: string | null } {
  const threadId = chip.outcome?.threadId;
  if (threadId && !isOrchestratorThread(threadId)) return { threadId };
  return { turnId: chip.turnId ?? null };
}

// ── Placing chips in the editor ─────────────────────────────────────────────

/**
 * The editor's chips for one note's entries: each on its line in `lines` (where the editor has
 * moved it, `mapped`, else the reported line or the nearest line that is still its text). Chips
 * whose line is gone, or is a task (its badge already tells), aren't drawn.
 */
export function placeChips(
  entries: readonly ChipEntry[],
  lines: readonly string[],
  mapped: ReadonlyMap<string, number>,
  now: number,
): ActivityChip[] {
  const out: ActivityChip[] = [];
  const used = new Set<number>();
  for (const entry of entries) {
    let line: number | null = mapped.get(entry.key) ?? null;
    if (line === null || !isSameLineEdited(entry.text, lines[line] ?? "")) {
      line = findEditedLine(lines, entry.line, entry.text);
    }
    if (line === null || used.has(line) || isTaskLine(lines[line]!)) continue;
    used.add(line);
    out.push({ id: entry.key, line, ...chipLook(entry, now) });
  }
  return out.sort((a, b) => a.line - b.line);
}

// ── The note header and the status bar ──────────────────────────────────────

/** "Orchestrator: thinking…" while its turn works on the open note. */
export function noteIndicator(
  turn: OrchestratorActivity | null,
  notePath: string | null,
): string | null {
  if (!turn || !notePath || turn.trigger?.notePath !== notePath) return null;
  if (turn.phase === "acting" && turn.outcome?.kind === "asked_approval") {
    return "Orchestrator: needs your approval";
  }
  if (turn.phase === "reading") return "Orchestrator: reading this note…";
  if (turn.phase === "thinking") return "Orchestrator: thinking…";
  return "Orchestrator: working…";
}

/** "Orchestrator: working on 2026-09-24" while its turn is about anything but the open note. */
export function statusIndicator(
  turn: OrchestratorActivity | null,
  notePath: string | null,
): string | null {
  if (!turn) return null;
  const about = turn.trigger?.notePath;
  if (about && about === notePath) return null;
  return `Orchestrator: working on ${about ? stem(about) : (turn.trigger?.summary ?? "something")}`;
}
