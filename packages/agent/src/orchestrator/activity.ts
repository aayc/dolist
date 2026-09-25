/**
 * What the orchestrator is doing, as `orchestrator.activity` events: lines it noticed (before
 * they settle), then each turn's phases (`reading` → `thinking` ⇄ `acting` → `idle` with the
 * turn's outcome). Changes are coalesced: repeats are dropped and a burst of tool calls reads as
 * one stretch of `acting`.
 */
import {
  ORCHESTRATOR_ACTIVITY_LIMITS as LIMITS,
  ORCHESTRATOR_THREAD_ID,
  type OrchestratorActivity,
  type OrchestratorOutcome,
  type OrchestratorTrigger,
  type OrchestratorTriggerKind,
  stripAgentMarker,
  truncate,
} from "@ddl/core";
import { TOOL } from "../tools/contracts";

/** `acting` holds this long after the last tool ends, so tool calls in a row don't flicker. */
export const ACTING_LINGER_MS = 300;
/** A finished turn's outcome stays in `status().orchestrator` this long (for joining clients). */
export const OUTCOME_STATUS_MS = 8_000;

export interface TriggerLine {
  line: number;
  text: string;
}

export interface ActivityPublisherOptions {
  emit: (activity: OrchestratorActivity) => void;
  now?: () => number;
  lingerMs?: number;
  outcomeStatusMs?: number;
}

interface TurnState {
  activity: OrchestratorActivity;
  runningTools: number;
  /** Approvals the turn waits for, by id, with the card's summary. */
  approvals: Map<string, string>;
  linger: ReturnType<typeof setTimeout> | undefined;
}

export class OrchestratorActivityPublisher {
  private readonly emitActivity: (activity: OrchestratorActivity) => void;
  private readonly now: () => number;
  private readonly lingerMs: number;
  private readonly outcomeStatusMs: number;
  private turn: TurnState | null = null;
  /** Lines noticed per note and not yet taken by a turn. */
  private readonly noticed = new Map<string, OrchestratorActivity>();
  private ended: { activity: OrchestratorActivity; at: number } | null = null;
  private last = "";

  constructor(options: ActivityPublisherOptions) {
    this.emitActivity = options.emit;
    this.now = options.now ?? Date.now;
    this.lingerMs = options.lingerMs ?? ACTING_LINGER_MS;
    this.outcomeStatusMs = options.outcomeStatusMs ?? OUTCOME_STATUS_MS;
  }

  /** What it is doing now: the running turn, else lines waiting to settle, else the last outcome. */
  current(): OrchestratorActivity {
    if (this.turn) return this.turn.activity;
    const waiting = [...this.noticed.values()].at(-1);
    if (waiting) return waiting;
    if (this.ended && this.now() - this.ended.at < this.outcomeStatusMs) return this.ended.activity;
    return { phase: "idle" };
  }

  /**
   * The lines of `notePath` that may be requests and haven't settled; none withdraws the ones
   * noticed before (they were deleted or no longer read as requests).
   */
  notice(notePath: string, lines: readonly TriggerLine[]): void {
    const previous = this.noticed.get(notePath);
    if (lines.length === 0) {
      if (!previous) return;
      this.noticed.delete(notePath);
      this.emit({ phase: "idle", trigger: noteTrigger("note", notePath, []) });
      return;
    }
    const activity: OrchestratorActivity = {
      phase: "noticed",
      trigger: noteTrigger("note", notePath, lines),
      startedAt: previous?.startedAt ?? this.now(),
    };
    this.noticed.delete(notePath);
    this.noticed.set(notePath, activity);
    this.emit(activity);
  }

  /** Forgets every noticed line (the watcher stopped), telling clients. */
  withdrawAll(): void {
    for (const notePath of [...this.noticed.keys()]) this.notice(notePath, []);
  }

  beginTurn(turnId: string, trigger: OrchestratorTrigger): void {
    this.clearLinger();
    this.takeNoticed(trigger);
    this.turn = {
      activity: { phase: "reading", turnId, trigger, startedAt: this.now() },
      runningTools: 0,
      approvals: new Map(),
      linger: undefined,
    };
    this.emit(this.turn.activity);
  }

  thinking(): void {
    const turn = this.turn;
    if (!turn || turn.runningTools > 0 || turn.linger) return;
    this.setPhase("thinking");
  }

  toolStarted(): void {
    const turn = this.turn;
    if (!turn) return;
    turn.runningTools++;
    this.clearLinger();
    this.setPhase("acting");
  }

