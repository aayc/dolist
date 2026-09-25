import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, AgentRuntimeEvents } from "@ddl/agent";
import { RoutineLibrary, UnknownRoutineError } from "@ddl/agent/routines";
import {
  type AgentMode,
  type AgentPlacement,
  type AgentPlacementStatus,
  type AgentStatusResponse,
  type ApprovalDecisionRequest,
  type ApprovalRequest,
  type ApprovalStatus,
  type AppSettings,
  type ArtifactMeta,
  CLIENT_ID_HEADER,
  type ComputerPermissionPane,
  type CreateRoutineRequest,
  Emitter,
  type Logger,
  type OrchestratorActivity,
  type RelayState,
  type Routine,
  type RoutineRunResponse,
  type SurfaceKind,
  type SyncStatusResponse,
  silentLogger,
  summarizeThread,
  type TaskAgentRecord,
  type Thread,
  type ThreadSummary,
  type Unsubscribe,
} from "@ddl/core";
import { MemoryStorageProvider, type StorageProvider } from "@ddl/storage";
import type { Hono, MiddlewareHandler } from "hono";
import type {
  MachineCredential,
  MachineCredentialSource,
  PlacementSnapshot,
  PlacementSource,
} from "./agent-location";
import { createApp } from "./app";
import type { DeviceSettings } from "./device-settings";
import type { MachineLink } from "./machine-link";
import { PairedDeviceStore } from "./paired-devices";
import { PairingCodes } from "./pairing";
import { createRemoteHosts, type RemoteHostRegistry } from "./remote-hosts";
import { createSettingsStore, type SettingsStore } from "./settings-store";
import type { SystemSettingsOpener } from "./system-settings";
import { WriteTracker } from "./write-tracker";

export const TEST_PORT = 7331;
export const TEST_HOST = `127.0.0.1:${TEST_PORT}`;

/** A placement source (like the agent supervisor) that changes only when told to. */
export class SettablePlacement implements PlacementSource {
  #effective: AgentPlacement;
  #relay: RelayState | null = null;
  readonly #listeners = new Set<(snapshot: PlacementSnapshot) => void>();

  constructor(effective: AgentPlacement = "this_device") {
    this.#effective = effective;
  }

  /** The last state the relay reported. */
  get relay(): RelayState | null {
    return this.#relay;
  }

