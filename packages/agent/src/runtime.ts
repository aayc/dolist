import {
  type AgentMode,
  type AgentStatusResponse,
  type ApprovalDecisionRequest,
  type ApprovalRequest,
  type ApprovalStatus,
  type AppSettings,
  type ArtifactMeta,
  agentModel,
  type CreateRoutineRequest,
  createId,
  dailyNotePath,
  Emitter,
  isOrchestratorThread,
  type Logger,
  type Routine,
  type RoutineRunResponse,
  resolveLineAnchors,
  type SurfaceKind,
  silentLogger,
  type TaskAgentRecord,
  type TaskAgentStatus,
  type Thread,
  type ThreadSummary,
  type ToolSpec,
  today,
  truncate,
  type Unsubscribe,
} from "@ddl/core";
import { createExecutionTools } from "./execution";
import { ComputerStatusMonitor } from "./execution/computer-status";
import type { Capability, ExecutionToolFactory, FrameListener } from "./execution/types";
import type { CursorCliStatus } from "./harness/cursor/cli";
import { type HarnessSetupContext, setupHarness } from "./harness/registry";
import { ScriptedHarness } from "./harness/scripted";
import type { Harness, ToolCallDecision, ToolCallRequest } from "./harness/types";
import { checkOpenRouterKey, type OpenRouterKeyCheck } from "./llm/openrouter";
import type { LlmClient } from "./llm/types";
import { OrchestratorChat } from "./orchestrator/chat";
import { createMockScript } from "./orchestrator/mock-script";
import { Orchestrator } from "./orchestrator/orchestrator";
import { TaskRecords } from "./orchestrator/records";
import { badgeFrom, SubagentManager } from "./orchestrator/subagents";
import { TaskBoard } from "./orchestrator/task-board";
import { TaskWatcher } from "./orchestrator/task-watcher";
import type { DigestCapabilities, DigestRoutine } from "./prompts/orchestrator";
import { RoutineLibrary } from "./routines/library";
import { isRoutineRunId, RoutineScheduler } from "./routines/scheduler";
import { createRoutineHost } from "./routines/tool-host";
import type { AgentRuntime, AgentRuntimeEvents, AgentRuntimeOptions } from "./runtime-types";
import {
  createApprovalBroker,
  createSafetyEvaluator,
  createSafetyGate,
  effectivePolicy,
  isLooserPolicy,
  POLICY_APPROVAL_NOTE,
  policyAsks,
} from "./safety";
import type {
  AllowedCall,
  ApprovalBroker,
  ApprovalBrokerOptions,
  ApprovalOutcome,
  GateContext,
  NewApproval,
  SafetyEvaluator,
  SafetyEvaluatorOptions,
  SafetyGate,
  SafetyGateOptions,
} from "./safety/types";
import type { OpenToolCall } from "./threads/journal/fold";
import { journalingHarness } from "./threads/journal/tool-ledger";
import { buildTranscript } from "./threads/journal/transcript";
import { SourceCatalog } from "./threads/sources";
import { createThreadStore } from "./threads/store";
import type { JournaledThreadStore } from "./threads/types";
import { TOOL } from "./tools/contracts";
import { createKnowledgeTools } from "./tools/knowledge";
import { categoryForVerb, createMockIrreversibleActionTool, riskyVerb } from "./tools/mock";
import { createNoteEditTool, type NoteEditHost } from "./tools/notes";
import { createRoutineTools } from "./tools/routines";

/** Editor activity warms the harness (`warmUp`) at most this often. */
const WARM_UP_INTERVAL_MS = 5_000;

/** A subagent was on it (or about to be) when the agent stopped. */
const RESUMABLE_STATUSES: ReadonlySet<TaskAgentStatus> = new Set([
  "queued",
  "working",
  "waiting_approval",
]);

/** Seams for tests and embedders; production callers pass nothing. */
export interface AgentRuntimeOverrides {
  createSafetyEvaluator?: (options: SafetyEvaluatorOptions) => SafetyEvaluator;
  createApprovalBroker?: (options: ApprovalBrokerOptions) => ApprovalBroker;
  createSafetyGate?: (options: SafetyGateOptions) => SafetyGate;
  createExecutionTools?: ExecutionToolFactory;
  /** Live-mode web tools (default: `createWebTools` from `./tools/web`). */
  createWebTools?: (options: { llm?: LlmClient; logger?: Logger }) => ToolSpec[];
  /** Orchestrator batching window. Default 150ms. */
  batchWindowMs?: number;
  /** Delay before a subagent report is sent to the orchestrator. Default 1500ms. */
  reportDelayMs?: number;
  /** An orchestrator turn taking longer is aborted and its tasks fail. Default 180s. */
  turnTimeoutMs?: number;
  /** A routine run stops after this much working time. Default 15 minutes. */
  maxRoutineRunMs?: number;
  /** Word delay of the default mock harness. Default 15ms (visible streaming). */
  mockWordDelayMs?: number;
  /** See `TaskWatcherOptions.quickSettleMs`. */
  quickSettleMs?: number;
  /** Live-mode API key verification (default: `checkOpenRouterKey`). */
  checkApiKey?: (apiKey: string) => Promise<OpenRouterKeyCheck>;
  /** Live-mode Cursor CLI check for the Cursor harness (default: `agent status`). */
  checkCursorCli?: () => Promise<CursorCliStatus>;
  /**
   * Live-mode OpenRouter key and endpoint for the harness and the key check. Defaults:
   * `OPENROUTER_API_KEY` and `DDL_OPENROUTER_BASE_URL` (unset: OpenRouter itself).
   */
  openRouter?: { apiKey?: string; baseUrl?: string };
  /**
   * Give live-mode subagents the simulated `mock_irreversible_action` tool for risky tasks, as in
   * mock mode (for running the real harness against a fake model). Default: `DDL_AGENT_MOCK_ACTIONS=1`.
   */
  mockActions?: boolean;
}

/** The thread id passed to a runtime method does not exist. */
export class UnknownThreadError extends Error {
  readonly threadId: string;

  constructor(threadId: string) {
    super(`Unknown thread: ${threadId}`);
    this.name = "UnknownThreadError";
    this.threadId = threadId;
  }
}

/** The agent cannot act right now (mode off, missing API key, safety system down…). */
export class AgentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

/**
 * Creates the agent runtime and loads persisted threads/records (call `start()` to begin
 * watching). Never throws for configuration problems: the runtime starts degraded and explains the
 * fix in `status().problem`.
 */
export async function createAgentRuntime(
  options: AgentRuntimeOptions,
  overrides: AgentRuntimeOverrides = {},
): Promise<AgentRuntime> {
  const runtime = new Runtime(options, overrides);
  await runtime.init();
  return runtime;
}

