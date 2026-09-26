import type { ConnectorToolSource } from "@ddl/connectors";
import {
  type AppSettings,
  agentModel,
  createId,
  errorMessage,
  isActiveTaskStatus,
  type Logger,
  type MessageAuthor,
  type SurfaceKind,
  silentLogger,
  type TaskAgentStatus,
  type Thread,
  type ToolCallMessage,
  type ToolSpec,
  toolResultText,
  truncate,
} from "@ddl/core";
import { type DrawingDescriptions, drawingBudget } from "../drawings/descriptions";
import type {
  Capability,
  ExecutionProvider,
  ExecutionToolFactory,
  FrameListener,
  Workspace,
} from "../execution/types";
import type {
  Harness,
  HarnessEvent,
  HarnessSession,
  ToolCallDecision,
  ToolCallRequest,
  TranscriptEntry,
} from "../harness/types";
import {
  buildSubagentKickoff,
  buildSubagentSystemPrompt,
  buildThreadHistory,
  FINISH_NUDGE,
  formatSteerMessage,
  RESUME_NOTE,
  type SteerSource,
} from "../prompts/subagent";
import type { RoutineBrief } from "../routines/scheduler";
import type { ApprovalBroker, GateContext } from "../safety/types";
import { defaultMimeType } from "../threads/artifacts";
import type { ThreadJournal, ThreadStore } from "../threads/types";
import { ToolInputError } from "../tools/input";
import { createThreadTools, THREAD_TOOL_NAMES, type ThreadToolHost } from "../tools/thread";
import type { TaskRecords } from "./records";
import { previewText, sanitizeForDisplay } from "./redact";
import type { TaskBoard, TaskRef } from "./task-board";
import type { SubagentSpec } from "./types";

type FrameData = Parameters<FrameListener>[0];

export interface SubagentReport {
  taskId: string;
  threadId: string;
  status: TaskAgentStatus;
  summary?: string;
  /** A routine's run: whether it found something new (its `finish_task`). */
  changed?: boolean;
}

export interface SubagentSnapshot {
  taskId: string;
  threadId: string;
  taskText: string;
  status: TaskAgentStatus;
  startedAt: number | null;
  summary?: string;
}

export interface SpawnResult {
  threadId: string;
  status: "working" | "queued";
  /** The task's finished session was reused (it keeps its earlier context). */
  resumed: boolean;
}

export interface SubagentManagerOptions {
  /** Null while the agent cannot run (e.g. no API key). */
  harness: () => Harness | null;
  board: TaskBoard;
  threads: ThreadStore;
  /** The threads' journal: prompts are recorded to rebuild a session; interrupted steps are read. */
  journal?: ThreadJournal;
  records: TaskRecords;
  approvals: () => ApprovalBroker;
  /** The safety gate; every subagent tool call goes through it. */
  beforeToolCall: (call: ToolCallRequest) => Promise<ToolCallDecision>;
  execution: ExecutionProvider;
  executionTools: ExecutionToolFactory;
  connectors?: ConnectorToolSource;
  /** read_note / search_notes. */
  knowledgeTools: () => ToolSpec[];
  /** web_fetch / web_search (granted with the `web` capability). */
  webTools: () => ToolSpec[];
  /** Tools bound to the subagent's own task (`edit_note` writes under it by default). */
  taskTools?: (taskId: string) => ToolSpec[];
  /** Additional tools per subagent (mock mode). */
  extraTools?: (spec: SubagentSpec, task: TaskRef) => ToolSpec[];
  getSettings: () => AppSettings;
  onFrame: (threadId: string, surface: SurfaceKind, frame: FrameData) => void;
  /** Someone watches the thread's surface (tools skip capturing frames nobody sees). */
  isWatched?: (threadId: string, surface: SurfaceKind) => boolean;
  /** A subagent finished a turn (done, failed, needs the user…). */
  onFinished: (report: SubagentReport) => void;
  /** Running/queued counts changed. */
  onChange: () => void;
  now?: () => number;
  logger?: Logger;
  /** Finished sessions kept warm for follow-ups; older ones are disposed (and re-primed later). */
  maxIdleSessions?: number;
  /** The routine a task is a run of (its kickoff and `finish_task` change accordingly). */
  routineBrief?: (taskId: string) => RoutineBrief | undefined;
  /** Describes the drawings a task or its notes embed, for the kickoff. */
  drawings?: Pick<DrawingDescriptions, "blocks">;
}

