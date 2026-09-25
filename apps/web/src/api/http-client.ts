import {
  type AgentStatusResponse,
  API_ROUTES,
  API_VERSION,
  type ApprovalDecisionRequest,
  type ApprovalListResponse,
  type ApprovalRequest,
  CLIENT_ID_HEADER,
  type ClientEvent,
  type ComputerPermissionPane,
  type ComputerPermissionsOpenRequest,
  type ConnectorStatus,
  type CreateFolderRequest,
  type CreateRoutineRequest,
  createId,
  type DailyNoteResponse,
  type DeviceSettingsPatch,
  type DeviceSettingsResponse,
  type DeviceSyncSetupRequest,
  type DeviceVaultRequest,
  type DeviceVaultResponse,
  type HealthResponse,
  isCompatibleApiVersion,
  type MachinePairRequest,
  type MachineStatusResponse,
  type NoteResponse,
  type ObsidianImportJobResponse,
  type ObsidianImportPreview,
  type ObsidianImportPreviewRequest,
  type ObsidianImportRequest,
  type ObsidianImportStatusResponse,
  type PairedDevicesResponse,
  type PairingCodeRequest,
  type PairingCodeResponse,
  type PostMessageRequest,
  type RenameRequest,
  type RoutineListResponse,
  type RoutineResponse,
  type RoutineRunResponse,
  type SearchResponse,
  type ServerEvent,
  type SetAgentEnabledRequest,
  type SettingsResponse,
  type SyncStatusResponse,
  type TaskRecordsResponse,
  type ThreadListResponse,
  type ThreadResponse,
  type Unsubscribe,
  type UpdateSettingsRequest,
  type VaultTreeResponse,
  type WriteNoteRequest,
  type WriteNoteResponse,
  WS_CLOSE_CODES,
} from "@ddl/core";
import { reportError } from "../lib/report-error";
import type {
  ArtifactContent,
  ConnectionChange,
  ConnectionState,
  DaemonClient,
  ThreadFilter,
  WriteOptions,
} from "./client";
import { HttpError, NetworkError } from "./errors";
import { parseServerEvent } from "./events";
import { readResponse } from "./http-response";
import { ReconnectingSocket, type SocketLike } from "./socket";

export interface HttpDaemonClientOptions {
  /** Daemon origin; empty = same origin (the daemon serves the UI, or the Vite dev proxy). */
  baseUrl?: string;
  /**
   * Bearer token (a loopback page: from the injected meta tag; dev: the proxy adds it). Without
   * one, requests carry no Authorization header and the WebSocket URL no token: a remote page
   * authenticates with its device cookie, which the browser sends on same-origin requests.
   */
  token?: string | null;
  /**
   * Cookie auth: a request answered 401 means this browser's device was revoked. The socket can't
   * tell (a refused upgrade has no status), so a dropped socket is followed by a probe request.
   */
  onUnauthorized?: () => void;
  clientId?: string;
  /** Sent in the WebSocket hello for diagnostics. */
  clientVersion?: string;
  fetch?: typeof fetch;
  createSocket?: (url: string) => SocketLike;
  requestTimeoutMs?: number;
}

type Method = "GET" | "PUT" | "PATCH" | "POST" | "DELETE";

/** A dropped socket probes the auth at most this often (cookie auth). */
const AUTH_PROBE_MS = 5_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function surfaceKey(threadId: string, surface: string): string {
  return `${threadId}\u0000${surface}`;
}

/** URL parsers resolve `.`/`..` segments (even `%2e`) before a request leaves, changing the route. */
function hasDotSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

function isIncompatibleClose(event: unknown): boolean {
  return isObject(event) && event.code === WS_CLOSE_CODES.incompatibleApiVersion;
}

export class HttpDaemonClient implements DaemonClient {
  readonly kind = "http" as const;
  readonly clientId: string;
  readonly endpoint: string;
  private readonly clientVersion: string;
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly socket: ReconnectingSocket;
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private readonly connectionListeners = new Set<(change: ConnectionChange) => void>();
  private readonly surfaces = new Map<string, ClientEvent>();
  private readonly onUnauthorized: (() => void) | null;
  private lastAuthProbe = Number.NEGATIVE_INFINITY;
  private revoked = false;
  private state: ConnectionState = "offline";

