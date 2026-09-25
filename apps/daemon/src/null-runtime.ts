import type { AgentRuntime, AgentRuntimeEvents } from "@ddl/agent";
import { RoutineLibrary } from "@ddl/agent/routines";
import type { ConnectorToolSource } from "@ddl/connectors";
import {
  type AgentMode,
  type AgentStatusResponse,
  type ApprovalRequest,
  type ApprovalStatus,
  type AppSettings,
  type ArtifactMeta,
  agentModel,
  type CreateRoutineRequest,
  DEFAULT_MODEL,
  Emitter,
  type Logger,
  type Routine,
  type RoutineRunResponse,
  silentLogger,
  type TaskAgentRecord,
  type Thread,
  type ThreadSummary,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import { SidecarView } from "./sidecar-view";

export interface NullAgentRuntimeOptions {
  /** What `status().mode` reports. Default `off`. */
  mode?: AgentMode;
  model?: string;
  enabled?: boolean;
  /** Why agents are unavailable; surfaced as `AgentStatusResponse.problem`. */
  problem?: string;
  connectors?: Pick<ConnectorToolSource, "status">;
  /**
   * The vault. With it, the agent's work stays visible read-only (threads, approvals, task records
   * and artifacts from the synced sidecar), and routines, being files, stay listable, creatable and
   * pausable (nothing runs them, and the scheduler's state is only read). Without it all of these
   * are empty or unavailable.
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
 * created, and while another device holds the agent lease. It never acts: agent commands fail with
 * the reason (`problem`), and it writes nothing into the agent's sidecar files. With the vault it
 * shows what the agent did (read-only, as sync brings it) and keeps routine files working; the
 * events it emits are `routines.changed` and the sidecar's `thread.upsert`, `approval.upsert` and
 * `task.records`.
 */
export class NullAgentRuntime implements AgentRuntime {
  readonly mode: AgentMode;
  private enabled: boolean;
  private model: string;
  private problem: string | undefined;
  private readonly connectors: Pick<ConnectorToolSource, "status"> | undefined;
  private readonly routines: RoutineLibrary | undefined;
  private readonly sidecar: SidecarView | undefined;
  private readonly events = new Emitter<RuntimeEventMap>();
  private routinesStarted = false;
  private started = false;
  private followingSidecar = true;
  private stopped = false;

  constructor(options: NullAgentRuntimeOptions = {}) {
    this.mode = options.mode ?? "off";
    this.enabled = options.enabled ?? true;
    this.model = options.model ?? DEFAULT_MODEL;
    this.problem = options.problem;
    this.connectors = options.connectors;
    const logger = options.logger ?? silentLogger;
    this.routines = options.storage
      ? new RoutineLibrary({
          storage: options.storage,
          readOnly: true,
          logger: logger.child({ component: "routines" }),
        })
      : undefined;
    this.sidecar = options.storage
      ? new SidecarView({
          storage: options.storage,
          logger: logger.child({ component: "sidecar" }),
        })
      : undefined;
    this.sidecar?.on((event) => {
      if (event.type === "thread.upsert") this.events.emit("thread.upsert", event.thread);
      else if (event.type === "approval.upsert")
        this.events.emit("approval.upsert", event.approval);
      else this.events.emit("task.records", { notePath: event.notePath, records: event.records });
    });
  }

  setProblem(problem: string | undefined): void {
    this.problem = problem;
  }

  /**
   * Whether the sidecar is read and followed. Off while the real runtime runs on this device (it
   * answers then); turning it on again reads everything as the stopped agent left it.
   */
  async followSidecar(follow: boolean): Promise<void> {
    this.followingSidecar = follow;
    if (!follow) this.sidecar?.stop();
    else if (this.started && !this.stopped) await this.sidecar?.start();
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    this.started = true;
    const routines = this.routines;
    if (routines && !this.routinesStarted) {
      this.routinesStarted = true;
      routines.on(() => this.events.emit("routines.changed", routines.list()));
      await routines.start();
    }
    if (this.followingSidecar) await this.sidecar?.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.routines?.stop();
    this.sidecar?.stop();
  }

  status(): AgentStatusResponse {
    return {
      mode: this.mode,
      enabled: this.enabled,
      model: this.model,
      running: 0,
      queued: 0,
      pendingApprovals: this.sidecar?.pendingApprovals() ?? 0,
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

  getTaskRecords(notePath: string): TaskAgentRecord[] {
    return this.sidecar?.getTaskRecords(notePath) ?? [];
  }

  listThreads(filter?: {
    notePath?: string;
    taskId?: string;
    routineId?: string;
  }): ThreadSummary[] {
    return this.sidecar?.listThreads(filter) ?? [];
  }

  getThread(id: string): { thread: Thread; approvals: ApprovalRequest[] } | undefined {
    return this.sidecar?.getThread(id);
  }

  listApprovals(filter?: { status?: ApprovalStatus }): ApprovalRequest[] {
    return this.sidecar?.listApprovals(filter) ?? [];
  }

  async readArtifact(
    threadId: string,
    artifactId: string,
  ): Promise<{ meta: ArtifactMeta; body: Uint8Array } | null> {
    return (await this.sidecar?.readArtifact(threadId, artifactId)) ?? null;
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