type RuntimeEventMap = { [K in keyof AgentRuntimeEvents]: AgentRuntimeEvents[K] };

const OFF_PROBLEM =
  "The agent is off (DDL_AGENT_MODE=off). Restart the daemon in live or mock mode to enable it.";

class Runtime implements AgentRuntime {
  readonly mode: AgentMode;
  private readonly options: AgentRuntimeOptions;
  private readonly overrides: AgentRuntimeOverrides;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly emitter = new Emitter<RuntimeEventMap>();
  private readonly threads: JournaledThreadStore;
  /** How the gate allowed each call in flight (`sessionId\0toolCallId`), for the journal. */
  private readonly allowedCalls = new Map<string, AllowedCall>();
  /** Each harness with the journal's tool call records around its sessions (one per harness). */
  private readonly journaledHarnesses = new WeakMap<Harness, Harness>();
  private readonly records: TaskRecords;
  private readonly watcher: TaskWatcher;
  private readonly board: TaskBoard;
  private readonly subagents: SubagentManager;
  private readonly orchestrator: Orchestrator;
  /** The orchestrator's own chat (`ORCHESTRATOR_THREAD_ID`). */
  private readonly chat: OrchestratorChat;
  /** Routine files joined with the scheduler's state. */
  private readonly routines: RoutineLibrary;
  /** Starts routine runs; active only while the agent runs and is enabled. */
  private readonly scheduler: RoutineScheduler;
  private readonly knowledgeTools: ToolSpec[];
  /** `edit_note`, shared by the orchestrator and every subagent. */
  private readonly noteEditTool: ToolSpec;
  private readonly sourceCatalog = new SourceCatalog();
  /** Computer permissions (for the status) and desktop apps (for the digest), cached. */
  private readonly computerStatus: ComputerStatusMonitor;
  /** Anchors whose line is gone, removed unless it comes back (an edit in progress) in time. */
  private readonly missingAnchors = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly surfaceSubscribers = new Map<string, number>();
  private readonly approvalMessages = new Set<string>();
  private readonly disposers: Unsubscribe[] = [];
  private broker: ApprovalBroker;
  private evaluator: SafetyEvaluator | null = null;
  private gate: SafetyGate | null = null;
  private harness: Harness | null = null;
  /** Replaced harnesses whose sessions may still be running; disposed on stop. */
  private readonly retiredHarnesses = new Set<Harness>();
  private harnessSetups = 0;
  private webTools: ToolSpec[] = [];
  /** create_routine, update_routine, run_routine, list_routines (the orchestrator's). */
  private readonly routineTools: ToolSpec[];
  private settings: AppSettings;
  private enabled: boolean;
  /** Why the agent cannot run at all (configuration). */
  private problem: string | undefined;
  /** Why the configured harness cannot run (e.g. no API key, Cursor CLI not signed in). */
  private harnessProblem: string | undefined;
  /** The last orchestrator turn failed (cleared by the next successful turn). */
  private turnProblem: string | undefined;
  private started = false;
  private stopped = false;
  /** The first harness setup, which `start()` waits for (see `init`). */
  private harnessReady: Promise<void> = Promise.resolve();
  /** OpenRouter rejected the key of `options.llm` (see `checkLlmKey`). */
  private llmRejected = false;
  /** One OpenRouter key check per key, shared by the Pi harness setup and `checkLlmKey`. */
  private readonly keyChecks = new Map<string, Promise<OpenRouterKeyCheck>>();
  private lastWarmUp = Number.NEGATIVE_INFINITY;
  private recoveredTriage = false;
  /** Tasks whose work was going when the agent last stopped: `start()` picks them back up. */
  private interruptedWork: string[] = [];
  private statusQueued = false;
  private lastStatusJson = "";