  constructor(options: HttpDaemonClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.token = options.token ?? null;
    this.onUnauthorized = options.onUnauthorized ?? null;
    this.clientId = options.clientId ?? createId("web");
    this.clientVersion = options.clientVersion ?? `web/${__APP_VERSION__}`;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.requestTimeoutMs ?? 20_000;
    this.endpoint = this.baseUrl || (typeof location === "undefined" ? "" : location.origin);
    this.socket = new ReconnectingSocket({
      url: () => this.socketUrl(),
      createSocket: options.createSocket,
      pingMessage: JSON.stringify({ type: "ping" } satisfies ClientEvent),
      onOpen: () => this.handleOpen(),
      onMessage: (data) => this.handleMessage(data),
      isFatalClose: isIncompatibleClose,
      onStateChange: (state, reconnected) => {
        this.state = state;
        if (state === "reconnecting") this.probeAuth();
        for (const listener of this.connectionListeners) listener({ state, reconnected });
      },
    });
  }

  private probeAuth(): void {
    if (!this.onUnauthorized || Date.now() - this.lastAuthProbe < AUTH_PROBE_MS) return;
    this.lastAuthProbe = Date.now();
    this.health().catch(() => {
      // A 401 already went to onUnauthorized; anything else is the socket's to retry.
    });
  }

