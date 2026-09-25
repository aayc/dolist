import type { AgentRuntime, AgentRuntimeEvents } from "@ddl/agent";
import { RoutineLibrary } from "@ddl/agent/routines";
import type { ConnectorToolSource } from "@ddl/connectors";
import {
  type AgentMode,
  type AgentStatusResponse,
  type ApprovalRequest,
  type AppSettings,
  agentModel,
  type CreateRoutineRequest,
  DEFAULT_MODEL,
  Emitter,
  type Logger,
  type Routine,
  type RoutineRunResponse,
  silentLogger,
  type TaskAgentRecord,
  type ThreadSummary,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";

export interface NullAgentRuntimeOptions {
  /** What `status().mode` reports. Default `off`. */
  mode?: AgentMode;
  model?: string;
  enabled?: boolean;
  /** Why agents are unavailable; surfaced as `AgentStatusResponse.problem`. */
  problem?: string;
  connectors?: Pick<ConnectorToolSource, "status">;
  /**
   * The vault. Routines are files, so with it they stay listable, creatable and pausable while no
   * agent runs here (nothing runs them, and the scheduler's state is only read). Without it they
   * are unavailable like everything else.
   */
  storage?: StorageProvider;
  logger?: Logger;
}

export class AgentUnavailableError extends Error {
  constructor(message = "The agent runtime is not running") {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

type RuntimeEventMap = { [K in keyof AgentRuntimeEvents]: AgentRuntimeEvents[K] };

/**
 * Runtime used for `DDL_AGENT_MODE=off`, in tests, as the fallback when the real runtime cannot be
 * created, and while another device holds the agent lease: no tasks, threads or approvals, and
 * the only event it emits is `routines.changed`. Notes and routine files keep working.
 */
export class NullAgentRuntime implements AgentRuntime {
  readonly mode: AgentMode;
  private enabled: boolean;
  private model: string;
  private problem: string | undefined;
  private readonly connectors: Pick<ConnectorToolSource, "status"> | undefined;
  private readonly routines: RoutineLibrary | undefined;
  private readonly events = new Emitter<RuntimeEventMap>();
  private routinesStarted = false;
  private stopped = false;

  constructor(options: NullAgentRuntimeOptions = {}) {
    this.mode = options.mode ?? "off";
    this.enabled = options.enabled ?? true;
    this.model = options.model ?? DEFAULT_MODEL;
    this.problem = options.problem;
    this.connectors = options.connectors;
    this.routines = options.storage
      ? new RoutineLibrary({
          storage: options.storage,
          readOnly: true,
          logger: (options.logger ?? silentLogger).child({ component: "routines" }),
        })
      : undefined;
  }

  setProblem(problem: string | undefined): void {
    this.problem = problem;
  }

  async start(): Promise<void> {
    const routines = this.routines;
    if (!routines || this.routinesStarted || this.stopped) return;
    this.routinesStarted = true;
    routines.on(() => this.events.emit("routines.changed", routines.list()));
    await routines.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.routines?.stop();
  }

  status(): AgentStatusResponse {
    return {
      mode: this.mode,
      enabled: this.enabled,
      model: this.model,
      running: 0,
      queued: 0,
      pendingApprovals: 0,
      connectors: this.connectors?.status() ?? [],
      execution: {
        provider: "none",
        capabilities: { shell: false, browser: false, computer: false },
      },
      ...(this.problem ? { problem: this.problem } : {}),
    };
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
  }

  updateSettings(settings: AppSettings): void {
    this.enabled = settings.agent.enabled;
    this.model = agentModel(settings.agent);
  }

  noteEditorActivity(): void {}

  getTaskRecords(): TaskAgentRecord[] {
    return [];
  }

  listThreads(): ThreadSummary[] {
    return [];
  }

  getThread(): undefined {
    return undefined;
  }

  listApprovals(): ApprovalRequest[] {
    return [];
  }

  async readArtifact(): Promise<null> {
    return null;
  }

  async postUserMessage(): Promise<void> {
    throw this.unavailable();
  }

  async decideApproval(): Promise<ApprovalRequest> {
    throw this.unavailable();
  }

  async cancelThread(): Promise<void> {
    throw this.unavailable();
  }

  async retryThread(): Promise<void> {
    throw this.unavailable();
  }

  markThreadRead(): void {}

  subscribeSurface(): Unsubscribe {
    return () => {};
  }

  listRoutines(): Routine[] {
    return this.routines?.list() ?? [];
  }

  getRoutine(id: string): Routine | undefined {
    return this.routines?.get(id);
  }

  async createRoutine(input: CreateRoutineRequest): Promise<Routine> {
    return this.requireRoutines().create(input);
  }

  async setRoutinePaused(id: string, paused: boolean): Promise<Routine> {
    return this.requireRoutines().setPaused(id, paused);
  }

  /** Runs need an agent: there is none here. */
  async runRoutine(): Promise<RoutineRunResponse> {
    throw this.unavailable();
  }

  on<K extends keyof AgentRuntimeEvents>(
    event: K,
    listener: (payload: AgentRuntimeEvents[K]) => void,
  ): Unsubscribe {
    return this.events.on(event, listener);
  }

  private requireRoutines(): RoutineLibrary {
    if (!this.routines) throw this.unavailable();
    return this.routines;
  }

  private unavailable(): AgentUnavailableError {
    return this.problem ? new AgentUnavailableError(this.problem) : new AgentUnavailableError();
  }
}