  constructor(options: AgentRuntimeOptions, overrides: AgentRuntimeOverrides) {
    this.options = options;
    this.overrides = overrides;
    this.mode = options.mode;
    this.settings = options.settings;
    this.enabled = options.settings.agent.enabled;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
    const { storage } = options;
    const now = this.now;

    this.broker = this.createBroker();
    this.computerStatus = new ComputerStatusMonitor(options.execution, {
      now,
      onChange: () => this.queueStatus(),
      logger: this.logger.child({ component: "computer-status" }),
    });
    this.threads = createThreadStore({
      storage,
      now,
      ...(options.leaseEpoch ? { epoch: options.leaseEpoch } : {}),
      logger: this.logger.child({ component: "threads" }),
      pendingApprovals: (threadId) =>
        this.safely(() => this.broker.list({ threadId, status: "pending" }).length, 0),
    });
    this.records = new TaskRecords({
      storage,
      now,
      logger: this.logger.child({ component: "records" }),
    });
    this.watcher = new TaskWatcher({
      storage,
      settings: options.settings,
      now,
      logger: this.logger.child({ component: "watcher" }),
      ...(overrides.quickSettleMs !== undefined ? { quickSettleMs: overrides.quickSettleMs } : {}),
    });
    this.board = new TaskBoard({
      threads: this.threads,
      records: this.records,
      lookup: this.watcher,
      now,
      logger: this.logger,
    });
    this.knowledgeTools = createKnowledgeTools({ storage });
    const noteEditHost: NoteEditHost = {
      storage,
      locate: (taskId) => {
        if (isRoutineRunId(taskId)) return null;
        const found = this.watcher.findTask(taskId);
        if (found)
          return { notePath: found.notePath, line: found.task.line, text: found.task.text };
        const record = this.records.get(taskId);
        return record ? { notePath: record.notePath, line: record.line, text: record.text } : null;
      },
      threadFor: (taskId) => (taskId ? this.board.ensureThread(taskId).id : null),
      defaultNotePath: () => dailyNotePath(today(new Date(this.now())), this.settings.dailyNotes),
      waitForPause: (notePath) => this.watcher.waitForPause(notePath),
      onEdited: ({ threadId, lines }) => {
        if (threadId) this.attachSources(threadId, lines.join("\n"));
      },
    };
    this.noteEditTool = createNoteEditTool(noteEditHost);
    this.routines = new RoutineLibrary({
      storage,
      now,
      logger: this.logger.child({ component: "routines" }),
      liveRun: (runId) => {
        const record = this.records.get(runId);
        return record
          ? { status: record.status, ...(record.summary ? { summary: record.summary } : {}) }
          : undefined;
      },
    });
    const executionTools = overrides.createExecutionTools ?? createExecutionTools;
    this.subagents = new SubagentManager({
      harness: () => this.journaled(this.harness),
      board: this.board,
      threads: this.threads,
      journal: this.threads,
      records: this.records,
      approvals: () => this.broker,
      beforeToolCall: this.beforeToolCall,
      execution: options.execution,
      executionTools,
      ...(options.connectors ? { connectors: options.connectors } : {}),
      taskTools: (taskId) => [
        createNoteEditTool(
          noteEditHost,
          isRoutineRunId(taskId) ? { signAs: taskId } : { ownTask: taskId },
        ),
      ],
      knowledgeTools: () => this.knowledgeTools,
      webTools: () => this.webTools,
      ...(this.mode === "mock" ||
      (this.mode === "live" &&
        (overrides.mockActions ?? process.env.DDL_AGENT_MOCK_ACTIONS?.trim() === "1"))
        ? {
            extraTools: (_spec, task) => {
              const verb = riskyVerb(task.text);
              return verb ? [createMockIrreversibleActionTool(categoryForVerb(verb))] : [];
            },
          }
        : {}),
      getSettings: () => this.settings,
      onFrame: (threadId, surface, frame) => this.onFrame(threadId, surface, frame),
      isWatched: (threadId, surface) => this.surfaceSubscribers.has(surfaceKey(threadId, surface)),
      onFinished: (report) =>
        isRoutineRunId(report.taskId)
          ? this.scheduler.onSubagentFinished(report)
          : this.orchestrator.notifySubagentFinished(report),
      onChange: () => this.queueStatus(),
      routineBrief: (taskId) => this.scheduler.brief(taskId),
      now,
      logger: this.logger.child({ component: "subagents" }),
    });
    this.chat = new OrchestratorChat({
      threads: this.threads,
      now,
      logger: this.logger.child({ component: "orchestrator-chat" }),
    });
    this.orchestrator = new Orchestrator({
      harness: () => this.journaled(this.harness),
      board: this.board,
      records: this.records,
      subagents: this.subagents,
      lookup: this.watcher,
      beforeToolCall: this.beforeToolCall,
      tools: () => [
        ...this.knowledgeTools,
        this.noteEditTool,
        ...this.webTools,
        ...this.routineTools,
      ],
      routines: () => this.digestRoutines(),
      capabilities: () => this.capabilities(),
      getSettings: () => this.settings,
      cwd: options.home,
      now,
      logger: this.logger.child({ component: "orchestrator" }),
      ...(overrides.batchWindowMs !== undefined ? { batchWindowMs: overrides.batchWindowMs } : {}),
      ...(overrides.reportDelayMs !== undefined ? { reportDelayMs: overrides.reportDelayMs } : {}),
      ...(overrides.turnTimeoutMs !== undefined ? { turnTimeoutMs: overrides.turnTimeoutMs } : {}),
      onTurnResult: (error) => {
        this.turnProblem = error
          ? `The last orchestrator run failed: ${truncate(error, 300)}`
          : undefined;
        this.queueStatus();
      },
      chat: this.chat,
    });
    this.scheduler = new RoutineScheduler({
      library: this.routines,
      threads: this.threads,
      records: this.records,
      board: this.board,
      subagents: this.subagents,
      triage: (run) => this.orchestrator.handleRoutineRun(run),
      dropTriage: (runId) => this.orchestrator.dropQueued(runId),
      capabilities: () => this.capabilities().available,
      onNotification: (notification) => this.emitter.emit("routine.notification", notification),
      now,
      logger: this.logger.child({ component: "routine-scheduler" }),
      ...(overrides.maxRoutineRunMs !== undefined ? { maxRunMs: overrides.maxRoutineRunMs } : {}),
    });
    this.routineTools = createRoutineTools(
      createRoutineHost({
        library: this.routines,
        scheduler: this.scheduler,
        onChanged: () => this.scheduler.tick(),
      }),
    );
    this.wireEvents();
  }

  async init(): Promise<void> {
    await Promise.all([
      this.threads.load().catch((error: unknown) => {
        this.logger.error("Failed to load threads", { error: errorText(error) });
      }),
      this.records.load().catch((error: unknown) => {
        this.logger.error("Failed to load task records", { error: errorText(error) });
      }),
      this.routines.start().catch((error: unknown) => {
        this.logger.error("Failed to load routines", { error: errorText(error) });
      }),
    ]);
    this.safely(() => this.markInterruptedToolCalls(), undefined);
    this.reconcileAfterRestart();
    this.safely(() => this.scheduler.reconcileAfterRestart(), undefined);
    this.safely(() => this.chat.ensure(), undefined);
    if (this.mode === "off") {
      this.problem = OFF_PROBLEM;
      return;
    }
    this.setupSafety();
    // Checking the harness can take seconds (the Cursor CLI's `agent status`, an OpenRouter key
    // check), and the daemon listens only once the runtime exists: it runs meanwhile, and
    // `start()` waits for it before watching notes.
    this.harnessReady = Promise.all([this.setupHarness(), this.checkLlmKey()])
      .then(async () => {
        if (this.mode === "live") await this.setupWebTools();
        const problem = this.problem ?? this.harnessProblem;
        if (problem) this.logger.warn("Agent runtime degraded", { problem });
      })
      .catch((error: unknown) => this.logError("setupHarness", error));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    if (this.mode !== "off") void this.computerStatus.refresh();
    await this.harnessReady;
    if (this.stopped) return;
    await this.resumeInterruptedWork();
    if (this.canRun() && this.enabled) await this.startWatching();
    this.syncScheduler({ catchUp: true });
    this.queueStatus();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.scheduler.stop();
    this.routines.stop();
    this.computerStatus.stop();
    for (const timer of this.missingAnchors.values()) clearTimeout(timer);
    this.missingAnchors.clear();
    await this.watcher.stop().catch((error: unknown) => this.logError("watcher.stop", error));
    await this.orchestrator
      .stop()
      .catch((error: unknown) => this.logError("orchestrator.stop", error));
    await this.subagents.stop().catch((error: unknown) => this.logError("subagents.stop", error));
    this.harnessSetups++;
    const harnesses = [...this.retiredHarnesses, ...(this.harness ? [this.harness] : [])];
    this.retiredHarnesses.clear();
    await Promise.all(
      harnesses.map((harness) =>
        harness.dispose?.().catch((error: unknown) => this.logError("harness.dispose", error)),
      ),
    );
    // The broker persists with a debounce; unflushed approvals would vanish on restart while
    // their thread messages still point at them.
    const broker = this.broker as ApprovalBroker & { flush?: () => Promise<void> };
    await Promise.all([
      this.threads.flush(),
      this.records.flush(),
      this.routines.state.flush(),
      broker.flush?.(),
    ]).catch((error: unknown) => this.logError("flush", error));
    for (const dispose of this.disposers.splice(0)) this.safely(dispose, undefined);
    this.surfaceSubscribers.clear();
  }

