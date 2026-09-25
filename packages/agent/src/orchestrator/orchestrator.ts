import {
  type AppSettings,
  agentModel,
  charFromStatus,
  createId,
  dailyNotePath,
  isActiveTaskStatus,
  isBlankTaskText,
  isClosedStatus,
  isDrawingMarkdown,
  type Logger,
  ORCHESTRATOR_THREAD_ID,
  parseAgentLine,
  parseDailyNotePath,
  silentLogger,
  stripAgentMarker,
  type TaskAgentStatus,
  type ToolSpec,
  today,
  toISODate,
  truncate,
  withTimeout,
} from "@ddl/core";
import { type DrawingDescriptions, drawingBudget } from "../drawings/descriptions";
import type {
  Harness,
  HarnessEvent,
  HarnessSession,
  ToolCallDecision,
  ToolCallRequest,
} from "../harness/types";
import { quote } from "../prompts/format";
import {
  buildOrchestratorSystemPrompt,
  type DigestCapabilities,
  type DigestChange,
  type DigestLine,
  type DigestNote,
  type DigestRoutine,
  formatOrchestratorDigest,
  MAX_VIEW_LINES,
  type OrchestratorDigest,
} from "../prompts/orchestrator";
import { formatTaskUpdate } from "../prompts/subagent";
import type { RoutineRunTriage } from "../routines/scheduler";
import type { GateContext } from "../safety/types";
import type { AnchorLineInput } from "../tools/contracts";
import { ToolInputError } from "../tools/input";
import { findQuotedLine } from "../tools/notes";
import { createOrchestratorTools, type OrchestratorToolHost } from "../tools/orchestrator";
import type { OrchestratorChat } from "./chat";
import type { TaskRecords } from "./records";
import { badgeFrom, type SubagentManager, type SubagentReport } from "./subagents";
import type { TaskBoard } from "./task-board";
import type { TaskLookup } from "./task-watcher";
import type { NoteEvent, SubagentSpec, TaskEvent } from "./types";

export const ORCHESTRATOR_SESSION_PREFIX = "orchestrator:";

export interface OrchestratorOptions {
  /** Null while the agent cannot run. */
  harness: () => Harness | null;
  board: TaskBoard;
  records: TaskRecords;
  subagents: SubagentManager;
  lookup: TaskLookup;
  /** The safety gate. */
  beforeToolCall: (call: ToolCallRequest) => Promise<ToolCallDecision>;
  /** Tools besides the orchestrator's own: read_note, read_drawing, web_search, web_fetch… */
  tools: () => ToolSpec[];
  capabilities: () => DigestCapabilities;
  getSettings: () => AppSettings;
  /** Working directory for the orchestrator session (it has no file tools). */
  cwd: string;
  now?: () => number;
  logger?: Logger;
  /** Settled events arriving within this window share one turn. */
  batchWindowMs?: number;
  /** Subagent reports wait this long, to share a turn with other events. */
  reportDelayMs?: number;
  /** A fresh session is started after this many turns to keep latency low. */
  maxTurnsPerSession?: number;
  /** A turn that takes longer is aborted and its tasks marked failed. */
  turnTimeoutMs?: number;
  /** After each turn: the error, or null when it succeeded. */
  onTurnResult?: (error: string | null) => void;
  /** Records every turn in the orchestrator's own chat, where the user can write to it. */
  chat?: OrchestratorChat;
  /** The user's routines, listed in every digest so it knows what already exists. */
  routines?: () => DigestRoutine[];
  /** Describes the drawings the digest's notes embed (under their embed lines). */
  drawings?: Pick<DrawingDescriptions, "blocks" | "blockFor">;
}

type QueueItem =
  | {
      kind: "task";
      taskId: string;
      change: DigestChange;
      event: TaskEvent;
      previousText?: string;
      dueAt: number;
    }
  | { kind: "reply"; taskId: string | null; threadId: string; text: string; dueAt: number }
  | { kind: "report"; report: SubagentReport; dueAt: number }
  /** The user wrote to the orchestrator in its chat; `messageId` is that chat message. */
  | { kind: "direct"; text: string; messageId: string; dueAt: number }
  /** A routine run with no `uses`, triaged like a task (its record is `taskId`). */
  | { kind: "routine"; taskId: string; run: RoutineRunTriage; dueAt: number }
  | {
      kind: "note";
      notePath: string;
      date: string | null;
      /** 0-based. */
      lines: Array<{ line: number; text: string }>;
      dueAt: number;
    };

interface Turn {
  items: QueueItem[];
  /** Tasks whose status a tool set during this turn. */
  touched: Set<string>;
  commented: Set<string>;
  /** Anchors `anchor_line` created during this turn. */
  anchored: Set<string>;
  error?: string;
  /** The user stopped the turn. */
  cancelled?: boolean;
  startedAt: number;
  firstToolAt?: number;
}