  private unauthorized(status: number): void {
    if (status !== 401 || !this.onUnauthorized || this.revoked) return;
    this.revoked = true;
    this.socket.close();
    this.onUnauthorized();
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  socketUrl(): string {
    const origin = this.baseUrl || location.origin;
    const url = new URL(API_ROUTES.ws, origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (this.token) url.searchParams.set("token", this.token);
    return url.toString();
  }

  connect(): void {
    this.socket.connect();
  }

  disconnect(): void {
    this.socket.close();
  }

  onEvent(listener: (event: ServerEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onConnectionChange(listener: (change: ConnectionChange) => void): Unsubscribe {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  send(event: ClientEvent): void {
    if (event.type === "surface.subscribe") {
      this.surfaces.set(surfaceKey(event.threadId, event.surface), event);
    } else if (event.type === "surface.unsubscribe") {
      this.surfaces.delete(surfaceKey(event.threadId, event.surface));
    }
    this.socket.send(JSON.stringify(event));
  }

  private handleOpen(): void {
    const hello: ClientEvent = {
      type: "hello",
      clientId: this.clientId,
      apiVersion: API_VERSION,
      clientVersion: this.clientVersion,
    };
    this.socket.send(JSON.stringify(hello));
    for (const subscription of this.surfaces.values())
      this.socket.send(JSON.stringify(subscription));
  }

  private handleMessage(data: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const event = parseServerEvent(raw);
    if (!event) return;
    if (event.type === "hello" && !isCompatibleApiVersion(event.apiVersion)) {
      reportError(
        new Error(`The daemon speaks API ${event.apiVersion}; this app needs ${API_VERSION}`),
      );
      this.socket.close();
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        reportError(error);
      }
    }
  }

  private async send_(method: Method, path: string, body?: unknown, keepalive = false) {
    const headers: Record<string, string> = {
      Accept: "application/json",
      [CLIENT_ID_HEADER]: this.clientId,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        keepalive,
        credentials: "same-origin",
        signal: keepalive ? undefined : AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new NetworkError(
        error instanceof Error ? error.message : "Could not reach the Daily Do List daemon",
      );
    }
  }

  private async request<T>(
    method: Method,
    path: string,
    body?: unknown,
    keepalive = false,
  ): Promise<T> {
    const response = await this.send_(method, path, body, keepalive);
    this.unauthorized(response.status);
    return readResponse<T>(response);
  }

  health(): Promise<HealthResponse> {
    return this.request("GET", API_ROUTES.health);
  }

  getTree(): Promise<VaultTreeResponse> {
    return this.request("GET", API_ROUTES.tree);
  }

  async readNote(path: string): Promise<NoteResponse> {
    return this.request("GET", noteRoute(path));
  }

  async writeNote(
    path: string,
    body: WriteNoteRequest,
    options: WriteOptions = {},
  ): Promise<WriteNoteResponse> {
    return this.request("PUT", noteRoute(path), body, options.keepalive ?? false);
  }

  async deleteNote(path: string): Promise<void> {
    await this.request("DELETE", noteRoute(path));
  }

  async renamePath(from: string, to: string): Promise<void> {
    await this.request("POST", API_ROUTES.rename, { from, to } satisfies RenameRequest);
  }

  async createFolder(path: string): Promise<void> {
    await this.request("POST", API_ROUTES.folders, { path } satisfies CreateFolderRequest);
  }

  async deleteFolder(path: string): Promise<void> {
    await this.request("DELETE", `${API_ROUTES.folders}?path=${encodeURIComponent(path)}`);
  }

  getDailyNote(date: string, create = true): Promise<DailyNoteResponse> {
    return this.request("GET", API_ROUTES.daily(date, create));
  }

  search(query: string): Promise<SearchResponse> {
    return this.request("GET", API_ROUTES.search(query));
  }

  getSettings(): Promise<SettingsResponse> {
    return this.request("GET", API_ROUTES.settings);
  }

  updateSettings(patch: UpdateSettingsRequest): Promise<SettingsResponse> {
    return this.request("PUT", API_ROUTES.settings, patch);
  }

  getAgentStatus(): Promise<AgentStatusResponse> {
    return this.request("GET", API_ROUTES.agentStatus);
  }

  async setAgentEnabled(enabled: boolean): Promise<AgentStatusResponse | null> {
    const body: SetAgentEnabledRequest = { enabled };
    const data = await this.request<unknown>("POST", API_ROUTES.agentEnabled, body);
    return isObject(data) && typeof data.enabled === "boolean"
      ? (data as unknown as AgentStatusResponse)
      : null;
  }

  async getConnectors(): Promise<ConnectorStatus[]> {
    const data = await this.request<unknown>("GET", API_ROUTES.connectors);
    if (Array.isArray(data)) return data as ConnectorStatus[];
    if (isObject(data) && Array.isArray(data.connectors))
      return data.connectors as ConnectorStatus[];
    return [];
  }

  getTaskRecords(notePath: string): Promise<TaskRecordsResponse> {
    return this.request("GET", API_ROUTES.tasks(notePath));
  }

  listThreads(filter: ThreadFilter = {}): Promise<ThreadListResponse> {
    const query = filter.routineId ? `?routineId=${encodeURIComponent(filter.routineId)}` : "";
    return this.request("GET", `${API_ROUTES.threads}${query}`);
  }

  getThread(id: string): Promise<ThreadResponse> {
    return this.request("GET", API_ROUTES.thread(id));
  }

  async postMessage(threadId: string, text: string): Promise<void> {
    await this.request("POST", API_ROUTES.threadMessages(threadId), {
      text,
    } satisfies PostMessageRequest);
  }

  async cancelThread(threadId: string): Promise<void> {
    await this.request("POST", API_ROUTES.threadCancel(threadId));
  }

  async retryThread(threadId: string): Promise<void> {
    await this.request("POST", API_ROUTES.threadRetry(threadId));
  }

  listApprovals(): Promise<ApprovalListResponse> {
    return this.request("GET", API_ROUTES.approvals);
  }

  async decideApproval(
    id: string,
    decision: ApprovalDecisionRequest,
  ): Promise<ApprovalRequest | null> {
    const data = await this.request<unknown>("POST", API_ROUTES.approval(id), decision);
    if (isObject(data) && isObject(data.approval))
      return data.approval as unknown as ApprovalRequest;
    if (isObject(data) && typeof data.id === "string") return data as unknown as ApprovalRequest;
    return null;
  }

  async openComputerPermissions(pane: ComputerPermissionPane): Promise<void> {
    const body: ComputerPermissionsOpenRequest = { pane };
    await this.request("POST", API_ROUTES.computerPermissionsOpen, body);
  }

  listRoutines(): Promise<RoutineListResponse> {
    return this.request("GET", API_ROUTES.routines);
  }

  getRoutine(id: string): Promise<RoutineResponse> {
    return this.request("GET", API_ROUTES.routine(id));
  }

  createRoutine(request: CreateRoutineRequest): Promise<RoutineResponse> {
    return this.request("POST", API_ROUTES.routines, request);
  }

  runRoutine(id: string): Promise<RoutineRunResponse> {
    return this.request("POST", API_ROUTES.routineRun(id));
  }

  pauseRoutine(id: string): Promise<RoutineResponse> {
    return this.request("POST", API_ROUTES.routinePause(id));
  }

  resumeRoutine(id: string): Promise<RoutineResponse> {
    return this.request("POST", API_ROUTES.routineResume(id));
  }

  getSyncStatus(): Promise<SyncStatusResponse> {
    return this.request("GET", API_ROUTES.syncStatus);
  }

  getDevice(): Promise<DeviceSettingsResponse> {
    return this.request("GET", API_ROUTES.device);
  }

  updateDevice(patch: DeviceSettingsPatch): Promise<DeviceSettingsResponse> {
    return this.request("PATCH", API_ROUTES.device, patch);
  }

  setupSync(request: DeviceSyncSetupRequest): Promise<DeviceSettingsResponse> {
    return this.request("PUT", API_ROUTES.deviceSync, request);
  }

  removeSync(): Promise<DeviceSettingsResponse> {
    return this.request("DELETE", API_ROUTES.deviceSync);
  }

  createPairingCode(request: PairingCodeRequest = {}): Promise<PairingCodeResponse> {
    return this.request("POST", API_ROUTES.pairingCodes, request);
  }

  listDevices(): Promise<PairedDevicesResponse> {
    return this.request("GET", API_ROUTES.devices);
  }

  async revokeDevice(id: string): Promise<void> {
    await this.request("DELETE", API_ROUTES.pairedDevice(id));
  }

  getMachine(): Promise<MachineStatusResponse> {
    return this.request("GET", API_ROUTES.machine);
  }

  pairMachine(request: MachinePairRequest): Promise<MachineStatusResponse> {
    return this.request("POST", API_ROUTES.machinePair, request);
  }

  checkMachine(): Promise<MachineStatusResponse> {
    return this.request("POST", API_ROUTES.machineCheck);
  }

  forgetMachine(): Promise<MachineStatusResponse> {
    return this.request("DELETE", API_ROUTES.machinePairing);
  }

  getVault(): Promise<DeviceVaultResponse> {
    return this.request("GET", API_ROUTES.deviceVault);
  }

  switchVault(path: string): Promise<DeviceVaultResponse> {
    return this.request("PUT", API_ROUTES.deviceVault, { path } satisfies DeviceVaultRequest);
  }

  previewObsidianImport(source: string): Promise<ObsidianImportPreview> {
    const body: ObsidianImportPreviewRequest = { source };
    return this.request("POST", API_ROUTES.importObsidianPreview, body);
  }

  getObsidianImport(): Promise<ObsidianImportStatusResponse> {
    return this.request("GET", API_ROUTES.importObsidian);
  }

  startObsidianImport(request: ObsidianImportRequest): Promise<ObsidianImportJobResponse> {
    return this.request("POST", API_ROUTES.importObsidian, request);
  }

  cancelObsidianImport(): Promise<ObsidianImportJobResponse> {
    return this.request("POST", API_ROUTES.importObsidianCancel);
  }

  updateFromObsidian(): Promise<ObsidianImportJobResponse> {
    return this.request("POST", API_ROUTES.importObsidianUpdate);
  }

  async getArtifact(threadId: string, artifactId: string): Promise<ArtifactContent> {
    const response = await this.send_("GET", API_ROUTES.artifact(threadId, artifactId));
    this.unauthorized(response.status);
    if (!response.ok) throw new HttpError(response.status, response.statusText || "Artifact error");
    const blob = await response.blob();
    const mimeType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ||
      blob.type ||
      "application/octet-stream";
    return { mimeType, blob };
  }
}

function noteRoute(path: string): string {
  if (hasDotSegment(path)) {
    throw new HttpError(400, `Invalid note path "${path}"`, { error: "invalid_path" });
  }
  return API_ROUTES.note(path);
}
