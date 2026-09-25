/**
 * The agent relay: while this device's agent runs on the always-on machine, its agent routes are
 * forwarded there, so this device's clients show and act on the machine's agent. Otherwise
 * everything stays local (the local runtime answers, as without a relay).
 */
import type { AgentRuntime, AgentRuntimeEvents } from "@ddl/agent";
import {
  type AgentMode,
  type AgentPlacementStatus,
  type AgentRunsOn,
  type AgentStatusResponse,
  type ApprovalDecisionRequest,
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
  type RoutineRunResponse,
  type SurfaceKind,
  type TaskAgentRecord,
  type Thread,
  type ThreadSummary,
  type Unsubscribe,
} from "@ddl/core";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { errorBody } from "../errors";
import { readJson } from "../http-utils";
import { AgentUnavailableError } from "../null-runtime";
import { relayedArtifactHeaders } from "../routes/artifacts";
import { callMachine, type MachineAnswer, MachineUnavailableError } from "./http";
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
 * The daemon's AgentRuntime and the HTTP middleware of the relay. With the effective placement
 * `always_on_machine` and a credential, the allowlisted agent routes (`routes.ts`) go to the
 * machine. When the machine can't answer (or this device isn't paired), reads are served by the
 * local runtime (a read-only view of the synced sidecar on a device that doesn't hold the agent),
 * routine file edits are made locally, and agent actions answer 503 `agent_unavailable` saying
 * why. Notes, search, settings, sync and device routes never go through the relay.
 */
export class AgentRelay implements AgentRuntime {
  readonly mode: AgentMode;
  readonly #local: AgentRuntime;
  readonly #options: AgentRelayOptions;
  readonly #logger: Logger;
  readonly #events = new Emitter<RuntimeEventMap>();
  readonly #unsubscribes: Unsubscribe[] = [];
  #state: RelayState = "off";
  #problem: string | undefined;
  #credential: MachineCredential | null = null;
  /** The machine's last agent status. */
  #remote: AgentStatusResponse | null = null;
  #started = false;

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
    this.#apply();
  }

  /** `off` while the agent isn't relayed; otherwise how the relay to the machine is doing. */
  get state(): RelayState {
    return this.#state;
  }

  async start(): Promise<void> {
    this.#started = true;
    await this.#local.start();
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
    await this.#local.stop();
  }

  /** Forwards the allowlisted agent routes while relaying; everything else goes on locally. */
  middleware(): MiddlewareHandler {
    return async (c, next) => {
      if (this.#state === "off") return next();
      const route = matchRelayRoute(c.req.method, new URL(c.req.url));
      if (!route) return next();
      const credential = this.#credential;
      if (!credential && route.kind === "action") return this.#unavailable(c);
      const answer = credential ? await this.#forward(c, route, credential) : null;
      if (answer) return answer;
      await next();
    };
  }

  status(): AgentStatusResponse {
    const local = this.#local.status();
    if (this.#state === "off") return local;
    if (this.#credential && this.#remote) return this.#merge(this.#remote, local);
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

  noteEditorActivity(notePath: string, line: number): void {
    this.#local.noteEditorActivity(notePath, line);
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
    this.#local.markThreadRead(threadId);
  }

  subscribeSurface(threadId: string, surface: SurfaceKind): Unsubscribe {
    return this.#local.subscribeSurface(threadId, surface);
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

  #apply(): void {
    if (this.#options.placement.current().effective !== "always_on_machine") {
      this.#credential = null;
      this.#setState("off", undefined);
      return;
    }
    const credential = validCredential(this.#options.machine.current());
    if (!credential) {
      if (this.#options.machine.current()) {
        this.#logger.warn("The always-on machine's address isn't valid; not relaying to it");
      }
      this.#credential = null;
      this.#setState("not_paired", RELAY_PROBLEMS.notPaired);
      return;
    }
    this.#credential = credential;
    this.#setState("connected", undefined);
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
    if (this.#state !== "off" && this.#credential) return;
    this.#events.emit(event, payload);
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
        { ...(this.#options.timeoutMs ? { timeoutMs: this.#options.timeoutMs } : {}) },
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
      const remote = parseJson(answer.body) as AgentStatusResponse | undefined;
      if (!remote) return null;
      this.#remote = remote;
      return c.json(this.#merge(remote, this.#local.status()));
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