  current(): PlacementSnapshot {
    return { placement: this.#effective, effective: this.#effective, runsOn: null };
  }

  status(): AgentPlacementStatus {
    return { placement: this.#effective, runsOn: null, relay: this.#relay ?? "off" };
  }

  set(effective: AgentPlacement): void {
    if (effective === this.#effective) return;
    this.#effective = effective;
    for (const listener of [...this.#listeners]) listener(this.current());
  }

  onChange(listener: (snapshot: PlacementSnapshot) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  setRelay(state: RelayState | null): void {
    this.#relay = state;
  }
}

/** A machine credential source (like the machine link) that changes only when told to. */
export class SettableMachineCredential implements MachineCredentialSource {
  #credential: MachineCredential | null;
  readonly #listeners = new Set<(credential: MachineCredential | null) => void>();

  constructor(credential: MachineCredential | null = null) {
    this.#credential = credential;
  }

  current(): MachineCredential | null {
    return this.#credential;
  }

  set(credential: MachineCredential | null): void {
    this.#credential = credential;
    for (const listener of [...this.#listeners]) listener(credential);
  }

  onChange(listener: (credential: MachineCredential | null) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

export function testToken(): string {
  return randomBytes(32).toString("hex");
}

/** A fresh temp directory, removed by the returned cleanup. */
export function tempDir(prefix = "ddl-daemon-"): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

type RuntimeEventMap = { [K in keyof AgentRuntimeEvents]: AgentRuntimeEvents[K] };

/** Scriptable AgentRuntime that records every call and lets tests emit runtime events. */
export class FakeAgentRuntime implements AgentRuntime {
  readonly mode: AgentMode = "mock";
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly threads = new Map<string, Thread>();
  readonly records = new Map<string, TaskAgentRecord[]>();
  readonly artifacts = new Map<string, { meta: ArtifactMeta; body: Uint8Array }>();
  readonly activeSurfaces = new Map<string, number>();
  approvals: ApprovalRequest[] = [];
  enabled = true;
  /** Makes thread actions take this long (to exercise the 202 path). */
  actionDelayMs = 0;
  actionError: Error | undefined;
  /** Routine files, read and written like the real runtime does (in its own vault by default). */
  readonly routineLibrary: RoutineLibrary;
  /** Makes creating, pausing, resuming and running routines fail with this. */
  routineError: Error | undefined;
  /** What `status()` says the orchestrator is doing (absent when unset). */
  orchestrator: OrchestratorActivity | undefined;
  private readonly events = new Emitter<RuntimeEventMap>();
  private runs = 0;

  constructor(options: { storage?: StorageProvider } = {}) {
    this.routineLibrary = new RoutineLibrary({
      storage: options.storage ?? new MemoryStorageProvider(),
    });
  }

  async start(): Promise<void> {
    this.track("start");
    await this.routineLibrary.start();
  }

  async stop(): Promise<void> {
    this.track("stop");
    this.routineLibrary.stop();
  }

  status(): AgentStatusResponse {
    return {
      mode: this.mode,
      enabled: this.enabled,
      model: "mock",
      running: 0,
      queued: 0,
      pendingApprovals: this.approvals.filter((a) => a.status === "pending").length,
      connectors: [],
      execution: {
        provider: "fake",
        capabilities: { shell: false, browser: true, computer: false },
      },
      ...(this.orchestrator ? { orchestrator: this.orchestrator } : {}),
    };
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.track("setEnabled", enabled);
    this.enabled = enabled;
  }

  updateSettings(settings: AppSettings): void {
    this.track("updateSettings", settings);
    this.enabled = settings.agent.enabled;
  }

  noteEditorActivity(notePath: string, line: number): void {
    this.track("noteEditorActivity", notePath, line);
  }

  getTaskRecords(notePath: string): TaskAgentRecord[] {
    this.track("getTaskRecords", notePath);
    return this.records.get(notePath) ?? [];
  }

  listThreads(filter?: {
    notePath?: string;
    taskId?: string;
    routineId?: string;
  }): ThreadSummary[] {
    this.track("listThreads", filter);
    return [...this.threads.values()]
      .filter((t) => !filter?.notePath || t.notePath === filter.notePath)
      .filter((t) => !filter?.taskId || t.taskId === filter.taskId)
      .filter((t) => !filter?.routineId || t.routineId === filter.routineId)
      .map((t) => summarizeThread(t));
  }

  getThread(id: string): { thread: Thread; approvals: ApprovalRequest[] } | undefined {
    const thread = this.threads.get(id);
    return thread
      ? { thread, approvals: this.approvals.filter((a) => a.threadId === id) }
      : undefined;
  }

  listApprovals(filter?: { status?: ApprovalStatus }): ApprovalRequest[] {
    return this.approvals.filter((a) => !filter?.status || a.status === filter.status);
  }

  async readArtifact(
    threadId: string,
    artifactId: string,
  ): Promise<{ meta: ArtifactMeta; body: Uint8Array } | null> {
    return this.artifacts.get(`${threadId}/${artifactId}`) ?? null;
  }

  async postUserMessage(threadId: string, text: string): Promise<void> {
    this.track("postUserMessage", threadId, text);
    await this.runAction();
  }

  async decideApproval(id: string, decision: ApprovalDecisionRequest): Promise<ApprovalRequest> {
    this.track("decideApproval", id, decision);
    const index = this.approvals.findIndex((a) => a.id === id);
    const current = this.approvals[index];
    if (!current) throw new Error(`Unknown approval ${id}`);
    const decided: ApprovalRequest = {
      ...current,
      status: decision.decision === "approve" ? "approved" : "denied",
      decidedAt: Date.now(),
      ...(decision.scope ? { scope: decision.scope } : {}),
      ...(decision.note ? { decisionNote: decision.note } : {}),
    };
    this.approvals[index] = decided;
    return decided;
  }

  async cancelThread(threadId: string): Promise<void> {
    this.track("cancelThread", threadId);
    await this.runAction();
  }

  async retryThread(threadId: string): Promise<void> {
    this.track("retryThread", threadId);
    await this.runAction();
  }

  markThreadRead(threadId: string): void {
    this.track("markThreadRead", threadId);
  }

  subscribeSurface(threadId: string, surface: SurfaceKind): Unsubscribe {
    const key = `${threadId}:${surface}`;
    this.track("subscribeSurface", threadId, surface);
    this.activeSurfaces.set(key, (this.activeSurfaces.get(key) ?? 0) + 1);
    return () => {
      this.track("releaseSurface", threadId, surface);
      this.activeSurfaces.set(key, (this.activeSurfaces.get(key) ?? 1) - 1);
    };
  }

  listRoutines(): Routine[] {
    return this.routineLibrary.list();
  }

  getRoutine(id: string): Routine | undefined {
    return this.routineLibrary.get(id);
  }

  async createRoutine(input: CreateRoutineRequest): Promise<Routine> {
    this.track("createRoutine", input);
    if (this.routineError) throw this.routineError;
    return this.routineLibrary.create(input);
  }

  async setRoutinePaused(id: string, paused: boolean): Promise<Routine> {
    this.track("setRoutinePaused", id, paused);
    if (this.routineError) throw this.routineError;
    return this.routineLibrary.setPaused(id, paused);
  }

  /** Records a run thread (`thr_run_<n>`) under the routine, as the real scheduler would. */
  async runRoutine(id: string): Promise<RoutineRunResponse> {
    this.track("runRoutine", id);
    if (this.routineError) throw this.routineError;
    const routine = this.routineLibrary.get(id);
    if (!routine) throw new UnknownRoutineError(`with id ${id}`);
    const threadId = `thr_run_${++this.runs}`;
    this.threads.set(
      threadId,
      makeThread(threadId, {
        taskId: `run_${this.runs}`,
        notePath: routine.path,
        title: routine.name,
        routineId: routine.id,
      }),
    );
    return { routine, threadId };
  }

  on<K extends keyof AgentRuntimeEvents>(
    event: K,
    listener: (payload: AgentRuntimeEvents[K]) => void,
  ): Unsubscribe {
    return this.events.on(event, listener);
  }

  emit<K extends keyof AgentRuntimeEvents>(event: K, payload: AgentRuntimeEvents[K]): void {
    this.events.emit(event, payload);
  }

  callsTo(method: string): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  private track(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  private async runAction(): Promise<void> {
    if (this.actionDelayMs > 0) await new Promise((r) => setTimeout(r, this.actionDelayMs));
    if (this.actionError) throw this.actionError;
  }
}

export function makeThread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    taskId: `task_${id}`,
    notePath: "Daily/2026-09-23.md",
    title: "Find a dentist",
    status: "working",
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    artifacts: [],
    surfaces: ["browser"],
    ...overrides,
  };
}

export function makeApproval(
  id: string,
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    id,
    threadId: "thr_1",
    taskId: "task_thr_1",
    toolName: "browser_click",
    input: { element: "Book appointment button" },
    summary: "Click “Book appointment”",
    risk: "high",
    categories: ["booking"],
    reason: "Booking commits the user to an appointment",
    status: "pending",
    createdAt: 1,
    ...overrides,
  };
}

export interface TestRequestInit {
  method?: string;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
  /** `null` sends no Authorization header. */
  token?: string | null;
  origin?: string;
  /** `null` sends no Host header (the request URL's host is used instead). */
  host?: string | null;
  clientId?: string;
}

/** Records the panes it was asked to open (and opens nothing). */
export class FakeSystemSettings implements SystemSettingsOpener {
  readonly opened: ComputerPermissionPane[] = [];
  outcome: "opened" | "unsupported" | Error = "opened";

  async open(pane: ComputerPermissionPane): Promise<"opened" | "unsupported"> {
    if (this.outcome instanceof Error) throw this.outcome;
    if (this.outcome === "opened") this.opened.push(pane);
    return this.outcome;
  }
}

export interface TestAppOptions<S extends StorageProvider = MemoryStorageProvider> {
  storage?: S;
  runtime?: AgentRuntime;
  settings?: SettingsStore;
  webDist?: string | null;
  allowedOrigins?: string[];
  remoteHosts?: RemoteHostRegistry;
  devices?: PairedDeviceStore;
  pairing?: PairingCodes;
  syncStatus?: () => SyncStatusResponse;
  now?: () => Date;
  logger?: Logger;
  systemSettings?: FakeSystemSettings;
  device?: DeviceSettings;
  machine?: MachineLink;
  relay?: { middleware(): MiddlewareHandler };
}

export interface TestApp<S extends StorageProvider = MemoryStorageProvider> {
  app: Hono;
  storage: S;
  runtime: AgentRuntime;
  settings: SettingsStore;
  remoteHosts: RemoteHostRegistry;
  devices: PairedDeviceStore;
  pairing: PairingCodes;
  token: string;
  writes: WriteTracker;
  systemSettings: FakeSystemSettings;
  request(path: string, init?: TestRequestInit): Promise<Response>;
}

/**
 * The app over a vault (in-memory unless `storage` is given), addressed as `http://127.0.0.1:7331`
 * with a valid token.
 */
export async function createTestApp<S extends StorageProvider = MemoryStorageProvider>(
  options: TestAppOptions<S> = {},
): Promise<TestApp<S>> {
  const storage = options.storage ?? (new MemoryStorageProvider() as StorageProvider as S);
  const runtime = options.runtime ?? new FakeAgentRuntime({ storage });
  const settings = options.settings ?? (await createSettingsStore({ storage }));
  const token = testToken();
  const writes = new WriteTracker();
  const systemSettings = options.systemSettings ?? new FakeSystemSettings();
  const remoteHosts = options.remoteHosts ?? createRemoteHosts();
  const devices = options.devices ?? new PairedDeviceStore({ path: null, logger: silentLogger });
  const pairing = options.pairing ?? new PairingCodes();
  const app = createApp({
    storage,
    runtime,
    settings,
    config: { port: TEST_PORT, allowedOrigins: options.allowedOrigins ?? [] },
    token,
    remoteHosts,
    devices,
    pairing,
    logger: options.logger ?? silentLogger,
    webDist: options.webDist ?? null,
    writes,
    ...(options.syncStatus ? { syncStatus: options.syncStatus } : {}),
    ...(options.device ? { device: options.device } : {}),
    ...(options.machine ? { machine: options.machine } : {}),
    systemSettings,
    ...(options.now ? { now: options.now } : {}),
    ...(options.relay ? { relay: options.relay } : {}),
  });

  const request = (path: string, init: TestRequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (init.host !== null) headers.set("host", init.host ?? TEST_HOST);
    if (init.token !== null) headers.set("authorization", `Bearer ${init.token ?? token}`);
    if (init.origin !== undefined) headers.set("origin", init.origin);
    if (init.clientId !== undefined) headers.set(CLIENT_ID_HEADER, init.clientId);
    let body = init.body;
    if (init.json !== undefined) {
      body = JSON.stringify(init.json);
      headers.set("content-type", "application/json");
    }
    return Promise.resolve(
      app.request(`http://${TEST_HOST}${path}`, {
        method: init.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
      }),
    );
  };

  return {
    app,
    storage,
    runtime,
    settings,
    remoteHosts,
    devices,
    pairing,
    token,
    writes,
    systemSettings,
    request,
  };
}
