import type { AgentRuntime, AgentRuntimeEvents } from "@ddl/agent";
import type { ConnectorToolSource } from "@ddl/connectors";
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
  type Logger,
  type Routine,
  type RoutineRunResponse,
  type SurfaceKind,
  type TaskAgentRecord,
  type Thread,
  type ThreadSummary,
  type Unsubscribe,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import { errorMessage } from "./errors";
import { NullAgentRuntime } from "./null-runtime";
import type { AgentStack } from "./wiring";

export interface LeasedAgentRuntimeOptions {
  /** The configured mode (`live` or `mock`), reported even while the agent runs elsewhere. */
  mode: AgentMode;
  settings: AppSettings;
  connectors?: Pick<ConnectorToolSource, "status">;
  /** Creates the real runtime (loading threads and records from the vault as they are now). */
  createStack(settings: AppSettings): Promise<AgentStack>;
  /** The vault as the agent sees it: routine files stay editable while the agent runs elsewhere. */
  storage?: StorageProvider;
  /** Why the agent isn't running here yet. */
  problem: string;
  /** Added to every status (and `status` event): where the agent runs, this daemon's readiness. */
  statusExtras?: (
    status: AgentStatusResponse,
  ) => Pick<AgentStatusResponse, "placement" | "readiness">;
  logger: Logger;
}

type Listener = (payload: never) => void;

/**
 * The daemon's AgentRuntime when devices share a vault through the sync service: the real runtime
 * exists only while this device holds the agent lease. `activate()` creates and starts it from
 * the vault's current state (so it never overwrites what another device's agent wrote);
 * `deactivate()` stops it, which flushes its state for sync. In between, a NullAgentRuntime
 * answers: notes and routine files keep working, the agent's threads, approvals and records show
 * read-only from the synced sidecar, agent commands (running a routine included) fail with the
 * reason (`problem`), and nothing is written to the agent's sidecar files. Routines are
 * scheduled only by the real runtime, so only while this device holds the lease. Listeners follow
 * the current runtime across swaps, and every swap emits `status` and `routines.changed` (a
 * change of reason emits `status`).
 */