interface OrchestratorSession {
  id: string;
  date: string;
  session: HarnessSession;
  /** The harness that created the session; a new harness gets a new session. */
  harness: Harness;
  turns: number;
  /** Display labels of the session's tools, by name. */
  labels: ReadonlyMap<string, string>;
}

/** Earlier messages of the orchestrator's chat a digest carries for context. */
const CHAT_CONTEXT_MESSAGES = 8;
/** The note view of a note that is itself a drawing. */
const DRAWING_NOTE_TEXT = "(This note is an Excalidraw drawing: its scene data isn't shown.)";
const TRIGGER_TASK_CHARS = 60;

const CHANGE_PRIORITY: Record<DigestChange, number> = {
  updated: 0,
  reopened: 1,
  added: 2,
  retry: 3,
};

const RESTORABLE: readonly TaskAgentStatus[] = ["done", "ignored", "failed", "waiting_user"];

/**
 * The control plane plus the orchestrator agent. Routine transitions (checking off or deleting a
 * task with active work, edits while a subagent works) are handled without the model; everything
 * that needs judgment is batched into one digest message per turn of the day's orchestrator
 * session.
 */
export class Orchestrator {
  private readonly options: OrchestratorOptions;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly batchWindowMs: number;
  private readonly reportDelayMs: number;
  private readonly maxTurnsPerSession: number;
  private readonly turnTimeoutMs: number;
  private readonly queue = new Map<string, QueueItem>();
  private readonly previousStatus = new Map<string, TaskAgentStatus>();
  private session: OrchestratorSession | null = null;
  /** Session ids are unique per day: `orchestrator:<date>`, then `~2`, `~3`… after rotation. */
  private lastSequence = { date: "", value: 0 };
  private turn: Turn | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private timerDueAt = Number.POSITIVE_INFINITY;
  private draining: Promise<void> | null = null;
  private lastText = "";
  private stopped = false;
  private readonly host: OrchestratorToolHost;

  constructor(options: OrchestratorOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
    this.batchWindowMs = options.batchWindowMs ?? 150;
    this.reportDelayMs = options.reportDelayMs ?? 1_500;
    this.maxTurnsPerSession = options.maxTurnsPerSession ?? 30;
    this.turnTimeoutMs = options.turnTimeoutMs ?? 180_000;
    this.host = this.createHost();
  }

  /** True when nothing is queued or running (test helper). */
  get idle(): boolean {
    return this.queue.size === 0 && this.draining === null;
  }

  static isOrchestratorSession(sessionId: string): boolean {
    return sessionId.startsWith(ORCHESTRATOR_SESSION_PREFIX);
  }

  /** An approval the orchestrator's own calls need shows up in its chat. */
  contextFor(_sessionId: string): GateContext {
    return {
      taskId: null,
      threadId: this.options.chat ? ORCHESTRATOR_THREAD_ID : null,
      ...(this.lastText ? { rationale: truncate(this.lastText, 1_000) } : {}),
    };
  }

  /** A turn is running (its chat shows it as working). */
  get turnRunning(): boolean {
    return this.turn !== null;
  }

  // ── Inputs ────────────────────────────────────────────────────────────────

  handleTaskEvent(event: TaskEvent): void {
    if (this.stopped) return;
    const { task } = event;
    const { records } = this.options;
    switch (event.kind) {
      case "added":
      case "reopened": {
        records.ensure({
          taskId: task.id,
          notePath: event.notePath,
          date: event.date,
          text: task.text,
          line: task.line,
        });
        records.update(task.id, { text: task.text, line: task.line });
        this.syncTitle(task.id, task.text);
        this.beginTriage(task.id);
        this.enqueueTask(task.id, event.kind, event);
        return;
      }
      case "updated": {
        records.update(task.id, { text: task.text, line: task.line });
        this.syncTitle(task.id, task.text);
        if (this.options.subagents.isWorking(task.id)) {
          const update = formatTaskUpdate({
            text: task.text,
            ...(event.previous ? { previousText: event.previous.text } : {}),
            notes: task.notes,
          });
          this.background(this.options.subagents.message(task.id, update, "task_update"));
          return;
        }
        this.enqueueTask(task.id, "updated", event);
        return;
      }
      case "completed":
      case "removed": {
        this.dropQueued(task.id);
        const removed = event.kind === "removed";
        this.background(
          this.stopWork(
            task.id,
            removed ? "The task was deleted from the note." : "The task was checked off.",
            removed,
          ),
        );
        return;
      }
    }
  }

  /** The user wrote or edited lines that aren't tasks (they may be addressed to the agent). */
  handleNoteEvent(event: NoteEvent): void {
    if (this.stopped || event.lines.length === 0) return;
    const key = `note:${event.notePath}`;
    const existing = this.queue.get(key);
    const lines = new Map<string, { line: number; text: string }>();
    if (existing?.kind === "note") for (const line of existing.lines) lines.set(line.text, line);
    for (const line of event.lines) lines.set(line.text, line);
    this.queue.set(key, {
      kind: "note",
      notePath: event.notePath,
      date: event.date,
      lines: [...lines.values()].sort((a, b) => a.line - b.line),
      dueAt: existing?.dueAt ?? this.now() + this.batchWindowMs,
    });
    this.scheduleDrain();
  }