  status(): AgentStatusResponse {
    const problem = this.problem ?? this.harnessProblem ?? this.turnProblem;
    const { connectors } = this.options;
    return {
      mode: this.mode,
      enabled: this.mode !== "off" && this.enabled,
      model: this.mode === "mock" ? "mock" : agentModel(this.settings.agent),
      running: this.subagents.runningCount(),
      queued: this.subagents.queuedCount(),
      pendingApprovals: this.safely(() => this.broker.list({ status: "pending" }).length, 0),
      connectors: this.safely(() => connectors?.status() ?? [], []),
      execution: this.executionStatus(),
      ...(problem ? { problem } : {}),
    };
  }

  private executionStatus(): AgentStatusResponse["execution"] {
    const { execution } = this.options;
    const access = this.mode === "off" ? undefined : this.computerStatus.current().access;
    return {
      provider: execution.id,
      capabilities: { ...execution.capabilities },
      ...(access ? { computerAccess: access } : {}),
    };
  }

  /** Pausing stops watching notes; running subagents and queued work continue unless cancelled. */
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (this.started && !this.stopped && this.canRun()) {
      if (enabled) await this.startWatching();
      else await this.watcher.stop();
    }
    // Turning the agent back on isn't missing runs: routines start again from their next slot.
    this.syncScheduler({ catchUp: false });
    this.queueStatus();
  }

  /** The scheduler runs exactly while the agent can act here and is enabled. */
  private syncScheduler(options: { catchUp: boolean }): void {
    if (this.started && !this.stopped && this.canRun() && this.enabled) {
      this.scheduler.activate(options);
    } else {
      this.scheduler.deactivate();
    }
  }

  updateSettings(settings: AppSettings): void {
    const previous = this.settings;
    this.settings = settings;
    this.watcher.updateSettings(settings);
    const agent = settings.agent;
    if (previous.agent.enabled !== agent.enabled) this.background(this.setEnabled(agent.enabled));
    if (previous.agent.maxConcurrentSubagents !== agent.maxConcurrentSubagents) {
      this.subagents.pump();
    }
    const judgeChanged = previous.agent.judgeModel !== agent.judgeModel && this.mode === "live";
    if (
      (judgeChanged || previous.agent.approvalTimeoutMs !== agent.approvalTimeoutMs) &&
      this.gate
    ) {
      this.setupSafety();
    }
    if (previous.agent.harness !== agent.harness && this.switchesHarness()) {
      this.background(this.switchHarness());
    }
    this.applyPolicyChange(previous.agent.approvalPolicy, agent.approvalPolicy);
    this.queueStatus();
  }

  /**
   * The gate reads the policy on every call, so a change applies to the next one. A looser policy
   * also approves what is already waiting and it would no longer ask about; a stricter one leaves
   * waiting approvals alone.
   */
  private applyPolicyChange(previous: unknown, next: unknown): void {
    const from = effectivePolicy(previous);
    const to = effectivePolicy(next);
    if (from === to) return;
    const approved = isLooserPolicy(to, from)
      ? this.safely(
          () =>
            this.broker.approvePending(
              ({ request, verdict }) => !policyAsks(to, { decision: verdict, risk: request.risk }),
              POLICY_APPROVAL_NOTE,
            ),
          [],
        )
      : [];
    this.logger.info("Approval policy changed", { from, to, approvedPending: approved.length });
  }

  noteEditorActivity(notePath: string, line: number): void {
    this.watcher.noteEditorActivity(notePath, line);
    if (this.watcher.watches(notePath)) this.warmUp();
  }

  /**
   * The user is typing in a watched note, so a task, and with it a prompt and maybe a new session,
   * may follow: resume the orchestrator's suspended session and prewarm a CLI now, while they type
   * and the task settles, instead of seconds after the task arrives.
   */
  private warmUp(): void {
    if (!this.enabled || !this.started || this.stopped) return;
    const now = this.now();
    if (now - this.lastWarmUp < WARM_UP_INTERVAL_MS) return;
    this.lastWarmUp = now;
    void this.harness?.prewarm?.();
    this.orchestrator.warm();
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  getTaskRecords(notePath: string): TaskAgentRecord[] {
    return this.records.list(notePath).filter((record) => !isRoutineRunId(record.taskId));
  }

  listThreads(filter?: {
    notePath?: string;
    taskId?: string;
    routineId?: string;
  }): ThreadSummary[] {
    return this.threads.list(filter);
  }

  listRoutines(): Routine[] {
    return this.routines.list();
  }

  getRoutine(id: string): Routine | undefined {
    return this.routines.get(id);
  }

  async createRoutine(input: CreateRoutineRequest): Promise<Routine> {
    const routine = await this.routines.create(input);
    this.scheduler.tick();
    return this.routines.get(routine.id) ?? routine;
  }

  async setRoutinePaused(id: string, paused: boolean): Promise<Routine> {
    const routine = await this.routines.setPaused(id, paused);
    this.scheduler.tick();
    return this.routines.get(routine.id) ?? routine;
  }

  async runRoutine(id: string): Promise<RoutineRunResponse> {
    if (!this.canRun() || this.stopped || !this.started) {
      throw new AgentUnavailableError(
        this.problem ?? this.harnessProblem ?? "The agent is not running.",
      );
    }
    if (!this.enabled) {
      throw new AgentUnavailableError("The agent is paused: switch it on to run routines.");
    }
    const { routineId, threadId } = this.scheduler.runNow(id);
    const routine = this.routines.get(routineId);
    if (!routine) throw new AgentUnavailableError("The routine disappeared while starting.");
    return { routine, threadId };
  }

  private digestRoutines(): DigestRoutine[] {
    return this.routines.list().map((routine) => ({
      name: routine.name,
      schedule: routine.scheduleText ?? routine.schedule,
      paused: routine.paused,
      ...(routine.error ? { error: routine.error } : {}),
    }));
  }

  getThread(id: string): { thread: Thread; approvals: ApprovalRequest[] } | undefined {
    const thread = this.threads.get(id);
    if (!thread) return undefined;
    return { thread, approvals: this.safely(() => this.broker.list({ threadId: id }), []) };
  }

  listApprovals(filter?: { status?: ApprovalStatus }): ApprovalRequest[] {
    return this.safely(() => this.broker.list(filter), []);
  }

  readArtifact(
    threadId: string,
    artifactId: string,
  ): Promise<{ meta: ArtifactMeta; body: Uint8Array } | null> {
    return this.threads.readArtifact(threadId, artifactId);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  async postUserMessage(threadId: string, text: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new UnknownThreadError(threadId);
    const body = text.trim();
    if (!body) return;
    const messageId = createId("msg");
    this.threads.upsertMessage(threadId, {
      id: messageId,
      kind: "text",
      role: "user",
      author: "you",
      text: body,
      createdAt: this.now(),
    });
    if (thread.taskId) this.records.markRead(thread.taskId);
    if (!this.canRun() || this.stopped) {
      const problem = this.problem ?? this.harnessProblem;
      this.postSystemNote(
        threadId,
        `The agent isn't running${problem ? ` (${problem})` : ""}. Your message is saved.`,
      );
      return;
    }
    if (isOrchestratorThread(threadId)) {
      this.orchestrator.handleDirectMessage({ text: body, messageId });
      return;
    }
    const taskId = thread.taskId;
    if (taskId && this.subagents.hasSubagent(taskId)) {
      if (await this.subagents.message(taskId, body, "user")) return;
    }
    if (taskId && !this.records.get(taskId) && !this.watcher.findTask(taskId)) {
      this.postSystemNote(
        threadId,
        "This task is no longer in your notes, so there's nothing to act on.",
      );
      return;
    }
    this.orchestrator.handleUserReply({ threadId, taskId, text: body });
  }

  decideApproval(id: string, decision: ApprovalDecisionRequest): Promise<ApprovalRequest> {
    return this.broker.decide(id, decision);
  }

  async cancelThread(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new UnknownThreadError(threadId);
    if (isOrchestratorThread(threadId)) {
      await this.stopOrchestratorTurn();
      return;
    }
    if (!thread.taskId) return;
    this.orchestrator.dropQueued(thread.taskId);
    await this.subagents.cancel(thread.taskId, "Cancelled by you.");
  }

  /**
   * Stop in the orchestrator's chat: its approvals still waiting are denied (nothing waits for
   * them any more) and the turn is aborted. Idle, it's a no-op.
   */
  private async stopOrchestratorTurn(): Promise<void> {
    if (!this.orchestrator.turnRunning) return;
    const pending = this.safely(
      () => this.broker.list({ threadId: this.chat.threadId, status: "pending" }),
      [],
    );
    await Promise.all(
      pending.map((approval) =>
        this.broker
          .decide(approval.id, { decision: "deny", note: "You stopped the orchestrator." })
          .catch((error: unknown) => this.logError("stopOrchestratorTurn", error)),
      ),
    );
    await this.orchestrator.cancelTurn();
  }

  async retryThread(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new UnknownThreadError(threadId);
    if (isOrchestratorThread(threadId)) {
      throw new AgentUnavailableError(
        "The orchestrator's chat has nothing to retry: write to it instead.",
      );
    }
    if (!thread.taskId) throw new AgentUnavailableError("This thread isn't attached to a task.");
    if (!this.canRun() || this.stopped) {
      throw new AgentUnavailableError(
        this.problem ?? this.harnessProblem ?? "The agent is not running.",
      );
    }
    const taskId = thread.taskId;
    if (this.records.getSpec(taskId) || this.subagents.hasSubagent(taskId)) {
      await this.subagents.retry(taskId);
      return;
    }
    const brief = this.scheduler.brief(taskId);
    if (brief) {
      this.orchestrator.handleRoutineRun({
        taskId,
        name: brief.name,
        instructions: brief.instructions,
        ...(brief.scheduleText ? { scheduleText: brief.scheduleText } : {}),
      });
      return;
    }
    this.orchestrator.retryTask(taskId);
  }

  markThreadRead(threadId: string): void {
    const taskId = this.threads.get(threadId)?.taskId;
    if (taskId) this.records.markRead(taskId);
  }

  subscribeSurface(threadId: string, surface: SurfaceKind): Unsubscribe {
    const key = surfaceKey(threadId, surface);
    this.surfaceSubscribers.set(key, (this.surfaceSubscribers.get(key) ?? 0) + 1);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const remaining = (this.surfaceSubscribers.get(key) ?? 1) - 1;
      if (remaining > 0) this.surfaceSubscribers.set(key, remaining);
      else this.surfaceSubscribers.delete(key);
    };
  }

  on<K extends keyof AgentRuntimeEvents>(
    event: K,
    listener: (payload: AgentRuntimeEvents[K]) => void,
  ): Unsubscribe {
    return this.emitter.on(event, (payload) => {
      try {
        listener(payload);
      } catch (error) {
        this.logger.error("AgentRuntime listener failed", { event, error: errorText(error) });
      }
    });
  }

  // ── Setup ─────────────────────────────────────────────────────────────────

  private createBroker(): ApprovalBroker {
    const factory = this.overrides.createApprovalBroker ?? createApprovalBroker;
    try {
      return factory({
        storage: this.options.storage,
        defaultTimeoutMs: this.options.settings.agent.approvalTimeoutMs,
        now: this.now,
        logger: this.logger.child({ component: "approvals" }),
      });
    } catch (error) {
      const reason = `The approval system failed to start: ${errorText(error)}`;
      if (this.mode !== "off") this.problem = reason;
      this.logger.error("Approval broker unavailable", { error: errorText(error) });
      return createInertApprovalBroker(reason);
    }
  }

  /** Fails closed: without an evaluator and gate no agent runs. */
  private setupSafety(): void {
    const createEvaluator = this.overrides.createSafetyEvaluator ?? createSafetyEvaluator;
    const createGate = this.overrides.createSafetyGate ?? createSafetyGate;
    const logger = this.logger.child({ component: "safety" });
    try {
      const live = this.mode === "live";
      const llm = this.llm;
      if (live && !llm) {
        this.logger.warn(
          "No working OpenRouter key in live mode: the safety judge is off (uncertain actions ask the user) and our web_search is not offered (the Cursor harness searches with the CLI)",
        );
      }
      this.evaluator = createEvaluator({
        policy: { ...this.options.safetyPolicy, ...(live && llm ? {} : { llmJudge: false }) },
        ...(live && llm ? { llm, judgeModel: this.settings.agent.judgeModel } : {}),
        logger,
      });
      this.gate = createGate({
        evaluator: this.evaluator,
        approvals: this.broker,
        resolveContext: (sessionId) => this.resolveGateContext(sessionId),
        appHome: this.options.home,
        approvalPolicy: () => this.settings.agent.approvalPolicy,
        onVerdict: (call, verdict) => {
          logger.debug("Safety verdict", {
            tool: call.toolName,
            role: call.role,
            decision: verdict.decision,
            source: verdict.source,
            latencyMs: verdict.latencyMs,
          });
        },
        onAllowed: (call, allowed) => {
          this.allowedCalls.set(callKey(call), allowed);
        },
        approvalTimeoutMs: this.settings.agent.approvalTimeoutMs,
        logger,
      });
    } catch (error) {
      this.evaluator = null;
      this.gate = null;
      this.problem ??= `The safety system failed to start (${errorText(error)}); the agent won't act until it's fixed.`;
      this.logger.error("Safety system unavailable", { error: errorText(error) });
    }
  }

  private async setupHarness(): Promise<void> {
    if (this.options.harness) {
      this.harness = this.options.harness;
      return;
    }
    if (this.mode === "mock") {
      this.harness = new ScriptedHarness({
        scriptFor: createMockScript(),
        wordDelayMs: this.overrides.mockWordDelayMs ?? 15,
      });
      return;
    }
    const setup = ++this.harnessSetups;
    const result = await setupHarness(this.settings.agent.harness, this.harnessContext());
    if (setup !== this.harnessSetups || this.stopped) {
      if ("harness" in result) await result.harness.dispose?.();
      return;
    }
    if ("problem" in result) this.harnessProblem = result.problem;
    else this.harness = result.harness;
  }

  /** Live mode picks the harness from settings; mock mode and injected harnesses never change. */
  private switchesHarness(): boolean {
    return this.mode === "live" && !this.options.harness && !this.stopped;
  }

  /**
   * Replaces the harness after `agent.harness` changed. Sessions of the old harness keep running
   * until their work ends (it is disposed once they are); new sessions use the new harness, and
   * idle ones are re-created with it when next used.
   */
  private async switchHarness(): Promise<void> {
    const setup = ++this.harnessSetups;
    const kind = this.settings.agent.harness;
    const result = await setupHarness(kind, this.harnessContext());
    if (setup !== this.harnessSetups || this.stopped) {
      if ("harness" in result) await result.harness.dispose?.();
      return;
    }
    const previous = this.harness;
    if ("harness" in result) {
      this.harness = result.harness;
      this.harnessProblem = undefined;
    } else {
      this.harness = null;
      this.harnessProblem = result.problem;
    }
    if (previous && previous !== this.harness) {
      this.retiredHarnesses.add(previous);
      this.background(previous.dispose?.() ?? Promise.resolve());
    }
    this.logger.info("Agent harness changed", { harness: kind, ready: this.harness !== null });
    if (!this.started || this.stopped) {
      this.queueStatus();
      return;
    }
    if (this.canRun() && this.enabled) await this.startWatching();
    else if (!this.canRun()) await this.watcher.stop();
    this.syncScheduler({ catchUp: true });
    this.queueStatus();
  }

  /** The OpenRouter client, unless OpenRouter rejected its key: then there is none. */
  private get llm(): LlmClient | undefined {
    return this.llmRejected ? undefined : this.options.llm;
  }

  /**
   * A key OpenRouter rejects counts as no key. Otherwise the safety judge and our web_search call
   * OpenRouter on every use and fail with a 401, while the Cursor harness could search itself.
   */
  private async checkLlmKey(): Promise<void> {
    if (this.mode !== "live" || !this.options.llm) return;
    const apiKey = this.overrides.openRouter?.apiKey ?? process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) return;
    const check = await this.checkKey(apiKey);
    if (check.status !== "invalid") return;
    this.llmRejected = true;
    this.logger.warn(
      "OpenRouter rejected OPENROUTER_API_KEY: until it is fixed in ~/.daily-do-list/.env, the safety judge is off and web search comes from the Cursor CLI",
      { httpStatus: check.httpStatus },
    );
    this.setupSafety();
  }

  private checkKey(apiKey: string): Promise<OpenRouterKeyCheck> {
    let check = this.keyChecks.get(apiKey);
    if (!check) {
      const baseUrl =
        this.overrides.openRouter?.baseUrl ??
        (process.env.DDL_OPENROUTER_BASE_URL?.trim() || undefined);
      const verify =
        this.overrides.checkApiKey ??
        ((key: string) => checkOpenRouterKey(key, baseUrl ? { baseUrl } : {}));
      check = verify(apiKey);
      this.keyChecks.set(apiKey, check);
    }
    return check;
  }

  private harnessContext(): HarnessSetupContext {
    const { openRouter, checkCursorCli } = this.overrides;
    return {
      home: this.options.home,
      logger: this.logger,
      env: process.env,
      ...(openRouter ? { openRouter } : {}),
      checkOpenRouterKey: (key) => this.checkKey(key),
      ...(checkCursorCli ? { checkCursorCli } : {}),
    };
  }

  private async setupWebTools(): Promise<void> {
    try {
      const factory = this.overrides.createWebTools ?? (await import("./tools/web")).createWebTools;
      const llm = this.llm;
      this.webTools = factory({
        ...(llm ? { llm } : {}),
        logger: this.logger.child({ component: "web" }),
      })
        // Without a model our web_search can only fail; the Cursor CLI searches instead (gated).
        .filter((tool) => llm !== undefined || tool.name !== TOOL.webSearch)
        .map((tool) => this.sourceCatalog.observe(tool));
    } catch (error) {
      this.logger.warn("Web tools unavailable", { error: errorText(error) });
    }
  }

  private wireEvents(): void {
    const safe =
      <T>(fn: (payload: T) => void) =>
      (payload: T) => {
        try {
          fn(payload);
        } catch (error) {
          this.logError("event handler", error);
        }
      };
    this.disposers.push(
      this.threads.on(
        safe((event) => {
          if (event.type === "thread.upsert") this.emitter.emit("thread.upsert", event.thread);
          else if (event.type === "thread.message") {
            this.emitter.emit("thread.message", {
              threadId: event.threadId,
              message: event.message,
            });
            const { message } = event;
            if (message.kind === "text" && message.role === "agent" && !message.streaming) {
              this.attachSources(event.threadId, message.text);
            }
          } else {
            this.emitter.emit("thread.delta", {
              threadId: event.threadId,
              messageId: event.messageId,
              delta: event.delta,
            });
          }
        }),
      ),
      // A routine's runs are task-like records, but not lines of a note: clients never see them.
      this.records.on(
        "task.record",
        safe((record) => {
          if (isRoutineRunId(record.taskId)) this.scheduler.onRecord(record);
          else this.emitter.emit("task.record", record);
        }),
      ),
      this.records.on(
        "task.records",
        safe(({ notePath, records }) =>
          this.emitter.emit("task.records", {
            notePath,
            records: records.filter((record) => !isRoutineRunId(record.taskId)),
          }),
        ),
      ),
      this.routines.on(() =>
        this.safely(() => this.emitter.emit("routines.changed", this.routines.list()), undefined),
      ),
      this.routines.catalog.on(() => this.safely(() => this.scheduler.tick(), undefined)),
      this.broker.onUpsert(safe((approval) => this.onApproval(approval))),
      this.watcher.on(
        "task",
        safe((event) => this.orchestrator.handleTaskEvent(event)),
      ),
      this.watcher.on(
        "note",
        safe((event) => this.orchestrator.handleNoteEvent(event)),
      ),
      this.watcher.on(
        "tasks",
        safe(({ notePath, tasks }) => {
          this.records.syncTasks(notePath, tasks);
          this.syncAnchors(notePath);
        }),
      ),
      // Edits from another device or editor report no typing; the change itself is the hint.
      this.watcher.on(
        "changed",
        safe(() => this.warmUp()),
      ),
    );
    if (this.options.connectors) {
      this.disposers.push(this.options.connectors.onStatus(() => this.queueStatus()));
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private canRun(): boolean {
    return (
      this.mode !== "off" &&
      !this.problem &&
      !this.harnessProblem &&
      this.harness !== null &&
      this.gate !== null
    );
  }

  private async startWatching(): Promise<void> {
    try {
      await this.watcher.start();
    } catch (error) {
      this.logError("watcher.start", error);
      return;
    }
    if (this.recoveredTriage) return;
    this.recoveredTriage = true;
    // Tasks that were mid-triage when the agent last stopped.
    for (const record of this.records.all()) {
      if (record.status !== "triaging" || !this.watcher.findTask(record.taskId)) continue;
      this.safely(() => this.orchestrator.retryTask(record.taskId), undefined);
    }
  }

  /**
   * Work that was going when the agent last stopped is picked back up by `start()` (it keeps its
   * status until then); approvals left pending go (a resumed run asks again).
   */
  private reconcileAfterRestart(): void {
    this.interruptedWork = this.records
      .all()
      .filter((record) => RESUMABLE_STATUSES.has(record.status))
      .map((record) => record.taskId);
    const stale = this.safely(() => this.broker.list({ status: "pending" }), []);
    for (const taskId of new Set(stale.map((a) => a.taskId))) {
      if (!taskId) continue;
      this.safely(
        () => this.broker.cancelForTask(taskId, "The agent restarted before this was decided."),
        undefined,
      );
    }
  }

  /**
   * Resumes the work `reconcileAfterRestart` found, each from its journal: a new session restored
   * from the transcript of the last one continues it (the same path a handover takes). Work that
   * stopped in the middle of an action that may or may not have happened isn't resumed: the user
   * decides, with Retry. Without a harness, or without anything to run, it's interrupted as before.
   */
  private async resumeInterruptedWork(): Promise<void> {
    for (const taskId of this.interruptedWork.splice(0)) {
      const record = this.records.get(taskId);
      if (!record || !RESUMABLE_STATUSES.has(record.status)) continue;
      try {
        await this.resumeWork(record);
      } catch (error) {
        this.logError("resume", error);
        this.board.setStatus(taskId, "failed", {
          summary: "Interrupted",
          note: "Interrupted because the agent restarted. Use Retry to continue.",
        });
      }
    }
  }

  private async resumeWork(record: TaskAgentRecord): Promise<void> {
    const interrupted = (note: string) =>
      this.board.setStatus(record.taskId, "failed", { summary: "Interrupted", note });
    const restarted = "Interrupted because the agent restarted. Use Retry to continue.";
    const threadId = record.threadId;
    if (!this.canRun() || this.stopped || !threadId || !this.records.getSpec(record.taskId)) {
      interrupted(restarted);
      return;
    }
    if (this.threads.interruptedCalls(threadId).some((call) => call.effectful)) {
      interrupted(
        "The agent stopped in the middle of an action that may or may not have happened, so it didn't pick this back up on its own. Use Retry when you've checked: it asks again before doing anything.",
      );
      return;
    }
    if (isRoutineRunId(record.taskId) && !this.scheduler.adoptRun(record.taskId)) {
      interrupted(restarted);
      return;
    }
    const restored = buildTranscript(await this.threads.readJournal(threadId));
    this.board.setStatus(record.taskId, record.status === "queued" ? "queued" : "working", {
      note: "Picking this back up after the agent restarted.",
    });
    const resumed = this.subagents.resume(record.taskId, {
      transcript: restored?.entries ?? [],
      ...(restored ? { sessionId: restored.sessionId } : {}),
    });
    if (!resumed) interrupted(restarted);
  }

  private resolveGateContext(sessionId: string): GateContext {
    if (Orchestrator.isOrchestratorSession(sessionId)) {
      return this.orchestrator.contextFor(sessionId);
    }
    return this.subagents.contextFor(sessionId) ?? { taskId: null, threadId: null };
  }

  /**
   * Stable function handed to every session; delegates to the current gate and fails closed. An
   * allowed call carries how it was allowed (for the journal's write-ahead record).
   */
  private readonly beforeToolCall = async (call: ToolCallRequest): Promise<ToolCallDecision> => {
    const gate = this.gate;
    if (!gate) return { allow: false, reason: "The safety gate is unavailable." };
    const key = callKey(call);
    try {
      const decision = await gate(call);
      const allowed = this.allowedCalls.get(key);
      return decision.allow && allowed ? { ...allowed, ...decision } : decision;
    } catch (error) {
      this.logger.error("Safety gate threw", { tool: call.toolName, error: errorText(error) });
      return { allow: false, reason: `The safety check failed: ${errorText(error)}` };
    } finally {
      this.allowedCalls.delete(key);
    }
  };

  /** The harness with the journal's tool call records around every session it creates. */
  private journaled(harness: Harness | null): Harness | null {
    if (!harness) return null;
    let wrapped = this.journaledHarnesses.get(harness);
    if (!wrapped) {
      wrapped = journalingHarness(harness, {
        journal: this.threads,
        threadFor: (sessionId) => this.resolveGateContext(sessionId).threadId,
        logger: this.logger.child({ component: "tool-ledger" }),
      });
      this.journaledHarnesses.set(harness, wrapped);
    }
    return wrapped;
  }

  /**
   * Tool calls that started and never finished belong to a process that's gone: they may or may
   * not have happened. Each is marked interrupted (never re-run automatically), its row in the
   * thread ends, and one that could have changed something gets a system line saying so.
   */
  private markInterruptedToolCalls(): void {
    for (const { id } of this.threads.list()) {
      for (const call of this.threads.markInterrupted(id)) this.showInterrupted(id, call);
    }
  }

  private showInterrupted(threadId: string, call: OpenToolCall): void {
    const row = this.threads
      .get(threadId)
      ?.messages.find((m) => m.kind === "tool_call" && m.toolCallId === call.callId);
    if (row?.kind === "tool_call" && row.status === "running") {
      this.threads.upsertMessage(threadId, {
        ...row,
        status: "error",
        resultPreview: call.effectful
          ? "Interrupted: it may or may not have happened"
          : "Interrupted",
        endedAt: row.endedAt ?? call.startedAt,
      });
    }
    if (call.effectful) {
      this.postSystemNote(
        threadId,
        `Interrupted during: ${call.target}. It may or may not have happened, and it won't run again on its own.`,
      );
    }
  }

  private onApproval(approval: ApprovalRequest): void {
    this.emitter.emit("approval.upsert", approval);
    const { threadId, taskId } = approval;
    if (
      threadId &&
      approval.status === "pending" &&
      !this.approvalMessages.has(approval.id) &&
      this.threads.get(threadId)
    ) {
      this.approvalMessages.add(approval.id);
      this.threads.upsertMessage(threadId, {
        id: `msg_${approval.id}`,
        kind: "approval",
        author: "system",
        approvalId: approval.id,
        createdAt: approval.createdAt,
      });
      if (taskId) this.records.bumpUnread(taskId);
    }
    if (taskId && this.records.get(taskId)) {
      const pending = this.broker.list({ taskId, status: "pending" });
      const record = this.records.get(taskId);
      if (pending.length > 0) {
        this.board.setStatus(taskId, "waiting_approval", {
          summary: badgeFrom(`Approve: ${pending[0]!.summary}`),
        });
      } else if (this.subagents.isWorking(taskId) && record?.status === "waiting_approval") {
        this.board.setStatus(taskId, "working", {
          summary: approval.status === "approved" ? "Approved · continuing" : "Not approved",
        });
      }
    }
    this.queueStatus();
  }

  private onFrame(
    threadId: string,
    surface: SurfaceKind,
    frame: Parameters<FrameListener>[0],
  ): void {
    this.threads.addSurface(threadId, surface);
    if (!this.surfaceSubscribers.has(surfaceKey(threadId, surface))) return;
    this.emitter.emit("surface.frame", { ...frame, threadId, surface });
  }

  private capabilities(): DigestCapabilities {
    const exec = this.options.execution.capabilities;
    const connectors = this.safely(() => this.options.connectors?.status() ?? [], []).filter(
      (c) => c.state !== "disabled",
    );
    const flags: Array<[Capability, boolean]> = [
      ["web", this.mode === "mock" || this.webTools.length > 0],
      ["browser", exec.browser],
      ["computer", exec.computer],
      ["shell", exec.shell],
      ["files", true],
      ["connectors", connectors.some((c) => c.state !== "error")],
    ];
    return {
      available: flags.filter(([, ok]) => ok).map(([c]) => c),
      unavailable: flags.filter(([, ok]) => !ok).map(([c]) => c),
      connectors: connectors.map((c) => ({ name: c.name, state: c.state, toolCount: c.toolCount })),
      ...(exec.computer ? { computer: this.digestComputer() } : {}),
    };
  }

  private digestComputer(): NonNullable<DigestCapabilities["computer"]> {
    const { access, apps, moreApps } = this.computerStatus.current();
    return {
      apps,
      moreApps,
      ...(access
        ? {
            access: {
              accessibility: access.accessibility,
              screenRecording: access.screenRecording,
              appControl: access.appControl,
              ...(access.hostApp ? { host: access.hostApp.name } : {}),
            },
          }
        : {}),
    };
  }

  private postSystemNote(threadId: string, text: string): void {
    this.threads.upsertMessage(threadId, {
      id: createId("msg"),
      kind: "text",
      role: "system",
      author: "system",
      text,
      createdAt: this.now(),
    });
  }

  /** Remembers, on the thread, the known web pages that `text` (its message or note line) cites. */
  private attachSources(threadId: string, text: string): void {
    const cited = this.sourceCatalog.citedIn(text);
    if (cited.length > 0) this.threads.addSources(threadId, cited);
  }

  /**
   * Keeps line anchors on their line as the note changes. An anchor whose line vanished gets the
   * settle delay (twice) to come back, as a cut and paste or a rewrite would; then it's removed and
   * its work stops, like a deleted task's.
   */
  private syncAnchors(notePath: string): void {
    const anchors = this.records.anchors(notePath);
    if (anchors.length === 0) return;
    const content = this.watcher.getContent(notePath);
    if (content === null) return;
    const positions = resolveLineAnchors(
      content,
      anchors.map((record) => ({ anchorId: record.taskId, text: record.text, line: record.line })),
    );
    for (const anchorId of positions.keys()) {
      clearTimeout(this.missingAnchors.get(anchorId));
      this.missingAnchors.delete(anchorId);
    }
    for (const anchorId of this.records.syncAnchors(notePath, positions)) {
      if (this.missingAnchors.has(anchorId)) continue;
      const timer = setTimeout(() => {
        this.missingAnchors.delete(anchorId);
        this.safely(() => this.orchestrator.anchorRemoved(anchorId), undefined);
      }, this.settings.agent.settleMs * 2);
      timer.unref?.();
      this.missingAnchors.set(anchorId, timer);
    }
  }

  private queueStatus(): void {
    if (this.statusQueued) return;
    this.statusQueued = true;
    queueMicrotask(() => {
      this.statusQueued = false;
      const status = this.status();
      const json = JSON.stringify(status);
      if (json === this.lastStatusJson) return;
      this.lastStatusJson = json;
      this.emitter.emit("status", status);
    });
  }

  private safely<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (error) {
      this.logError("runtime", error);
      return fallback;
    }
  }

  private background(promise: Promise<unknown>): void {
    promise.catch((error: unknown) => this.logError("background", error));
  }

  private logError(context: string, error: unknown): void {
    this.logger.error(`Agent runtime error (${context})`, { error: errorText(error) });
  }
}

function surfaceKey(threadId: string, surface: SurfaceKind): string {
  return `${threadId}\u0000${surface}`;
}

function callKey(call: ToolCallRequest): string {
  return `${call.sessionId}\u0000${call.toolCallId}`;
}

/** Stand-in when the real broker failed to start: nothing is pending and nothing can be approved. */
function createInertApprovalBroker(reason: string): ApprovalBroker {
  return {
    async request(input: NewApproval): Promise<ApprovalOutcome> {
      return {
        approved: false,
        note: reason,
        request: {
          id: createId("apr"),
          threadId: input.threadId,
          taskId: input.taskId,
          toolName: input.toolName,
          input: input.input,
          summary: input.summary,
          risk: input.risk,
          categories: input.categories,
          reason: input.reason,
          status: "denied",
          createdAt: Date.now(),
        },
      };
    },
    async decide(): Promise<ApprovalRequest> {
      throw new AgentUnavailableError(reason);
    },
    get: () => undefined,
    list: () => [],
    findGrant: () => undefined,
    cancelForTask: () => {},
    approvePending: () => [],
    onUpsert: () => () => {},
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