export class LeasedAgentRuntime implements AgentRuntime {
  readonly mode: AgentMode;
  readonly #options: LeasedAgentRuntimeOptions;
  readonly #idle: NullAgentRuntime;
  readonly #subscriptions = new Set<{
    event: keyof AgentRuntimeEvents;
    listener: Listener;
    off: Unsubscribe;
  }>();
  #settings: AppSettings;
  #active: AgentStack | null = null;
  #started = false;
  #stopped = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: LeasedAgentRuntimeOptions) {
    this.mode = options.mode;
    this.#options = options;
    this.#settings = options.settings;
    this.#idle = new NullAgentRuntime({
      mode: options.mode,
      model: agentModel(options.settings.agent),
      enabled: options.settings.agent.enabled,
      problem: options.problem,
      ...(options.connectors ? { connectors: options.connectors } : {}),
      ...(options.storage ? { storage: options.storage } : {}),
      logger: options.logger,
    });
  }

  /** True while the real runtime runs on this device. */
  get active(): boolean {
    return this.#active !== null;
  }

  /** Creates and starts the real runtime (no-op when it runs already or after `stop()`). */
  activate(): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#stopped || this.#active) return;
      const stack = await this.#options.createStack(this.#settings);
      if (this.#stopped) {
        await this.#dispose(stack);
        return;
      }
      this.#active = stack;
      this.#rebind();
      await this.#idle.followSidecar(false);
      if (this.#started) {
        await stack.runtime.start().catch((error: unknown) => {
          this.#options.logger.error("The agent runtime failed to start", {
            error: errorMessage(error),
          });
        });
      }
      this.#emitStatus();
      this.#emitActivity();
      this.#emitRoutines();
    });
  }

  /** Stops the real runtime if it runs, and reports `problem` as the reason from now on. */
  deactivate(problem: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#idle.setProblem(problem);
      const stack = this.#active;
      this.#active = null;
      if (stack) {
        this.#rebind();
        await this.#dispose(stack);
        await this.#idle.followSidecar(true);
      }
      this.#emitStatus();
      if (stack) {
        this.#emitActivity();
        this.#emitRoutines();
      }
    });
  }

  async start(): Promise<void> {
    this.#started = true;
    await this.#enqueue(async () => {
      await this.#idle.start().catch((error: unknown) => {
        this.#options.logger.error("Routines failed to load", { error: errorMessage(error) });
      });
      await this.#active?.runtime.start();
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#enqueue(async () => {
      await this.#idle.stop();
      const stack = this.#active;
      this.#active = null;
      if (!stack) return;
      this.#rebind();
      await this.#dispose(stack);
    });
  }

  status(): AgentStatusResponse {
    return this.#decorate(this.#current().status());
  }

  /** Emits `status` now (e.g. the placement or readiness changed). */
  refreshStatus(): void {
    this.#emitStatus();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.#idle.setEnabled(enabled);
    await this.#active?.runtime.setEnabled(enabled);
  }

  updateSettings(settings: AppSettings): void {
    this.#settings = settings;
    this.#idle.updateSettings(settings);
    this.#active?.runtime.updateSettings(settings);
  }

  noteEditorActivity(notePath: string, line: number): void {
    this.#current().noteEditorActivity(notePath, line);
  }

  getTaskRecords(notePath: string): TaskAgentRecord[] {
    return this.#current().getTaskRecords(notePath);
  }

  listThreads(filter?: {
    notePath?: string;
    taskId?: string;
    routineId?: string;
  }): ThreadSummary[] {
    return this.#current().listThreads(filter);
  }

  getThread(id: string): { thread: Thread; approvals: ApprovalRequest[] } | undefined {
    return this.#current().getThread(id);
  }

  listApprovals(filter?: { status?: ApprovalStatus }): ApprovalRequest[] {
    return this.#current().listApprovals(filter);
  }

  readArtifact(
    threadId: string,
    artifactId: string,
  ): Promise<{ meta: ArtifactMeta; body: Uint8Array } | null> {
    return this.#current().readArtifact(threadId, artifactId);
  }

  postUserMessage(threadId: string, text: string): Promise<void> {
    return this.#current().postUserMessage(threadId, text);
  }

  decideApproval(id: string, decision: ApprovalDecisionRequest): Promise<ApprovalRequest> {
    return this.#current().decideApproval(id, decision);
  }

  cancelThread(threadId: string): Promise<void> {
    return this.#current().cancelThread(threadId);
  }

  retryThread(threadId: string): Promise<void> {
    return this.#current().retryThread(threadId);
  }

  markThreadRead(threadId: string): void {
    this.#current().markThreadRead(threadId);
  }

  subscribeSurface(threadId: string, surface: SurfaceKind): Unsubscribe {
    return this.#current().subscribeSurface(threadId, surface);
  }

  listRoutines(): Routine[] {
    return this.#current().listRoutines();
  }

  getRoutine(id: string): Routine | undefined {
    return this.#current().getRoutine(id);
  }

  createRoutine(input: CreateRoutineRequest): Promise<Routine> {
    return this.#current().createRoutine(input);
  }

  setRoutinePaused(id: string, paused: boolean): Promise<Routine> {
    return this.#current().setRoutinePaused(id, paused);
  }

  runRoutine(id: string): Promise<RoutineRunResponse> {
    return this.#current().runRoutine(id);
  }

  on<K extends keyof AgentRuntimeEvents>(
    event: K,
    listener: (payload: AgentRuntimeEvents[K]) => void,
  ): Unsubscribe {
    // The inner runtime's own status events get the extras too.
    const inner = (
      event === "status"
        ? (status: AgentStatusResponse) =>
            (listener as (payload: AgentStatusResponse) => void)(this.#decorate(status))
        : listener
    ) as Listener;
    const subscription = {
      event,
      listener: inner,
      off: this.#current().on(event, inner as never),
    };
    this.#subscriptions.add(subscription);
    return () => {
      subscription.off();
      this.#subscriptions.delete(subscription);
    };
  }

  #current(): AgentRuntime {
    return this.#active?.runtime ?? this.#idle;
  }

  #rebind(): void {
    const runtime = this.#current();
    for (const subscription of this.#subscriptions) {
      subscription.off();
      subscription.off = runtime.on(subscription.event, subscription.listener as never);
    }
  }

  #decorate(status: AgentStatusResponse): AgentStatusResponse {
    const extras = this.#options.statusExtras?.(status);
    if (!extras) return status;
    return {
      ...status,
      ...(extras.placement ? { placement: extras.placement } : {}),
      ...(extras.readiness ? { readiness: extras.readiness } : {}),
    };
  }

  #emitStatus(): void {
    // Listeners decorate what they're given: pass the undecorated status.
    this.#emit("status", this.#current().status());
  }

  /** Listeners follow the new runtime before the old one stops: its last turn never ends for them. */
  #emitActivity(): void {
    this.#emit("orchestrator.activity", this.#current().status().orchestrator ?? { phase: "idle" });
  }

  /** The other runtime's routines: scheduled or not, with or without live run statuses. */
  #emitRoutines(): void {
    this.#emit("routines.changed", this.listRoutines());
  }

  #emit<K extends keyof AgentRuntimeEvents>(event: K, payload: AgentRuntimeEvents[K]): void {
    for (const subscription of [...this.#subscriptions]) {
      if (subscription.event !== event) continue;
      try {
        (subscription.listener as (payload: AgentRuntimeEvents[K]) => void)(payload);
      } catch (error) {
        this.#options.logger.error("Agent runtime listener failed", {
          event,
          error: errorMessage(error),
        });
      }
    }
  }

  async #dispose(stack: AgentStack): Promise<void> {
    await stack.runtime.stop().catch((error: unknown) => {
      this.#options.logger.warn("The agent runtime didn't stop cleanly", {
        error: errorMessage(error),
      });
    });
    await stack.execution?.dispose().catch((error: unknown) => {
      this.#options.logger.warn("The execution provider didn't stop cleanly", {
        error: errorMessage(error),
      });
    });
  }

  #enqueue(step: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(step);
    this.#queue = next.catch((error: unknown) => {
      this.#options.logger.error("Agent runtime switch failed", { error: errorMessage(error) });
    });
    return next;
  }
}
