/**
 * The agent relay: while this device's agent runs on the always-on machine, its agent routes and
 * events are forwarded there, so this device's clients show and act on the machine's agent.
 * Otherwise everything stays local (the local runtime answers, as without a relay).
 */
import type { AgentRuntime, AgentRuntimeEvents } from "@ddl/agent";
import {
  AgentStatusResponseSchema,
  ApprovalListResponseSchema,
  RoutineListResponseSchema,
  ThreadListResponseSchema,
} from "@ddl/contract";
import {
  type AgentMode,
  type AgentPlacementStatus,
  type AgentRunsOn,
  type AgentStatusResponse,
  API_ROUTES,
  type ApprovalDecisionRequest,
  type ApprovalListResponse,
  type ApprovalRequest,
  type ApprovalStatus,
  type AppSettings,
  type ArtifactMeta,
  type CreateRoutineRequest,
  Emitter,
  type Logger,
  normalizeMachineUrl,
  type RelayState,
  type Routine,
  type RoutineListResponse,
  type RoutineRunResponse,
  type ServerEvent,
  type SurfaceKind,
  type TaskAgentRecord,
  type Thread,
  type ThreadListResponse,
  type ThreadSummary,
  type Unsubscribe,
} from "@ddl/core";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { errorBody, errorMessage } from "../errors";
import { readJson } from "../http-utils";
import { AgentUnavailableError } from "../null-runtime";
import { relayedArtifactHeaders } from "../routes/artifacts";
import { callMachine, type MachineAnswer, MachineUnavailableError } from "./http";
import { type LinkState, type LinkTimings, MachineLink } from "./link";
import { matchRelayRoute, type RelayRoute } from "./routes";
import type { MachineCredential, MachineCredentialSource, PlacementSource } from "./sources";

/** Why the machine's agent can't be reached from this device (`problem`, 503 messages). */
export const RELAY_PROBLEMS = {
  notPaired: "This device isn't paired with the always-on machine.",
  rejected: "The always-on machine no longer accepts this device. Pair it again.",
  unreachable: "The always-on machine can't be reached.",
} as const;

export interface AgentRelayOptions {
  /** This device's own runtime: it answers whenever the relay doesn't forward. */
  local: AgentRuntime;
  placement: PlacementSource;
  machine: MachineCredentialSource;
  logger: Logger;
  /** Per call to the machine (default `RELAY_LIMITS.timeoutMs`). */
  timeoutMs?: number;
  linkTimings?: Partial<LinkTimings>;
}

type RuntimeEventMap = { [K in keyof AgentRuntimeEvents]: AgentRuntimeEvents[K] };

const RUNTIME_EVENTS = [
  "task.record",
  "task.records",
  "thread.upsert",
  "thread.message",
  "thread.delta",
  "approval.upsert",
  "status",
  "surface.frame",
  "routines.changed",
  "routine.notification",
] as const satisfies ReadonlyArray<keyof AgentRuntimeEvents>;

/**
 * The daemon's AgentRuntime and the relay's HTTP middleware. With the effective placement
 * `always_on_machine` and a credential, it holds one WebSocket to the machine (`MachineLink`):
 * while that link is up (or first connecting) the allowlisted agent routes (`routes.ts`) go to the
 * machine, and the machine's agent events reach this device's clients in place of the local
 * runtime's. Otherwise (unreachable, not paired) reads are served by the local runtime (a
 * read-only view of the synced sidecar on a device that doesn't hold the agent), routine file
 * edits are made locally, and agent actions answer 503 `agent_unavailable` saying why. Notes,
 * search, settings, sync and device routes never go through the relay.
 */
export class AgentRelay implements AgentRuntime {
  readonly mode: AgentMode;
  readonly #local: AgentRuntime;
  readonly #options: AgentRelayOptions;
  readonly #logger: Logger;
  readonly #events = new Emitter<RuntimeEventMap>();
  readonly #unsubscribes: Unsubscribe[] = [];
  readonly #surfaces = new Map<
    string,
    { threadId: string; surface: SurfaceKind; count: number; release: Unsubscribe }
  >();
  #state: RelayState = "off";
  #problem: string | undefined;
  #credential: MachineCredential | null = null;
  #link: MachineLink | null = null;
  /** The machine's last agent status, while the link is up. */
  #remote: AgentStatusResponse | null = null;
  /** Threads and approvals the machine pushed since the last resync began (newer than it). */
  readonly #pushed = new Set<string>();
  #resyncs = 0;
  #started = false;
  #stopped = false;