type RunState = "queued" | "starting" | "running" | "idle";

type PendingPrompt =
  | { kind: "kickoff"; reassignment: boolean; retry: boolean }
  | { kind: "message"; text: string }
  /** Picking up a run the agent stopped in the middle of, from the journal's transcript. */
  | { kind: "resume"; transcript: readonly TranscriptEntry[]; sessionId?: string };

interface TurnState {
  finishStatus?: TaskAgentStatus;
  /** A routine run's `finish_task` said whether anything changed. */
  changed?: boolean;
  askedUser: boolean;
  error?: string;
  /** The session to pick a run back up couldn't start. */
  resumeFailed?: boolean;
  /** Text of the turn's final assistant message ("" when it ended with tool calls only). */
  finalText: string;
  nudged: boolean;
}

interface StreamState {
  id: string;
  text: string;
  createdAt: number;
  posted: boolean;
}

interface Run {
  taskId: string;
  threadId: string;
  spec: SubagentSpec;
  author: MessageAuthor;
  state: RunState;
  closed: boolean;
  controller: AbortController;
  session?: HarnessSession;
  /** The harness that created `session`; a new harness gets a new session. */
  sessionHarness?: Harness;
  sessionId?: string;
  workspace?: Workspace;
  pending?: PendingPrompt;
  /** Messages received while queued or between turns; folded into the next prompt. */
  inbox: string[];
  /** A new session for this run must be primed with the thread history. */
  needsHistory: boolean;
  lastText: string;
  turn: TurnState;
  streams: Map<string, StreamState>;
  toolMessages: Map<string, ToolCallMessage>;
  toolLabels: Map<string, string>;
  startedAt: number | null;
  lastActiveAt: number;
}

const DEFAULT_MAX_IDLE_SESSIONS = 8;

/**
 * Runs one harness session per task: concurrency-limited (FIFO queue), streaming into the task's
 * thread, steerable by user replies and the orchestrator, cancellable and retryable.
 */
export class SubagentManager {
  private readonly options: SubagentManagerOptions;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly maxIdleSessions: number;
  private readonly runs = new Map<string, Run>();
  private readonly bySession = new Map<string, Run>();
  private readonly usedSessionIds = new Set<string>();
  private queue: Run[] = [];
  private stopped = false;

  constructor(options: SubagentManagerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
    this.maxIdleSessions = options.maxIdleSessions ?? DEFAULT_MAX_IDLE_SESSIONS;
  }