  toolEnded(): void {
    const turn = this.turn;
    if (!turn) return;
    turn.runningTools = Math.max(0, turn.runningTools - 1);
    if (turn.runningTools > 0 || turn.linger) return;
    turn.linger = setTimeout(() => {
      turn.linger = undefined;
      if (this.turn === turn && turn.runningTools === 0) this.setPhase("thinking");
    }, this.lingerMs);
    (turn.linger as { unref?: () => void }).unref?.();
  }

  /** One of the turn's tool calls waits for the user's approval (or stopped waiting). */
  approval(id: string, summary: string, pending: boolean): void {
    const turn = this.turn;
    if (!turn) return;
    if (pending) turn.approvals.set(id, summary);
    else if (!turn.approvals.delete(id)) return;
    this.setPhase(turn.runningTools > 0 || pending ? "acting" : turn.activity.phase);
  }

  /** The approval summary the turn still waits for, if any. */
  pendingApproval(): string | undefined {
    return this.turn ? [...this.turn.approvals.values()][0] : undefined;
  }

  /** Ends the turn: `idle` with its outcome (none when it failed or was stopped). */
  endTurn(outcome: OrchestratorOutcome | undefined): void {
    const turn = this.turn;
    if (!turn) return;
    this.clearLinger();
    this.turn = null;
    const { turnId, trigger, startedAt } = turn.activity;
    const activity: OrchestratorActivity = {
      phase: "idle",
      ...(turnId !== undefined ? { turnId } : {}),
      ...(trigger ? { trigger } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(outcome ? { outcome } : {}),
    };
    this.ended = { activity, at: this.now() };
    this.emit(activity);
  }

  dispose(): void {
    this.clearLinger();
  }

  private setPhase(phase: OrchestratorActivity["phase"]): void {
    const turn = this.turn;
    if (!turn) return;
    const { outcome: _previous, ...rest } = turn.activity;
    const waitingFor = [...turn.approvals.values()][0];
    turn.activity = {
      ...rest,
      phase,
      ...(waitingFor !== undefined && phase === "acting"
        ? {
            outcome: {
              kind: "asked_approval",
              threadId: ORCHESTRATOR_THREAD_ID,
              text: truncate(waitingFor, LIMITS.outcomeTextChars),
            },
          }
        : {}),
    };
    this.emit(turn.activity);
  }

  /** The turn takes over the noticed lines it carries (same line or same text). */
  private takeNoticed(trigger: OrchestratorTrigger): void {
    if (!trigger.notePath || !trigger.lines) return;
    const noticed = this.noticed.get(trigger.notePath);
    if (!noticed?.trigger?.lines) return;
    const taken = trigger.lines;
    const left = noticed.trigger.lines.filter(
      (line) => !taken.some((t) => t.line === line.line || t.text === line.text),
    );
    if (left.length === 0) this.noticed.delete(trigger.notePath);
    else {
      this.noticed.set(trigger.notePath, {
        ...noticed,
        trigger: noteTrigger("note", trigger.notePath, left),
      });
    }
  }

  private clearLinger(): void {
    if (this.turn?.linger) clearTimeout(this.turn.linger);
    if (this.turn) this.turn.linger = undefined;
  }

  private emit(activity: OrchestratorActivity): void {
    const json = JSON.stringify(activity);
    if (json === this.last) return;
    this.last = json;
    this.emitActivity(activity);
  }
}

// ── Triggers ────────────────────────────────────────────────────────────────

/** A trigger naming lines of a note, bounded (the first lines in note order). */
export function noteTrigger(
  kind: OrchestratorTriggerKind,
  notePath: string,
  lines: readonly TriggerLine[],
  summary?: string,
): OrchestratorTrigger {
  const sorted = [...lines].sort((a, b) => a.line - b.line).slice(0, LIMITS.lines);
  const bounded = sorted.map((line) => ({
    line: line.line,
    text: truncate(line.text, LIMITS.lineChars),
  }));
  return {
    kind,
    notePath,
    lines: bounded,
    summary: boundedSummary(summary ?? summarizeLines(kind, lines)),
  };
}

function summarizeLines(kind: OrchestratorTriggerKind, lines: readonly TriggerLine[]): string {
  if (lines.length === 1) return quoted(lines[0]!.text);
  if (kind === "task") return lines.length === 0 ? "your tasks" : `${lines.length} tasks`;
  return lines.length === 0 ? "your note" : `${lines.length} lines in your note`;
}

/** “text”, cut to fit a summary. */
export function quoted(text: string): string {
  return `“${truncate(stripAgentMarker(text).trim(), LIMITS.summaryChars - 2)}”`;
}

export function boundedSummary(summary: string): string {
  return truncate(summary.replace(/\s+/g, " ").trim(), LIMITS.summaryChars) || "your note";
}

// ── Outcomes ────────────────────────────────────────────────────────────────

/** One tool call of the turn that finished without an error and wasn't blocked. */
export interface TurnEffect {
  toolName: string;
  input: unknown;
}

export interface OutcomeContext {
  effects: readonly TurnEffect[];
  /** The thread of a task or anchor, once it has one. */
  threadOf: (taskId: string) => string | null;
  /** The turn answered a message in the orchestrator's chat with this text. */
  chatReply?: string;
  /** The summary of an approval the turn still waits for. */
  pendingApproval?: string;
  /** The turn's last words (a no-op's tooltip). */
  finalText?: string;
}

const TASK_LINE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[ \]\s+(.*)$/;

/**
 * What a turn did, by its successful tool calls, most telling first: an approval it waits for,
 * subagents started, a routine made, tasks added, a reply, other note edits, else nothing.
 */
export function deriveOutcome(ctx: OutcomeContext): OrchestratorOutcome {
  const text = (value: string | undefined) =>
    value?.trim() ? { text: truncate(firstLine(value), LIMITS.outcomeTextChars) } : {};
  const thread = (taskId: string | undefined) => {
    const id = taskId ? ctx.threadOf(taskId) : null;
    return id ? { threadId: id } : {};
  };
  if (ctx.pendingApproval !== undefined) {
    return {
      kind: "asked_approval",
      threadId: ORCHESTRATOR_THREAD_ID,
      ...text(ctx.pendingApproval),
    };
  }
  const calls = (name: string) => ctx.effects.filter((effect) => effect.toolName === name);

  const spawned = calls(TOOL.spawnSubagent);
  if (spawned.length > 0) {
    const tasks = [...new Set(spawned.map((effect) => field(effect, "taskId")))];
    return {
      kind: "delegated",
      count: tasks.length,
      ...thread(tasks[0]),
      ...text(field(spawned[0]!, "goal")),
    };
  }

  const routines = calls(TOOL.createRoutine);
  if (routines.length > 0) {
    const name = field(routines[0]!, "name");
    return {
      kind: "routine_created",
      count: routines.length,
      ...text(name ? `Routine “${name}”` : undefined),
    };
  }

  const edits = calls(TOOL.editNote);
  const written = edits.flatMap((effect) => writtenLines(effect.input));
  const tasks = written.flatMap((line) => {
    const match = TASK_LINE.exec(line);
    return match ? [match[1]!] : [];
  });
  if (tasks.length > 0) {
    return { kind: "tasks_added", count: tasks.length, ...text(tasks[0]) };
  }

  const replies = [...calls(TOOL.postComment), ...calls(TOOL.askUser)];
  if (replies.length > 0) {
    const first = replies[0]!;
    return {
      kind: "replied",
      count: replies.length,
      ...thread(field(first, "taskId")),
      ...text(field(first, "text") ?? field(first, "question")),
    };
  }
  if (ctx.chatReply?.trim()) {
    return { kind: "replied", threadId: ORCHESTRATOR_THREAD_ID, ...text(ctx.chatReply) };
  }

  if (edits.length > 0) {
    const count = edits.reduce((sum, effect) => sum + editCount(effect.input), 0);
    return {
      kind: "note_edited",
      count: Math.max(1, count),
      ...thread(field(edits[0]!, "taskId")),
      ...text(written[0]),
    };
  }
  return { kind: "no_action", ...text(ctx.finalText) };
}

function field(effect: TurnEffect, key: string): string | undefined {
  const value = isRecord(effect.input) ? effect.input[key] : undefined;
  return typeof value === "string" ? value : undefined;
}

/** New and replacement lines of an `edit_note` call. */
function writtenLines(input: unknown): string[] {
  if (!isRecord(input) || !Array.isArray(input.edits)) return [];
  return input.edits.flatMap((edit: unknown) => {
    if (!isRecord(edit)) return [];
    const lines = Array.isArray(edit.lines)
      ? edit.lines.filter((line): line is string => typeof line === "string")
      : [];
    return typeof edit.text === "string" ? [...lines, edit.text] : lines;
  });
}

function editCount(input: unknown): number {
  return isRecord(input) && Array.isArray(input.edits) ? input.edits.length : 0;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