  constructor(options: AgentRelayOptions) {
    this.#options = options;
    this.#local = options.local;
    this.mode = options.local.mode;
    this.#logger = options.logger;
    for (const event of RUNTIME_EVENTS) {
      this.#unsubscribes.push(
        this.#local.on(event, (payload) => this.#fromLocal(event, payload as never)),
      );
    }
    this.#unsubscribes.push(
      options.placement.onChange(() => this.#apply()),
      options.machine.onChange(() => this.#apply()),
    );
    this.#apply();
  }

  /** `off` while the agent isn't relayed; otherwise how the relay to the machine is doing. */
  get state(): RelayState {
    return this.#state;
  }

  async start(): Promise<void> {
    this.#started = true;
    this.#link?.connect();
    await this.#local.start();
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#stopped = true;
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
    this.#link?.close();
    this.#link = null;
    await this.#local.stop();
  }

  /** Forwards the allowlisted agent routes while relaying; everything else goes on locally. */
  middleware(): MiddlewareHandler {
    return async (c, next) => {
      if (this.#state === "off") return next();
      const route = matchRelayRoute(c.req.method, new URL(c.req.url));
      if (!route) return next();
      const credential = this.#forwarding ? this.#credential : null;
      if (!credential && route.kind === "action") return this.#unavailable(c);
      const answer = credential ? await this.#forward(c, route, credential) : null;
      if (answer) return answer;
      await next();
    };
  }

  status(): AgentStatusResponse {
    const local = this.#local.status();
    if (this.#state === "off") return local;
    if (this.#forwarding && this.#remote) return this.#merge(this.#remote, local);
    // This device's own reason (e.g. who holds the lease) isn't what stops the relayed agent.
    const { problem: _localProblem, ...rest } = local;
    return {
      ...rest,
      placement: this.#placementBlock(local, null),
      ...(this.#problem ? { problem: this.#problem } : {}),
    };
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.#local.setEnabled(enabled);
  }

  updateSettings(settings: AppSettings): void {
    this.#local.updateSettings(settings);
  }

  /** The machine's orchestrator holds off on a task the user is still typing, wherever it is. */
  noteEditorActivity(notePath: string, line: number): void {
    if (this.#forwarding) this.#link?.send({ type: "editor.activity", notePath, line });
    else this.#local.noteEditorActivity(notePath, line);
  }

  getTaskRecords(notePath: string): TaskAgentRecord[] {
    return this.#local.getTaskRecords(notePath);
  }

  listThreads(filter?: {
    notePath?: string;
    taskId?: string;
    routineId?: string;
  }): ThreadSummary[] {
    return this.#local.listThreads(filter);
  }

  getThread(id: string): { thread: Thread; approvals: ApprovalRequest[] } | undefined {
    return this.#local.getThread(id);
  }

  listApprovals(filter?: { status?: ApprovalStatus }): ApprovalRequest[] {
    return this.#local.listApprovals(filter);
  }

  readArtifact(
    threadId: string,
    artifactId: string,
  ): Promise<{ meta: ArtifactMeta; body: Uint8Array } | null> {
    return this.#local.readArtifact(threadId, artifactId);
  }

  // Agent actions reach these only when they weren't forwarded; while the agent is relayed, this
  // device's own runtime must not act.

  async postUserMessage(threadId: string, text: string): Promise<void> {
    this.#assertLocal();
    await this.#local.postUserMessage(threadId, text);
  }

  async decideApproval(id: string, decision: ApprovalDecisionRequest): Promise<ApprovalRequest> {
    this.#assertLocal();
    return this.#local.decideApproval(id, decision);
  }

  async cancelThread(threadId: string): Promise<void> {
    this.#assertLocal();
    await this.#local.cancelThread(threadId);
  }

  async retryThread(threadId: string): Promise<void> {
    this.#assertLocal();
    await this.#local.retryThread(threadId);
  }

  markThreadRead(threadId: string): void {
    if (this.#forwarding) this.#link?.send({ type: "thread.read", threadId });
    else this.#local.markThreadRead(threadId);
  }

  /** Watched through the link while relaying (it subscribes again whenever it reconnects). */
  subscribeSurface(threadId: string, surface: SurfaceKind): Unsubscribe {
    const key = `${threadId}\u0000${surface}`;
    const entry = this.#surfaces.get(key);
    if (entry) entry.count++;
    else {
      const release = this.#surfaceSource().subscribeSurface(threadId, surface);
      this.#surfaces.set(key, { threadId, surface, count: 1, release });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#surfaces.get(key);
      if (!current || --current.count > 0) return;
      this.#surfaces.delete(key);
      current.release();
    };
  }

  listRoutines(): Routine[] {
    return this.#local.listRoutines();
  }

  getRoutine(id: string): Routine | undefined {
    return this.#local.getRoutine(id);
  }

  createRoutine(input: CreateRoutineRequest): Promise<Routine> {
    return this.#local.createRoutine(input);
  }

  setRoutinePaused(id: string, paused: boolean): Promise<Routine> {
    return this.#local.setRoutinePaused(id, paused);
  }

  async runRoutine(id: string): Promise<RoutineRunResponse> {
    this.#assertLocal();
    return this.#local.runRoutine(id);
  }

  on<K extends keyof AgentRuntimeEvents>(
    event: K,
    listener: (payload: AgentRuntimeEvents[K]) => void,
  ): Unsubscribe {
    return this.#events.on(event, listener);
  }

  // ── State ─────────────────────────────────────────────────────────────

  /** Requests and events go to the machine: its link is up, or connecting for the first time. */
  get #forwarding(): boolean {
    return (
      this.#credential !== null && (this.#state === "connected" || this.#state === "connecting")
    );
  }

  /** Follows the placement and the credential: relay or not, and to which machine. */
  #apply(): void {
    if (this.#stopped) return;
    if (this.#options.placement.current().effective !== "always_on_machine") {
      this.#transition(null, "off", undefined);
      return;
    }
    const stored = this.#options.machine.current();
    const credential = validCredential(stored);
    if (!credential) {
      if (stored) this.#logger.warn("The always-on machine's address isn't valid; not relaying");
      this.#transition(null, "not_paired", RELAY_PROBLEMS.notPaired);
      return;
    }
    const link = this.#link;
    if (
      link &&
      link.credential.url === credential.url &&
      link.credential.token === credential.token
    ) {
      return;
    }
    const next = new MachineLink({
      credential,
      onState: (state) => this.#onLinkState(next, state),
      onEvent: (event) => this.#fromMachine(next, event),
      logger: this.#logger,
      ...(this.#options.linkTimings ? { timings: this.#options.linkTimings } : {}),
    });
    this.#transition(next, "connecting", undefined);
    if (this.#started) next.connect();
  }

  /**
   * Moves to `state` with `link` (the current one when undefined). When requests and events stop
   * going to the machine, this device's routines are pushed to clients again (they're files); the
   * `relay` change in `agent.status` tells clients to fetch the rest again.
   */
  #transition(
    link: MachineLink | null | undefined,
    state: RelayState,
    problem: string | undefined,
  ): void {
    const wasForwarding = this.#forwarding;
    if (link !== undefined && link !== this.#link) this.#useLink(link);
    this.#setState(state, problem);
    if (wasForwarding && !this.#forwarding) {
      this.#events.emit("routines.changed", this.#local.listRoutines());
    }
  }

  #useLink(link: MachineLink | null): void {
    this.#link?.close();
    this.#link = link;
    this.#credential = link?.credential ?? null;
    this.#remote = null;
    for (const entry of this.#surfaces.values()) {
      entry.release();
      entry.release = this.#surfaceSource().subscribeSurface(entry.threadId, entry.surface);
    }
  }

  #surfaceSource(): Pick<AgentRuntime, "subscribeSurface"> {
    return this.#link ?? this.#local;
  }

  #onLinkState(link: MachineLink, state: LinkState): void {
    if (link !== this.#link) return;
    switch (state) {
      case "connecting":
        return;
      case "connected":
        this.#transition(undefined, "connected", undefined);
        void this.#resync(link);
        return;
      case "unreachable":
        this.#remote = null;
        this.#transition(undefined, "unreachable", RELAY_PROBLEMS.unreachable);
        return;
      case "rejected":
        this.#remote = null;
        this.#transition(undefined, "not_paired", RELAY_PROBLEMS.rejected);
        return;
    }
  }

  #setState(state: RelayState, problem: string | undefined): void {
    if (state === this.#state && problem === this.#problem) return;
    this.#state = state;
    this.#problem = problem;
    this.#options.placement.setRelay?.(state === "off" ? null : state);
    this.#events.emit("status", this.status());
  }

  #assertLocal(): void {
    if (this.#state !== "off") {
      throw new AgentUnavailableError(this.#problem ?? RELAY_PROBLEMS.unreachable);
    }
  }

  #fromLocal<K extends keyof AgentRuntimeEvents>(event: K, payload: AgentRuntimeEvents[K]): void {
    if (event === "status") {
      this.#events.emit("status", this.status());
      return;
    }
    if (!this.#forwarding) this.#events.emit(event, payload);
  }

  /** The machine's agent events, as this device's clients get them. */
  #fromMachine(link: MachineLink, event: ServerEvent): void {
    if (link !== this.#link || this.#state !== "connected") return;
    const emit = this.#events;
    switch (event.type) {
      case "agent.status":
        this.#remote = event.status;
        emit.emit("status", this.status());
        return;
      case "thread.upsert":
        this.#pushed.add(event.thread.id);
        emit.emit("thread.upsert", event.thread);
        return;
      case "thread.message":
        emit.emit("thread.message", { threadId: event.threadId, message: event.message });
        return;
      case "thread.delta":
        emit.emit("thread.delta", {
          threadId: event.threadId,
          messageId: event.messageId,
          delta: event.delta,
        });
        return;
      case "approval.upsert":
        this.#pushed.add(event.approval.id);
        emit.emit("approval.upsert", event.approval);
        return;
      case "task.records":
        emit.emit("task.records", { notePath: event.notePath, records: event.records });
        return;
      case "task.record":
        emit.emit("task.record", event.record);
        return;
      case "surface.frame": {
        const { type: _type, ...frame } = event;
        emit.emit("surface.frame", frame);
        return;
      }
      case "routines.changed":
        emit.emit("routines.changed", event.routines);
        return;
      case "routine.notification":
        emit.emit("routine.notification", event.notification);
        return;
      default:
        // hello, errors, and the machine's own vault and settings events: this device has its own.
        return;
    }
  }

  /**
   * After every (re)connection, this device's clients may have missed events: push the machine's
   * status, routines, approvals and thread summaries (skipping what the machine pushed meanwhile,
   * which is newer).
   */
  async #resync(link: MachineLink): Promise<void> {
    const round = ++this.#resyncs;
    this.#pushed.clear();
    const read = async <S extends z.ZodType>(target: string, schema: S) => {
      const answer = await callMachine(link.credential, { method: "GET", target }, this.#timeout);
      if (answer.status !== 200) return undefined;
      const parsed = schema.safeParse(parseJson(answer.body));
      return parsed.success ? parsed.data : undefined;
    };
    let answers: [unknown, unknown, unknown, unknown];
    try {
      answers = await Promise.all([
        read(API_ROUTES.agentStatus, AgentStatusResponseSchema),
        read(API_ROUTES.routines, RoutineListResponseSchema),
        read(API_ROUTES.approvals, ApprovalListResponseSchema),
        read(API_ROUTES.threads, ThreadListResponseSchema),
      ]);
    } catch (error) {
      this.#logger.debug("Couldn't resync with the always-on machine", {
        error: errorMessage(error),
      });
      return;
    }
    if (round !== this.#resyncs || link !== this.#link || this.#state !== "connected") return;
    const [status, routines, approvals, threads] = answers as [
      AgentStatusResponse | undefined,
      RoutineListResponse | undefined,
      ApprovalListResponse | undefined,
      ThreadListResponse | undefined,
    ];
    if (status) this.#remote = status;
    this.#events.emit("status", this.status());
    if (routines) this.#events.emit("routines.changed", routines.routines);
    for (const approval of approvals?.approvals ?? []) {
      if (!this.#pushed.has(approval.id)) this.#events.emit("approval.upsert", approval);
    }
    for (const thread of threads?.threads ?? []) {
      if (!this.#pushed.has(thread.id)) this.#events.emit("thread.upsert", thread);
    }
  }

  get #timeout(): { timeoutMs?: number } {
    return this.#options.timeoutMs ? { timeoutMs: this.#options.timeoutMs } : {};
  }

  // ── HTTP ──────────────────────────────────────────────────────────────

  /** The machine's answer, or null to go on locally. */
  async #forward(
    c: Context,
    route: RelayRoute,
    credential: MachineCredential,
  ): Promise<Response | null> {
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (route.body) {
      await readJson(c, route.body);
      body = new Uint8Array(await c.req.arrayBuffer());
    }
    let answer: MachineAnswer;
    try {
      answer = await callMachine(
        credential,
        {
          method: route.method,
          target: route.target,
          binary: route.binary,
          ...(body ? { body } : {}),
        },
        this.#timeout,
      );
    } catch (error) {
      if (!(error instanceof MachineUnavailableError)) throw error;
      this.#logger.debug("The always-on machine didn't answer a relayed request", {
        route: route.name,
        method: route.method,
        reason: error.message,
      });
      if (route.kind !== "action") return null;
      const problem =
        error.reason === "rejected" ? RELAY_PROBLEMS.rejected : RELAY_PROBLEMS.unreachable;
      return c.json(errorBody("agent_unavailable", problem), 503);
    }
    if (route.name === "agentStatus" && answer.status === 200) {
      const remote = AgentStatusResponseSchema.safeParse(parseJson(answer.body));
      if (!remote.success) return null;
      this.#remote = remote.data as AgentStatusResponse;
      return c.json(this.#merge(this.#remote, this.#local.status()));
    }
    const status = answer.status as ContentfulStatusCode;
    if (route.binary && answer.status === 200) {
      return c.body(
        bytes(answer.body),
        status,
        relayedArtifactHeaders(answer.contentType, answer.disposition),
      );
    }
    return c.body(bytes(answer.body), status, { "Content-Type": "application/json" });
  }

  #unavailable(c: Context): Response {
    return c.json(errorBody("agent_unavailable", this.#problem ?? RELAY_PROBLEMS.unreachable), 503);
  }

  // ── Status ────────────────────────────────────────────────────────────

  /**
   * The machine's agent status as this device reports it: the machine's agent (counts, mode,
   * connectors, execution, problem) with this device's placement block and readiness.
   */
  #merge(remote: AgentStatusResponse, local: AgentStatusResponse): AgentStatusResponse {
    const { placement: remotePlacement, readiness: _machineReadiness, ...agent } = remote;
    return {
      ...agent,
      placement: this.#placementBlock(local, remotePlacement?.runsOn),
      ...(local.readiness ? { readiness: local.readiness } : {}),
    };
  }

  #placementBlock(
    local: AgentStatusResponse,
    machineRunsOn: AgentRunsOn | null | undefined,
  ): AgentPlacementStatus {
    const block = local.placement ?? {
      placement: this.#options.placement.current().effective,
      runsOn: machineRunsOn ? { ...machineRunsOn, thisDevice: false } : null,
      relay: this.#state,
    };
    return { ...block, relay: this.#state };
  }
}

function validCredential(credential: MachineCredential | null): MachineCredential | null {
  if (!credential || credential.token.length === 0) return null;
  const url = normalizeMachineUrl(credential.url);
  return url ? { url, token: credential.token } : null;
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

function bytes(body: Uint8Array): Uint8Array<ArrayBuffer> {
  return body.buffer instanceof ArrayBuffer
    ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    : new Uint8Array(body);
}