  runningCount(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (run.state === "starting" || run.state === "running") count++;
    }
    return count;
  }

  queuedCount(): number {
    return this.queue.length;
  }

  /** A subagent is queued or working on the task. */
  isWorking(taskId: string): boolean {
    const run = this.runs.get(taskId);
    return run !== undefined && run.state !== "idle";
  }

  /** A subagent exists for the task in this process (working, or finished and resumable). */
  hasSubagent(taskId: string): boolean {
    return this.runs.has(taskId);
  }

  list(): SubagentSnapshot[] {
    const out: SubagentSnapshot[] = [];
    for (const run of this.runs.values()) {
      if (run.state === "idle") continue;
      const record = this.options.records.get(run.taskId);
      out.push({
        taskId: run.taskId,
        threadId: run.threadId,
        taskText: record?.text ?? run.spec.goal,
        status: record?.status ?? (run.state === "queued" ? "queued" : "working"),
        startedAt: run.startedAt,
        ...(record?.summary ? { summary: record.summary } : {}),
      });
    }
    return out;
  }

  /** Safety-gate context for a subagent session. */
  contextFor(sessionId: string): GateContext | undefined {
    const run = this.bySession.get(sessionId);
    if (!run) return undefined;
    const text = this.options.records.get(run.taskId)?.text;
    return {
      taskId: run.taskId,
      threadId: run.threadId,
      ...(text ? { taskText: text } : {}),
      ...(run.lastText ? { rationale: truncate(run.lastText, 1_000) } : {}),
      ...(run.workspace ? { workspaceDir: run.workspace.dir } : {}),
    };
  }

  async spawn(spec: SubagentSpec): Promise<SpawnResult> {
    if (this.stopped) throw new ToolInputError("The agent is shutting down.");
    const task = this.options.board.require(spec.taskId);
    const existing = this.runs.get(spec.taskId);
    if (existing && existing.state !== "idle") {
      throw new ToolInputError(
        "A subagent is already working on this task. Use message_subagent to steer it or cancel_subagent to stop it.",
      );
    }
    this.options.records.setSpec(spec);
    const thread = this.options.board.ensureThread(task.taskId);
    if (existing && sameCapabilities(existing.spec.capabilities, spec.capabilities)) {
      existing.spec = spec;
      existing.pending = { kind: "kickoff", reassignment: true, retry: false };
      return this.request(existing, true);
    }
    if (existing) await this.close(existing);
    const run = this.createRun(spec, thread.id);
    run.needsHistory = hasHistory(thread);
    run.pending = { kind: "kickoff", reassignment: false, retry: false };
    this.runs.set(spec.taskId, run);
    return this.request(run, false);
  }

  /**
   * Delivers a message to the task's subagent: steers it while running, resumes it when finished.
   * Returns false when the task has no subagent.
   */
  async message(taskId: string, text: string, source: SteerSource): Promise<boolean> {
    const run = this.runs.get(taskId);
    if (!run || run.closed) return false;
    const wrapped = formatSteerMessage(source, text);
    if (run.state === "idle") {
      run.pending = { kind: "message", text: wrapped };
      this.request(run, true);
      return true;
    }
    if (run.state === "running" && run.session?.isRunning) {
      try {
        await run.session.steer(wrapped);
        if (run.sessionId) this.options.journal?.recordPrompt(run.threadId, run.sessionId, wrapped);
        return true;
      } catch (error) {
        this.logger.warn("Steering failed; delivering with the next turn", {
          taskId,
          error: errorMessage(error),
        });
      }
    }
    run.inbox.push(wrapped);
    return true;
  }

  /** Stops the task's subagent. Returns true when active work was cancelled. */
  async cancel(taskId: string, reason: string): Promise<boolean> {
    const run = this.runs.get(taskId);
    const record = this.options.records.get(taskId);
    const active =
      (run !== undefined && run.state !== "idle") ||
      (record !== undefined && isActiveTaskStatus(record.status));
    if (run) await this.close(run);
    this.cancelApprovals(taskId, reason);
    if (active) {
      this.options.board.setStatus(taskId, "cancelled", { summary: "Cancelled", note: reason });
    }
    this.options.onChange();
    this.pump();
    return active;
  }

  /** Disposes the task's subagent without touching its status (e.g. the task was deleted). */
  async discard(taskId: string): Promise<void> {
    const run = this.runs.get(taskId);
    if (run) await this.close(run);
  }

  /** Starts over with a fresh session primed with the thread's history. */
  async retry(taskId: string): Promise<SpawnResult> {
    const task = this.options.board.require(taskId);
    const existing = this.runs.get(taskId);
    const spec: SubagentSpec = existing?.spec ??
      this.options.records.getSpec(taskId) ?? {
        taskId,
        goal: task.text,
        capabilities: ["web"],
      };
    if (existing) await this.close(existing);
    this.cancelApprovals(taskId, "The task is being retried.");
    const thread = this.options.board.ensureThread(taskId);
    const run = this.createRun(spec, thread.id);
    run.needsHistory = hasHistory(thread);
    run.pending = { kind: "kickoff", reassignment: false, retry: true };
    this.runs.set(taskId, run);
    this.options.board.setStatus(taskId, "working", { summary: "Retrying…", note: "Retrying" });
    return this.request(run, false);
  }

  /**
   * Picks up a task whose run the agent stopped in the middle of (a restart, a handover): a new
   * session restored from `transcript` (the journal's record of the last session) continues it.
   * Without a transcript it's primed with the thread's history instead. Null when there's no
   * spec to run, or the task already has a subagent.
   */
  resume(
    taskId: string,
    restored: { transcript: readonly TranscriptEntry[]; sessionId?: string } = { transcript: [] },
  ): SpawnResult | null {
    if (this.stopped || this.runs.has(taskId)) return null;
    const spec = this.options.records.getSpec(taskId);
    if (!spec) return null;
    const thread = this.options.board.ensureThread(taskId);
    const run = this.createRun(spec, thread.id);
    const { transcript } = restored;
    run.needsHistory = transcript.length === 0 && hasHistory(thread);
    run.pending = {
      kind: "resume",
      transcript,
      ...(transcript.length > 0 && restored.sessionId ? { sessionId: restored.sessionId } : {}),
    };
    this.runs.set(taskId, run);
    return this.request(run, true);
  }

  /** Starts queued work when slots are free (call after the concurrency limit changes). */
  pump(): void {
    while (this.queue.length > 0 && this.runningCount() < this.maxConcurrent()) {
      const run = this.queue.shift()!;
      if (run.closed || run.state !== "queued") continue;
      this.launch(run);
    }
  }

  /**
   * Aborts everything. Work in progress keeps its status, so the next start (here, or on the
   * device taking the agent over) picks it back up from the journal; its pending approvals are
   * cancelled (the resumed run asks again).
   */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(
      [...this.runs.values()].map(async (run) => {
        const interrupted = run.state !== "idle";
        await this.close(run, "Interrupted");
        if (interrupted) this.cancelApprovals(run.taskId, "The agent stopped.");
      }),
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private createRun(spec: SubagentSpec, threadId: string): Run {
    return {
      taskId: spec.taskId,
      threadId,
      spec,
      author: authorFor(spec.capabilities),
      state: "idle",
      closed: false,
      controller: new AbortController(),
      inbox: [],
      needsHistory: false,
      lastText: "",
      turn: freshTurn(),
      streams: new Map(),
      toolMessages: new Map(),
      toolLabels: new Map(),
      startedAt: null,
      lastActiveAt: this.now(),
    };
  }

  private request(run: Run, resumed: boolean): SpawnResult {
    if (this.runningCount() < this.maxConcurrent()) {
      this.launch(run);
      return { threadId: run.threadId, status: "working", resumed };
    }
    run.state = "queued";
    if (!this.queue.includes(run)) this.queue.push(run);
    this.options.board.setStatus(run.taskId, "queued", { summary: "Queued" });
    this.options.onChange();
    return { threadId: run.threadId, status: "queued", resumed };
  }

  private launch(run: Run): void {
    run.state = "starting";
    run.startedAt = this.now();
    const record = this.options.records.get(run.taskId);
    const keepSummary = record?.status === "triaging" || record?.status === "working";
    this.options.board.setStatus(run.taskId, "working", keepSummary ? {} : { summary: "Working…" });
    this.options.onChange();
    void this.execute(run).catch((error) => {
      this.logger.error("Subagent run crashed", { taskId: run.taskId, error: errorMessage(error) });
    });
  }

  private async execute(run: Run): Promise<void> {
    run.turn = freshTurn();
    try {
      if (run.session && run.sessionHarness !== this.options.harness()) {
        await this.disposeSession(run);
        run.needsHistory = true;
      }
      let history: string | undefined;
      const fresh = !run.session;
      if (fresh) {
        if (run.needsHistory) {
          const thread = this.options.threads.get(run.threadId);
          history = thread
            ? buildThreadHistory(thread, this.options.records.get(run.taskId)?.status)
            : undefined;
        }
        try {
          await this.openSession(run);
        } catch (error) {
          if (run.pending?.kind === "resume") run.turn.resumeFailed = true;
          throw error;
        }
        run.needsHistory = false;
      }
      if (run.closed || !run.session) return;
      const prompt = await this.buildPrompt(run, fresh, history || undefined);
      if (run.closed || !run.session) return;
      run.state = "running";
      this.options.onChange();
      await this.prompt(run, run.session, prompt);
      if (!run.closed && needsNudge(run.turn)) {
        run.turn.nudged = true;
        await this.prompt(run, run.session, FINISH_NUDGE);
      }
    } catch (error) {
      if (!run.closed) run.turn.error = errorMessage(error);
    }
    if (!run.closed) this.complete(run);
  }

  /** Prompts the session, journaling the prompt first (a restart rebuilds the session from it). */
  private prompt(run: Run, session: HarnessSession, text: string): Promise<void> {
    if (run.sessionId) this.options.journal?.recordPrompt(run.threadId, run.sessionId, text);
    return session.prompt(text);
  }

  private complete(run: Run): void {
    const { turn } = run;
    const board = this.options.board;
    let status: TaskAgentStatus;
    if (turn.error && turn.resumeFailed) {
      status = "failed";
      board.setStatus(run.taskId, "failed", {
        summary: "Interrupted",
        note: `Couldn't pick this back up after the agent restarted (${truncate(turn.error, 300)}). Use Retry to continue.`,
      });
    } else if (turn.error) {
      status = "failed";
      board.setStatus(run.taskId, "failed", {
        summary: `Failed: ${truncate(turn.error, 50)}`,
        note: `The subagent stopped with an error: ${truncate(turn.error, 1_000)}`,
      });
    } else if (turn.finishStatus) {
      status = turn.finishStatus;
    } else if (turn.askedUser) {
      status = "waiting_user";
    } else {
      status = "done";
      board.setStatus(run.taskId, "done", { summary: badgeFrom(turn.finalText) || "Done" });
    }
    run.state = "idle";
    run.startedAt = null;
    run.lastActiveAt = this.now();
    this.options.onChange();
    if (run.inbox.length > 0) {
      // Messages arrived as the turn ended: continue right away.
      run.pending = { kind: "message", text: run.inbox.splice(0).join("\n\n") };
      this.request(run, true);
    } else {
      this.pump();
      this.trimIdleSessions();
    }
    const summary = this.options.records.get(run.taskId)?.summary;
    try {
      this.options.onFinished({
        taskId: run.taskId,
        threadId: run.threadId,
        status,
        ...(summary ? { summary } : {}),
        ...(turn.changed !== undefined ? { changed: turn.changed } : {}),
      });
    } catch (error) {
      this.logger.error("onFinished listener failed", { error: errorMessage(error) });
    }
  }

  private async close(run: Run, reason = "Cancelled"): Promise<void> {
    if (run.closed) return;
    run.closed = true;
    if (this.runs.get(run.taskId) === run) this.runs.delete(run.taskId);
    this.queue = this.queue.filter((r) => r !== run);
    run.controller.abort();
    this.finalizeStreams(run, reason);
    await this.disposeSession(run);
    this.options.onChange();
  }

  private async openSession(run: Run): Promise<void> {
    const harness = this.options.harness();
    if (!harness) throw new Error("The agent harness is unavailable.");
    run.workspace ??= await this.options.execution.prepareWorkspace(run.threadId);
    const task = this.options.board.describe(run.taskId);
    const tools = await this.buildTools(run, task);
    const resume = run.pending?.kind === "resume" ? run.pending : undefined;
    // A restored session keeps its id: its journal is one conversation across restarts.
    const sessionId = resume?.sessionId ?? this.nextSessionId(run);
    if (resume?.sessionId) this.usedSessionIds.add(run.threadId);
    const capabilities = run.spec.capabilities;
    this.bySession.set(sessionId, run);
    let session: HarnessSession;
    try {
      session = await harness.createSession({
        sessionId,
        role: "subagent",
        systemPrompt: buildSubagentSystemPrompt({ now: this.now(), capabilities }),
        tools,
        model: agentModel(this.options.getSettings().agent),
        thinking: "medium",
        cwd: run.workspace.dir,
        builtinTools: {
          files: capabilities.includes("files"),
          shell: capabilities.includes("shell") ? this.options.execution.shell : undefined,
        },
        beforeToolCall: this.options.beforeToolCall,
        onEvent: (event) => this.onEvent(run, event),
        signal: run.controller.signal,
        ...(resume?.transcript.length ? { transcript: resume.transcript } : {}),
      });
    } catch (error) {
      this.bySession.delete(sessionId);
      throw error;
    }
    if (run.closed) {
      this.bySession.delete(sessionId);
      await session.dispose().catch(() => {});
      return;
    }
    run.session = session;
    run.sessionHarness = harness;
    run.sessionId = sessionId;
  }

  /** Never rejects: disposal problems are logged. */
  private async disposeSession(run: Run): Promise<void> {
    const session = run.session;
    run.session = undefined;
    run.sessionHarness = undefined;
    if (run.sessionId) this.bySession.delete(run.sessionId);
    run.sessionId = undefined;
    try {
      if (session) {
        await session.abort().catch(() => {});
        await session.dispose();
      }
      const browser = this.options.execution.browser;
      if (browser?.has(run.threadId)) await browser.close(run.threadId);
    } catch (error) {
      this.logger.warn("Failed to release subagent resources", {
        taskId: run.taskId,
        error: errorMessage(error),
      });
    }
  }

  private trimIdleSessions(): void {
    const idle = [...this.runs.values()]
      .filter((run) => run.state === "idle" && run.session)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    while (idle.length > this.maxIdleSessions) {
      const run = idle.shift()!;
      run.needsHistory = true;
      void this.disposeSession(run);
    }
  }

  private nextSessionId(run: Run): string {
    const thread = this.options.threads.get(run.threadId);
    const used =
      this.usedSessionIds.has(run.threadId) ||
      (thread?.messages.some((m) => m.author.startsWith("subagent:")) ?? false);
    const id = used
      ? `${run.threadId}-${this.now().toString(36)}${createId(undefined, 3)}`
      : run.threadId;
    this.usedSessionIds.add(run.threadId);
    return id;
  }

  private async buildPrompt(
    run: Run,
    fresh: boolean,
    history: string | undefined,
  ): Promise<string> {
    const pending = run.pending;
    run.pending = undefined;
    const inbox = run.inbox.splice(0);
    if (pending?.kind === "resume" && pending.transcript.length > 0) {
      return [RESUME_NOTE, ...inbox].join("\n\n");
    }
    if (fresh || pending?.kind === "kickoff" || pending?.kind === "resume") {
      const task = this.options.board.describe(run.taskId);
      const record = this.options.records.get(run.taskId);
      const routine = this.options.routineBrief?.(run.taskId);
      const text = task?.text ?? record?.text ?? run.spec.goal;
      const notes = task?.notes ?? [];
      const drawings = routine ? [] : await this.describeDrawings([text, ...notes].join("\n"));
      const uncertain = (this.options.journal?.interruptedCalls(run.threadId) ?? [])
        .filter((call) => call.effectful)
        .map((call) => call.target);
      return buildSubagentKickoff({
        ...(uncertain.length > 0 ? { uncertain } : {}),
        now: this.now(),
        ...(routine ? { routine } : {}),
        task: {
          text,
          notes,
          notePath: task?.notePath ?? record?.notePath ?? "",
          date: task?.date ?? record?.date ?? null,
        },
        ...(drawings.length > 0 ? { drawings } : {}),
        goal: run.spec.goal,
        ...(run.spec.instructions ? { instructions: run.spec.instructions } : {}),
        ...(history ? { history } : {}),
        followUps: pending?.kind === "message" ? [pending.text, ...inbox] : inbox,
        reassignment: !fresh && pending?.kind === "kickoff" && pending.reassignment,
        retry: pending?.kind === "kickoff" && pending.retry,
        ...(pending?.kind === "resume" ? { resumed: true } : {}),
      });
    }
    return [pending?.kind === "message" ? pending.text : "", ...inbox]
      .filter((part) => part.length > 0)
      .join("\n\n");
  }

  private async describeDrawings(text: string): Promise<string[]> {
    const drawings = this.options.drawings;
    if (!drawings) return [];
    try {
      return (await drawings.blocks(text, drawingBudget())).flatMap((block) => block.lines);
    } catch (error) {
      this.logger.warn("Could not describe the task's drawings", { error: errorMessage(error) });
      return [];
    }
  }

  private async buildTools(run: Run, task: TaskRef | undefined): Promise<ToolSpec[]> {
    const capabilities = run.spec.capabilities;
    const routine = this.options.routineBrief?.(run.taskId);
    const tools: ToolSpec[] = [
      ...createThreadTools(this.threadHost(run), routine ? { routineRun: true } : {}),
      ...(this.options.taskTools?.(run.taskId) ?? []),
      ...this.options.knowledgeTools(),
    ];
    if (capabilities.includes("web")) tools.push(...this.options.webTools());
    try {
      tools.push(
        ...this.options.executionTools(this.options.execution, {
          threadId: run.threadId,
          taskId: run.taskId,
          workspace: run.workspace!,
          capabilities,
          onFrame: (surface, frame) => this.options.onFrame(run.threadId, surface, frame),
          ...(this.options.isWatched
            ? { watching: (surface) => this.options.isWatched!(run.threadId, surface) }
            : {}),
        }),
      );
    } catch (error) {
      this.logger.warn("Execution tools unavailable", { error: errorMessage(error) });
    }
    if (capabilities.includes("connectors") && this.options.connectors) {
      try {
        tools.push(...(await this.options.connectors.getTools()));
      } catch (error) {
        this.logger.warn("Connector tools unavailable", { error: errorMessage(error) });
      }
    }
    if (this.options.extraTools && task) tools.push(...this.options.extraTools(run.spec, task));
    const unique = new Map<string, ToolSpec>();
    for (const tool of tools) if (!unique.has(tool.name)) unique.set(tool.name, tool);
    run.toolLabels = new Map([...unique.values()].map((tool) => [tool.name, tool.label]));
    return [...unique.values()];
  }

  private threadHost(run: Run): ThreadToolHost {
    const { board, threads, records } = this.options;
    return {
      postUpdate: ({ text, summary }) => {
        board.postAgentText(run.taskId, run.author, text);
        if (summary) board.setSummary(run.taskId, summary);
      },
      askUser: ({ question }) => {
        board.postAgentText(run.taskId, run.author, question);
        run.turn.askedUser = true;
        board.setStatus(run.taskId, "waiting_user", {
          summary: badgeFrom(`Question: ${question}`),
        });
      },
      createArtifact: async (input) => {
        const meta = await threads.addArtifact(run.threadId, {
          title: input.title,
          kind: input.kind,
          mimeType: defaultMimeType(input.kind),
          ...(input.language ? { language: input.language } : {}),
          content: input.content,
        });
        threads.upsertMessage(run.threadId, {
          id: createId("msg"),
          kind: "artifact",
          author: run.author,
          artifactId: meta.id,
          createdAt: this.now(),
        });
        records.bumpUnread(run.taskId);
        return meta;
      },
      finish: ({ status, summary, shortSummary, changed }) => {
        board.postAgentText(run.taskId, run.author, summary);
        const mapped: TaskAgentStatus = status === "needs_user" ? "waiting_user" : status;
        run.turn.finishStatus = mapped;
        if (changed !== undefined) run.turn.changed = changed;
        board.setStatus(run.taskId, mapped, {
          summary: shortSummary ?? (badgeFrom(summary) || null),
        });
      },
    };
  }

  // ── Harness events → thread ───────────────────────────────────────────────

  private onEvent(run: Run, event: HarnessEvent): void {
    if (run.closed) return;
    run.lastActiveAt = this.now();
    try {
      this.applyEvent(run, event);
    } catch (error) {
      this.logger.error("Failed to apply harness event", {
        taskId: run.taskId,
        type: event.type,
        error: errorMessage(error),
      });
    }
  }

  private applyEvent(run: Run, event: HarnessEvent): void {
    const { threads } = this.options;
    switch (event.type) {
      case "text_delta": {
        let stream = run.streams.get(event.messageId);
        if (!stream) {
          stream = { id: createId("msg"), text: "", createdAt: this.now(), posted: false };
          run.streams.set(event.messageId, stream);
        }
        stream.text += event.delta;
        if (!stream.posted) {
          // Leading whitespace alone doesn't open a message bubble.
          if (stream.text.trim() === "") return;
          stream.posted = true;
          threads.upsertMessage(run.threadId, {
            id: stream.id,
            kind: "text",
            role: "agent",
            author: run.author,
            text: stream.text,
            streaming: true,
            createdAt: stream.createdAt,
          });
          return;
        }
        threads.appendDelta(run.threadId, stream.id, event.delta);
        return;
      }
      case "message_end": {
        const stream = run.streams.get(event.messageId);
        run.streams.delete(event.messageId);
        const text = (event.text || stream?.text || "").trim();
        run.turn.finalText = text;
        if (text) run.lastText = text;
        if (!text) {
          if (stream?.posted) this.finalizeStream(run, stream, stream.text.trim());
          return;
        }
        if (stream?.posted) this.finalizeStream(run, stream, text);
        else {
          threads.upsertMessage(run.threadId, {
            id: stream?.id ?? createId("msg"),
            kind: "text",
            role: "agent",
            author: run.author,
            text,
            createdAt: stream?.createdAt ?? this.now(),
          });
        }
        return;
      }
      case "tool_start": {
        if (THREAD_TOOL_NAMES.has(event.toolName)) return;
        const label = run.toolLabels.get(event.toolName);
        const message: ToolCallMessage = {
          id: createId("msg"),
          kind: "tool_call",
          author: run.author,
          createdAt: this.now(),
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(label ? { label } : {}),
          input: sanitizeForDisplay(event.input),
          status: "running",
        };
        run.toolMessages.set(event.toolCallId, message);
        threads.upsertMessage(run.threadId, message);
        return;
      }
      case "tool_end": {
        if (THREAD_TOOL_NAMES.has(event.toolName)) {
          if (event.isError) {
            this.logger.debug("Thread tool call failed", {
              tool: event.toolName,
              blocked: event.blocked ?? false,
            });
          }
          return;
        }
        const started = run.toolMessages.get(event.toolCallId);
        run.toolMessages.delete(event.toolCallId);
        const preview = previewText(toolResultText(event.result), 300);
        const label = run.toolLabels.get(event.toolName);
        threads.upsertMessage(run.threadId, {
          ...(started ?? {
            id: createId("msg"),
            kind: "tool_call",
            author: run.author,
            createdAt: this.now(),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ...(label ? { label } : {}),
            input: undefined,
          }),
          status: event.blocked ? "blocked" : event.isError ? "error" : "ok",
          ...(preview ? { resultPreview: preview } : {}),
          endedAt: this.now(),
        });
        return;
      }
      case "error":
        run.turn.error = event.message;
        return;
      default:
        return;
    }
  }

  private finalizeStream(run: Run, stream: StreamState, text: string): void {
    this.options.threads.upsertMessage(run.threadId, {
      id: stream.id,
      kind: "text",
      role: "agent",
      author: run.author,
      text,
      createdAt: stream.createdAt,
    });
  }

  /** Closes streaming bubbles and running tool rows, e.g. when a run is cancelled. */
  private finalizeStreams(run: Run, reason: string): void {
    for (const stream of run.streams.values()) {
      if (stream.posted) this.finalizeStream(run, stream, stream.text.trim());
    }
    run.streams.clear();
    for (const message of run.toolMessages.values()) {
      this.options.threads.upsertMessage(run.threadId, {
        ...message,
        status: "error",
        resultPreview: reason,
        endedAt: this.now(),
      });
    }
    run.toolMessages.clear();
  }

  private cancelApprovals(taskId: string, reason: string): void {
    try {
      this.options.approvals().cancelForTask(taskId, reason);
    } catch (error) {
      this.logger.warn("Failed to cancel approvals", { taskId, error: errorMessage(error) });
    }
  }

  private maxConcurrent(): number {
    return Math.max(1, Math.floor(this.options.getSettings().agent.maxConcurrentSubagents));
  }
}