  /** The line an anchor was attached to is gone: like deleting a task, its work stops. */
  anchorRemoved(anchorId: string): void {
    if (this.stopped) return;
    this.dropQueued(anchorId);
    this.background(this.stopWork(anchorId, "The line was deleted from the note.", true));
  }

  /** A user reply in a thread whose task has no subagent in this process. */
  handleUserReply(input: { threadId: string; taskId: string | null; text: string }): void {
    if (this.stopped) return;
    if (input.taskId) this.beginTriage(input.taskId);
    this.queue.set(`reply:${createId()}`, {
      kind: "reply",
      taskId: input.taskId,
      threadId: input.threadId,
      text: input.text,
      dueAt: this.now() + this.batchWindowMs,
    });
    this.scheduleDrain();
  }

  /**
   * The user wrote to the orchestrator in its chat (the message is already there): it answers in
   * its next turn, after the one running now.
   */
  handleDirectMessage(input: { text: string; messageId: string }): void {
    if (this.stopped) return;
    this.queue.set(`direct:${input.messageId}`, {
      kind: "direct",
      text: input.text,
      messageId: input.messageId,
      dueAt: this.now() + this.batchWindowMs,
    });
    this.scheduleDrain();
  }

  /**
   * Stops the turn in progress (the user pressed Stop in the chat). Its session is dropped, so the
   * next turn starts fresh; subagents it started keep working. False when no turn is running.
   */
  async cancelTurn(): Promise<boolean> {
    const turn = this.turn;
    if (!turn || turn.cancelled) return false;
    turn.cancelled = true;
    await this.session?.session.abort().catch(() => {});
    return true;
  }

  notifySubagentFinished(report: SubagentReport): void {
    if (this.stopped) return;
    this.queue.set(`report:${report.taskId}`, {
      kind: "report",
      report,
      dueAt: this.now() + this.reportDelayMs,
    });
    this.scheduleDrain();
  }

  /** A routine's run to triage like a task: usually a subagent with the capabilities it needs. */
  handleRoutineRun(run: RoutineRunTriage): void {
    if (this.stopped) return;
    this.beginTriage(run.taskId);
    this.queue.set(`routine:${run.taskId}`, {
      kind: "routine",
      taskId: run.taskId,
      run,
      dueAt: this.now() + this.batchWindowMs,
    });
    this.scheduleDrain();
  }

  /** Re-triages a task from scratch (retry of a task no subagent worked on). */
  retryTask(taskId: string): void {
    const found = this.options.lookup.findTask(taskId);
    const record = this.options.records.get(taskId);
    if (!found && !record) throw new ToolInputError(`Unknown task: ${taskId}`);
    const event: TaskEvent = found
      ? {
          kind: "added",
          notePath: found.notePath,
          date: found.date,
          task: found.task,
          at: this.now(),
        }
      : {
          kind: "added",
          notePath: record!.notePath,
          date: record!.date,
          at: this.now(),
          task: {
            id: taskId,
            text: record!.text,
            status: "open",
            line: record!.line,
            depth: 0,
            parentId: null,
            notes: [],
            firstSeenAt: record!.updatedAt,
            updatedAt: record!.updatedAt,
          },
        };
    this.beginTriage(taskId);
    this.enqueueTask(taskId, "retry", event);
  }

  /** Forgets queued work for a task (it was cancelled by the user). */
  dropQueued(taskId: string): void {
    this.queue.delete(`task:${taskId}`);
    this.queue.delete(`report:${taskId}`);
    this.queue.delete(`routine:${taskId}`);
    for (const [key, item] of this.queue) {
      if (item.kind === "reply" && item.taskId === taskId) this.queue.delete(key);
    }
    this.previousStatus.delete(taskId);
  }

  /** A task may be coming (the user is typing): get the day's session ready for its prompt. */
  warm(): void {
    if (!this.stopped) this.session?.session.warm?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue.clear();
    const current = this.session;
    this.session = null;
    if (current) {
      await current.session.abort().catch(() => {});
      await current.session.dispose().catch(() => {});
    }
    await this.draining?.catch(() => {});
  }

  // ── Queue ─────────────────────────────────────────────────────────────────