function freshTurn(): TurnState {
  return { askedUser: false, finalText: "", nudged: false };
}

function needsNudge(turn: TurnState): boolean {
  return !turn.error && !turn.finishStatus && !turn.askedUser && !turn.finalText && !turn.nudged;
}

function sameCapabilities(a: readonly Capability[], b: readonly Capability[]): boolean {
  return a.length === b.length && a.every((c) => b.includes(c));
}

/** Earlier work worth replaying to a fresh session (not just the orchestrator's acknowledgment). */
function hasHistory(thread: Thread): boolean {
  return thread.messages.some(
    (m) =>
      m.kind === "tool_call" ||
      m.kind === "artifact" ||
      (m.kind === "text" && (m.role === "user" || m.author.startsWith("subagent:"))),
  );
}

export function authorFor(capabilities: readonly Capability[]): MessageAuthor {
  if (capabilities.includes("browser")) return "subagent:browser";
  if (capabilities.includes("computer")) return "subagent:operator";
  if (capabilities.includes("shell") || capabilities.includes("files")) return "subagent:builder";
  if (capabilities.includes("connectors")) return "subagent:assistant";
  if (capabilities.includes("web")) return "subagent:researcher";
  return "subagent:assistant";
}

/** A one-line badge from markdown: first non-empty line without markup, at most 60 chars. */
export function badgeFrom(markdown: string): string {
  const line =
    markdown
      .split("\n")
      .map((l) =>
        l
          .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[.\]\s+)?|\d+[.)]\s+)*/, "")
          .replace(/[*_`~]/g, "")
          .trim(),
      )
      .find((l) => l.length > 0) ?? "";
  return truncate(line, 60);
}