  private enqueueTask(taskId: string, change: DigestChange, event: TaskEvent): void {
    const key = `task:${taskId}`;
    const existing = this.queue.get(key);
    let merged = change;
    let previousText = event.previous?.text;
    let dueAt = this.now() + this.batchWindowMs;
    if (existing?.kind === "task") {
      if (CHANGE_PRIORITY[existing.change] > CHANGE_PRIORITY[change]) merged = existing.change;
      previousText = existing.previousText ?? previousText;
      dueAt = Math.min(dueAt, existing.dueAt);
    }
    this.queue.set(key, {
      kind: "task",
      taskId,
      change: merged,
      event,
      ...(previousText !== undefined ? { previousText } : {}),
      dueAt,
    });
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.stopped || this.draining) return;
    let due = Number.POSITIVE_INFINITY;
    for (const item of this.queue.values()) due = Math.min(due, item.dueAt);
    if (!Number.isFinite(due) || (this.timer && this.timerDueAt <= due)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDueAt = due;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.timerDueAt = Number.POSITIVE_INFINITY;
        this.startDrain();
      },
      Math.max(0, due - this.now()),
    );
  }

  private startDrain(): void {
    if (this.draining || this.stopped) return;
    this.draining = (async () => {
      try {
        while (!this.stopped && this.queue.size > 0) {
          const items = this.routeToSubagents([...this.queue.values()]);
          this.queue.clear();
          if (items.length > 0) await this.runTurn(items);
        }
      } catch (error) {
        this.logger.error("Orchestrator loop failed", { error: errorText(error) });
      } finally {
        this.draining = null;
        if (this.queue.size > 0) this.scheduleDrain();
      }
    })();
  }

  /**
   * Edits queued while a task was being triaged go straight to the subagent that the triage
   * started, instead of costing another orchestrator turn.
   */
  private routeToSubagents(items: QueueItem[]): QueueItem[] {
    return items.filter((item) => {
      if (item.kind !== "task" || item.change !== "updated") return true;
      if (!this.options.subagents.isWorking(item.taskId)) return true;
      const task = this.options.lookup.findTask(item.taskId)?.task ?? item.event.task;
      const update = formatTaskUpdate({
        text: task.text,
        ...(item.previousText !== undefined ? { previousText: item.previousText } : {}),
        notes: task.notes,
      });
      this.background(this.options.subagents.message(item.taskId, update, "task_update"));
      return false;
    });
  }

  // ── Turns ─────────────────────────────────────────────────────────────────

  private async runTurn(items: QueueItem[]): Promise<void> {
    const turn: Turn = {
      items,
      touched: new Set(),
      commented: new Set(),
      anchored: new Set(),
      startedAt: this.now(),
    };
    this.turn = turn;
    const { chat } = this.options;
    chat?.beginTurn(this.describeTrigger(items), this.session?.labels ?? new Map());
    try {
      const session = await this.ensureSession();
      chat?.setLabels(session.labels);
      if (!turn.cancelled) {
        const digest = this.buildDigest(items, session.turns === 0);
        await this.describeDrawings(digest);
        const prompt = session.session.prompt(formatOrchestratorDigest(digest));
        try {
          await withTimeout(
            prompt,
            this.turnTimeoutMs,
            "The orchestrator took too long to respond.",
          );
        } catch (error) {
          await session.session.abort().catch(() => {});
          throw error;
        }
        session.turns++;
      }
    } catch (error) {
      if (!turn.cancelled) turn.error ??= errorText(error);
    } finally {
      this.turn = null;
    }
    // Stopping aborts the turn; its tasks stay "triaging" and are re-triaged on the next start.
    if (this.stopped) {
      chat?.endTurn({ interrupted: true });
      return;
    }
    chat?.endTurn(turn.cancelled ? { cancelled: true } : turn.error ? { error: turn.error } : {});
    if (turn.cancelled) {
      this.logger.info("Orchestrator turn stopped by the user");
      await this.resetSession();
    } else if (turn.error) {
      this.logger.warn("Orchestrator turn failed", { error: turn.error });
      await this.resetSession();
    } else {
      this.logger.debug("Orchestrator turn done", {
        items: items.length,
        firstToolMs: turn.firstToolAt !== undefined ? turn.firstToolAt - turn.startedAt : null,
        totalMs: this.now() - turn.startedAt,
      });
    }
    try {
      this.resolveTurn(turn);
      this.options.onTurnResult?.(turn.error ?? null);
    } catch (error) {
      this.logger.error("Failed to resolve orchestrator turn", { error: errorText(error) });
    }
  }

  /** Tasks the model left untouched: answered → done, errors → failed, otherwise ignored. */
  private resolveTurn(turn: Turn): void {
    // An anchor the model attached but never used would leave an empty badge on the line.
    for (const anchorId of turn.anchored) {
      if (!turn.touched.has(anchorId) && !turn.commented.has(anchorId)) {
        this.options.records.remove(anchorId);
      }
    }
    for (const item of turn.items) {
      const taskId =
        item.kind === "task" || item.kind === "reply" || item.kind === "routine"
          ? item.taskId
          : null;
      if (!taskId) continue;
      const previous = this.previousStatus.get(taskId);
      this.previousStatus.delete(taskId);
      const record = this.options.records.get(taskId);
      if (record?.status !== "triaging" || turn.touched.has(taskId)) continue;
      if (turn.error) {
        this.options.board.setStatus(taskId, "failed", {
          summary: "Couldn't triage",
          note: `The orchestrator couldn't process this task: ${truncate(turn.error, 500)}. Use Retry to try again.`,
        });
      } else if (turn.cancelled) {
        if (previous && RESTORABLE.includes(previous))
          this.options.board.setStatus(taskId, previous);
        else {
          this.options.board.setStatus(taskId, "cancelled", {
            summary: "Stopped",
            note: "You stopped the orchestrator before it decided. Use Retry to triage this again.",
          });
        }
      } else if (turn.commented.has(taskId)) {
        this.options.board.setStatus(taskId, "done");
      } else {
        // A re-triaged task keeps its earlier outcome unless the model acted on it.
        const restore = previous && RESTORABLE.includes(previous) ? previous : "ignored";
        this.options.board.setStatus(taskId, restore);
      }
    }
  }

  private async ensureSession(): Promise<OrchestratorSession> {
    const date = toISODate(today(new Date(this.now())));
    const harness = this.options.harness();
    const current = this.session;
    if (
      current &&
      current.harness === harness &&
      current.date === date &&
      current.turns < this.maxTurnsPerSession
    ) {
      return current;
    }
    if (current) {
      this.session = null;
      this.background(current.session.dispose());
    }
    if (!harness) throw new Error("The agent harness is unavailable.");
    const sequence = this.lastSequence.date === date ? this.lastSequence.value + 1 : 1;
    this.lastSequence = { date, value: sequence };
    const id = `${ORCHESTRATOR_SESSION_PREFIX}${date}${sequence > 1 ? `~${sequence}` : ""}`;
    const tools = [...createOrchestratorTools(this.host), ...this.options.tools()];
    const session = await harness.createSession({
      sessionId: id,
      role: "orchestrator",
      systemPrompt: buildOrchestratorSystemPrompt(),
      tools,
      model: agentModel(this.options.getSettings().agent),
      thinking: "low",
      cwd: this.options.cwd,
      beforeToolCall: this.options.beforeToolCall,
      onEvent: (event) => this.onEvent(event),
    });
    const labels = new Map(tools.map((tool) => [tool.name, tool.label]));
    this.session = { id, date, session, harness, turns: 0, labels };
    return this.session;
  }

  /** After a failed turn the next one starts from a fresh session. */
  private async resetSession(): Promise<void> {
    const current = this.session;
    if (!current) return;
    this.session = null;
    await current.session.dispose().catch(() => {});
  }

  private onEvent(event: HarnessEvent): void {
    this.options.chat?.onEvent(event);
    switch (event.type) {
      case "message_end":
        if (event.text.trim()) this.lastText = event.text.trim();
        return;
      case "tool_start":
        if (this.turn && this.turn.firstToolAt === undefined) this.turn.firstToolAt = this.now();
        return;
      case "error":
        if (this.turn && !this.turn.cancelled) this.turn.error = event.message;
        return;
      default:
        return;
    }
  }

  /** What woke the orchestrator, in one line for its chat. */
  private describeTrigger(items: readonly QueueItem[]): string {
    const notes = new Map<string, { tasks: number; lines: number }>();
    const noteCount = (notePath: string) => {
      let count = notes.get(notePath);
      if (!count) {
        count = { tasks: 0, lines: 0 };
        notes.set(notePath, count);
      }
      return count;
    };
    const events: string[] = [];
    let direct = 0;
    for (const item of items) {
      switch (item.kind) {
        case "task":
          if (item.change === "retry") {
            events.push(`You asked to retry ${this.taskName(item.taskId, item.event.task.text)}`);
          } else noteCount(item.event.notePath).tasks++;
          break;
        case "note":
          noteCount(item.notePath).lines += item.lines.length;
          break;
        case "reply":
          events.push(
            item.taskId
              ? `You replied in ${this.taskName(item.taskId)}`
              : "You replied in a thread",
          );
          break;
        case "report":
          events.push(describeReport(this.taskName(item.report.taskId), item.report.status));
          break;
        case "direct":
          direct++;
          break;
        case "routine":
          events.push(`Routine “${truncate(item.run.name, TRIGGER_TASK_CHARS)}” is due`);
          break;
      }
    }
    const parts = [...notes].map(([notePath, { tasks, lines }]) => {
      const counts = [
        ...(tasks > 0 ? [plural(tasks, "task")] : []),
        ...(lines > 0 ? [plural(lines, "line")] : []),
      ];
      return `${notePath} changed: ${counts.join(", ")}`;
    });
    parts.push(...events);
    if (direct > 0) parts.push(direct === 1 ? "You wrote to me" : `You wrote to me (${direct})`);
    return parts.join(" · ") || "Checking in";
  }

  private taskName(taskId: string, fallback?: string): string {
    const text = this.options.records.get(taskId)?.text ?? fallback ?? taskId;
    return `“${truncate(text, TRIGGER_TASK_CHARS)}”`;
  }

  private buildDigest(items: QueueItem[], freshSession: boolean): OrchestratorDigest {
    const { lookup, records, subagents } = this.options;
    const now = this.now();
    const notes = new Map<string, DigestNote>();
    const noteFor = (notePath: string, date: string | null): DigestNote => {
      let note = notes.get(notePath);
      if (!note) {
        note = { notePath, date, changed: [], others: [] };
        notes.set(notePath, note);
      }
      return note;
    };
    const changed = new Set<string>();
    for (const item of items) {
      if (item.kind === "note") {
        noteFor(item.notePath, item.date).changedLines = item.lines.map((line) => ({
          n: line.line + 1,
          text: line.text,
        }));
        continue;
      }
      if (item.kind !== "task") continue;
      const found = lookup.findTask(item.taskId);
      const task = found?.task ?? item.event.task;
      const notePath = found?.notePath ?? item.event.notePath;
      const note = noteFor(notePath, found?.date ?? item.event.date);
      const record = records.get(item.taskId);
      const parent = task.parentId
        ? lookup.getTasks(notePath).find((t) => t.id === task.parentId)
        : undefined;
      note.changed.push({
        taskId: item.taskId,
        text: task.text,
        checkbox: task.status,
        notes: task.notes,
        change: item.change,
        ...(item.previousText !== undefined ? { previousText: item.previousText } : {}),
        ...(parent ? { parentText: parent.text } : {}),
        ...(record && item.change === "updated" ? { agentStatus: record.status } : {}),
      });
      changed.add(item.taskId);
    }
    // A reply or a report brings its task's note into view, so the orchestrator can write there.
    for (const item of items) {
      const taskId =
        item.kind === "reply" ? item.taskId : item.kind === "report" ? item.report.taskId : null;
      if (!taskId) continue;
      const found = lookup.findTask(taskId);
      const record = records.get(taskId);
      const notePath = found?.notePath ?? record?.notePath;
      if (notePath) noteFor(notePath, found?.date ?? record?.date ?? null);
    }
    // Talking about "the dentist task" needs today's list in view.
    const direct = items.filter((item) => item.kind === "direct");
    if (direct.length > 0) noteFor(this.todayPath(), toISODate(today(new Date(now))));
    for (const note of notes.values()) {
      const view = this.noteView(note.notePath);
      if (view) note.view = view;
      const tasks = lookup.getTasks(note.notePath);
      // Items arrive in settle order, which timer jitter can shuffle; the model works through the
      // digest in order, so it lists a note's tasks the way the note does.
      const position = new Map(tasks.map((task, index) => [task.id, index]));
      const at = (taskId: string) => position.get(taskId) ?? Number.MAX_SAFE_INTEGER;
      note.changed.sort((a, b) => at(a.taskId) - at(b.taskId));
      for (const task of tasks) {
        if (changed.has(task.id) || isBlankTaskText(task.text)) continue;
        const record = records.get(task.id);
        note.others.push({
          taskId: task.id,
          text: task.text,
          checkbox: task.status,
          notes: [],
          ...(record ? { agentStatus: record.status } : {}),
          ...(record?.summary ? { agentSummary: record.summary } : {}),
        });
      }
    }
    const replies: OrchestratorDigest["replies"] = [];
    const reports: OrchestratorDigest["reports"] = [];
    for (const item of items) {
      if (item.kind === "reply") {
        const text = item.taskId ? records.get(item.taskId)?.text : undefined;
        replies.push({ taskId: item.taskId, text: item.text, ...(text ? { taskText: text } : {}) });
      } else if (item.kind === "report") {
        reports.push({
          taskId: item.report.taskId,
          taskText: records.get(item.report.taskId)?.text ?? "",
          status: item.report.status,
          ...(item.report.summary ? { summary: item.report.summary } : {}),
        });
      }
    }
    // The recent chat comes along when the user writes, and to a fresh session so it still knows.
    const chat =
      direct.length > 0 || freshSession
        ? (this.options.chat?.recentExchanges(
            CHAT_CONTEXT_MESSAGES,
            new Set(direct.map((item) => item.messageId)),
          ) ?? [])
        : [];
    const routineRuns = items.flatMap((item) =>
      item.kind === "routine"
        ? [
            {
              taskId: item.taskId,
              name: item.run.name,
              instructions: item.run.instructions,
              ...(item.run.scheduleText ? { scheduleText: item.run.scheduleText } : {}),
            },
          ]
        : [],
    );
    const routines = this.options.routines?.() ?? [];
    return {
      now,
      notes: [...notes.values()],
      replies,
      reports,
      ...(routineRuns.length > 0 ? { routineRuns } : {}),
      ...(routines.length > 0 ? { routines } : {}),
      ...(direct.length > 0 ? { direct: direct.map((item) => item.text) } : {}),
      ...(chat.length > 0 ? { chat } : {}),
      subagents: subagents.list().map((agent) => ({
        taskId: agent.taskId,
        taskText: agent.taskText,
        status: agent.status,
        ...(agent.startedAt !== null ? { runningForMs: now - agent.startedAt } : {}),
        ...(agent.summary ? { summary: agent.summary } : {}),
      })),
      capabilities: this.options.capabilities(),
    };
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  private createHost(): OrchestratorToolHost {
    const { board, subagents } = this.options;
    const touch = (taskId: string) => this.turn?.touched.add(taskId);
    return {
      spawnSubagent: async (input) => {
        const task = board.require(input.taskId);
        if (task.status && isClosedStatus(task.status)) {
          throw new ToolInputError("This task is already checked off; leave it alone.");
        }
        const { available } = this.options.capabilities();
        const granted = input.capabilities.filter((c) => available.includes(c));
        const dropped = input.capabilities.filter((c) => !available.includes(c));
        if (granted.length === 0 && input.capabilities.length > 0) {
          throw new ToolInputError(
            `None of the requested capabilities are available. Available: ${available.join(", ") || "none"}.`,
          );
        }
        const spec: SubagentSpec = {
          taskId: input.taskId,
          goal: input.goal,
          ...(input.instructions ? { instructions: input.instructions } : {}),
          capabilities: granted,
        };
        const result = await subagents.spawn(spec);
        touch(input.taskId);
        const note = dropped.length > 0 ? ` Unavailable, not granted: ${dropped.join(", ")}.` : "";
        return result.status === "queued"
          ? `Subagent queued (all slots are busy); it starts automatically.${note}`
          : `Subagent ${result.resumed ? "resumed" : "started"} for ${input.taskId}.${note}`;
      },
      postComment: async ({ taskId, text, summary }) => {
        board.postAgentText(taskId, "orchestrator", text);
        board.setSummary(taskId, summary ?? (badgeFrom(text) || null));
        this.turn?.commented.add(taskId);
        return "Comment posted.";
      },
      askUser: async ({ taskId, question }) => {
        if (subagents.isWorking(taskId)) {
          throw new ToolInputError(
            "A subagent is working on this task; use message_subagent instead.",
          );
        }
        board.postAgentText(taskId, "orchestrator", question);
        board.setStatus(taskId, "waiting_user", { summary: badgeFrom(`Question: ${question}`) });
        touch(taskId);
        return "Question posted. The user's reply will arrive as a new event.";
      },
      setTaskStatus: async ({ taskId, status, summary }) => {
        board.ensureRecord(taskId);
        if (subagents.isWorking(taskId)) {
          throw new ToolInputError(
            "A subagent is working on this task. Message it, or cancel it first with cancel_subagent.",
          );
        }
        board.setStatus(taskId, status, summary ? { summary } : {});
        touch(taskId);
        return `Status set to ${status}.`;
      },
      messageSubagent: async ({ taskId, text }) => {
        board.require(taskId);
        if (!(await subagents.message(taskId, text, "orchestrator"))) {
          throw new ToolInputError("This task has no subagent right now. Use spawn_subagent.");
        }
        touch(taskId);
        return "Message delivered.";
      },
      cancelSubagent: async ({ taskId, reason }) => {
        if (!(await subagents.cancel(taskId, reason))) {
          throw new ToolInputError("No active subagent for this task.");
        }
        touch(taskId);
        return "Subagent cancelled.";
      },
      listTasks: async ({ notePath }) => this.describeTasks(notePath ?? this.todayPath()),
      anchorLine: async (input) => this.anchorLine(input),
    };
  }

  /**
   * Each drawing embedded in a note of the digest gets its description under the embed line; one
   * budget for the whole digest. Drawings that can't be described never fail the turn.
   */
  private async describeDrawings(digest: OrchestratorDigest): Promise<void> {
    const drawings = this.options.drawings;
    if (!drawings) return;
    const budget = drawingBudget();
    for (const note of digest.notes) {
      const view = note.view?.slice(0, MAX_VIEW_LINES);
      if (!view) continue;
      try {
        const text = view.map((line) => line.text).join("\n");
        // A note the Excalidraw plugin turned into a drawing: its description, not its scene data.
        if (isDrawingMarkdown(text)) {
          const block = await drawings.blockFor(note.notePath, budget);
          note.view = [{ n: 1, text: DRAWING_NOTE_TEXT, drawing: block }];
          continue;
        }
        const blocks = await drawings.blocks(text, budget);
        for (const block of blocks) {
          const line = view[block.line];
          if (line) line.drawing = [...(line.drawing ?? []), ...block.lines];
        }
      } catch (error) {
        this.logger.warn("Could not describe the drawings of a note", {
          notePath: note.notePath,
          error: errorText(error),
        });
      }
    }
  }

  /** The whole note, numbered, with what the agent knows about each line. */
  private noteView(notePath: string): DigestLine[] | undefined {
    const { lookup, records } = this.options;
    const content = lookup.getContent(notePath);
    if (content === null) return undefined;
    const tasks = new Map(lookup.getTasks(notePath).map((task) => [task.line, task]));
    const anchors = new Map(records.anchors(notePath).map((record) => [record.line, record]));
    return content.split("\n").map((raw, index): DigestLine => {
      const line = raw.replace(/\r$/, "");
      const agent = parseAgentLine(line);
      const task = tasks.get(index);
      const anchor = task ? undefined : anchors.get(index);
      const record = task ? records.get(task.id) : anchor;
      return {
        n: index + 1,
        text: agent?.text ?? line,
        ...(task ? { taskId: task.id } : {}),
        ...(anchor ? { anchorId: anchor.taskId } : {}),
        ...(agent ? { agent: true } : {}),
        ...(record ? { agentStatus: record.status } : {}),
        ...(record?.summary ? { agentSummary: record.summary } : {}),
      };
    });
  }

  /** `anchor_line`: a record for a non-task line, so it gets a thread and a badge. */
  private anchorLine(input: AnchorLineInput): string {
    const { lookup, records } = this.options;
    const notePath = input.notePath ?? this.todayPath();
    const content = lookup.getContent(notePath);
    if (content === null) {
      throw new ToolInputError(
        `${notePath} isn't a daily note I watch; only lines of watched notes can have threads.`,
      );
    }
    const lines = content.split("\n").map((line) => line.replace(/\r$/, ""));
    const index = findQuotedLine(lines, input.line - 1, input.text);
    if (index === null) {
      throw new ToolInputError(
        `Line ${input.line} of ${notePath} doesn't read ${quote(input.text, 120)}. Use the numbers of the note view in the latest digest.`,
      );
    }
    const task = lookup.getTasks(notePath).find((t) => t.line === index);
    if (task) return `Line ${index + 1} is a task: use its id ${task.id}.`;
    const text = stripAgentMarker(lines[index]!).trim();
    const existing = records.anchors(notePath).find((record) => record.line === index);
    if (existing) return `Line ${index + 1} already has a thread: use ${existing.taskId}.`;
    const date = parseDailyNotePath(notePath, this.options.getSettings().dailyNotes);
    const record = records.ensure({
      taskId: createId("anc", 10),
      notePath,
      date: date ? toISODate(date) : null,
      text,
      line: index,
      anchor: "line",
    });
    this.turn?.anchored.add(record.taskId);
    return `Attached ${record.taskId} to line ${index + 1}. Use it as the taskId.`;
  }

  private describeTasks(notePath: string): string {
    const tasks = this.options.lookup.getTasks(notePath).filter((t) => !isBlankTaskText(t.text));
    if (tasks.length === 0) return `No tasks on ${notePath}.`;
    const lines = tasks.map((task) => {
      const record = this.options.records.get(task.id);
      const agent = record ? `agent: ${record.status}` : "agent: none";
      const summary = record?.summary ? ` — ${quote(record.summary, 120)}` : "";
      return `- [${charFromStatus(task.status)}] ${task.id}: ${quote(task.text, 300)} · ${agent}${summary}`;
    });
    return [`${notePath}:`, ...lines].join("\n");
  }

  private todayPath(): string {
    return dailyNotePath(today(new Date(this.now())), this.options.getSettings().dailyNotes);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private beginTriage(taskId: string): void {
    const record = this.options.records.get(taskId);
    if (!record) return;
    if (this.options.subagents.isWorking(taskId)) return;
    if (!this.previousStatus.has(taskId)) this.previousStatus.set(taskId, record.status);
    this.options.board.setStatus(taskId, "triaging");
  }

  private async stopWork(taskId: string, reason: string, removed: boolean): Promise<void> {
    const { records, subagents } = this.options;
    const record = records.get(taskId);
    if (subagents.isWorking(taskId) || (record && isActiveTaskStatus(record.status))) {
      await subagents.cancel(taskId, reason);
    }
    if (removed) {
      await subagents.discard(taskId);
      records.remove(taskId);
    }
  }

  private syncTitle(taskId: string, text: string): void {
    const threadId = this.options.records.get(taskId)?.threadId;
    if (threadId) this.options.board.renameThread(threadId, text);
  }

  private background(promise: Promise<unknown>): void {
    promise.catch((error: unknown) => {
      this.logger.error("Orchestrator background task failed", { error: errorText(error) });
    });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describeReport(task: string, status: TaskAgentStatus): string {
  switch (status) {
    case "done":
      return `${task} finished`;
    case "failed":
      return `${task} failed`;
    case "waiting_user":
    case "waiting_approval":
      return `${task} needs you`;
    case "cancelled":
      return `${task} stopped`;
    default:
      return `${task}: ${status}`;
  }
}
