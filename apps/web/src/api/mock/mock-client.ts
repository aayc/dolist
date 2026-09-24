import {
  AGENT_HARNESS_KINDS,
  type AgentStatusResponse,
  API_VERSION,
  type ApprovalDecisionRequest,
  type ApprovalListResponse,
  type ApprovalRequest,
  type AppSettings,
  type ClientEvent,
  type ConnectorStatus,
  createId,
  type DailyNoteResponse,
  DEFAULT_SETTINGS,
  dailyNotePath,
  type HealthResponse,
  isHiddenPath,
  mergeSettings,
  type NoteResponse,
  normalizePath,
  parseISODate,
  type SearchResponse,
  type ServerEvent,
  type SettingsResponse,
  type TaskRecordsResponse,
  type ThreadListResponse,
  type ThreadResponse,
  today,
  toISODate,
  type Unsubscribe,
  type UpdateSettingsRequest,
  type VaultChange,
  type VaultTreeResponse,
  type WriteNoteRequest,
  type WriteNoteResponse,
} from "@ddl/core";
import { readJson, STORAGE_KEYS, writeJson } from "../../lib/storage";
import type { ArtifactContent, ConnectionChange, ConnectionState, DaemonClient } from "../client";
import { ConflictError, HttpError } from "../errors";
import { MOCK_CONNECTORS, MockAgent, MockNotFoundError } from "./mock-agent";
import { MockVault } from "./mock-vault";
import { renderDailyContent, seedVault } from "./seed";

export interface MockDaemonClientOptions {
  /** Agent time multiplier (tests use >1 to go faster). */
  speed?: number;
  /** Artificial REST latency in ms. */
  latencyMs?: number;
  /** Persist settings in localStorage so reloads keep them (like the real daemon). */
  persistSettings?: boolean;
  /** Install `window.__ddlMock` test hooks. */
  installHooks?: boolean;
}

export interface MockTestHooks {
  createNote(path: string, content: string): void;
  externalEdit(path: string, content: string): void;
  deleteNote(path: string): void;
  readNote(path: string): string | null;
  listPaths(): string[];
}

declare global {
  interface Window {
    __ddlMock?: MockTestHooks;
  }
}

const MOCK_DEFAULTS: AppSettings = mergeSettings(DEFAULT_SETTINGS, {
  agent: { settleMs: 1200, model: "mock/scripted-agent", judgeModel: "mock/scripted-judge" },
});

function clone<T>(value: T): T {
  return structuredClone(value);
}

function notFound(what: string): HttpError {
  const message = `${what} not found`;
  return new HttpError(404, message, { error: "not_found", message });
}

/** The daemon's path rules: canonical, inside the vault, never hidden (dot-files, the sidecar). */
function vaultPath(input: string): string {
  let path: string;
  try {
    path = normalizePath(input);
  } catch {
    path = "";
  }
  if (!path || isHiddenPath(path)) {
    const message = `Invalid vault path "${input}"`;
    throw new HttpError(400, message, { error: "invalid_path", message });
  }
  return path;
}

const MODEL_ID_KEYS = ["model", "cursorModel", "judgeModel"] as const;
/** The contract's `WIRE_LIMITS.modelIdLength` (zod stays out of the bundle). */
const MAX_MODEL_ID_LENGTH = 200;

/** The daemon's checks on the agent section: a known harness, and model ids trimmed to 1–200 chars. */
function checkedSettingsPatch(patch: UpdateSettingsRequest): UpdateSettingsRequest {
  const { agent } = patch;
  if (!agent) return patch;
  const problems: string[] = [];
  if (agent.harness !== undefined && !AGENT_HARNESS_KINDS.includes(agent.harness)) {
    problems.push(`agent.harness must be one of ${AGENT_HARNESS_KINDS.join(", ")}`);
  }
  const trimmed: Partial<Record<(typeof MODEL_ID_KEYS)[number], string>> = {};
  for (const key of MODEL_ID_KEYS) {
    const id = agent[key]?.trim();
    if (id === undefined) continue;
    if (id === "" || id.length > MAX_MODEL_ID_LENGTH) {
      problems.push(`agent.${key} must be 1-${MAX_MODEL_ID_LENGTH} characters`);
    }
    trimmed[key] = id;
  }
  if (problems.length > 0) {
    const message = `Invalid settings: ${problems.join("; ")}`;
    throw new HttpError(400, message, { error: "invalid_request", message });
  }
  return { ...patch, agent: { ...agent, ...trimmed } };
}

/** Fully in-browser daemon: in-memory vault + simulated agent speaking the real protocol. */
export class MockDaemonClient implements DaemonClient {
  readonly kind = "mock" as const;
  readonly clientId = createId("web");
  readonly endpoint = "in-browser mock";
  readonly vault = new MockVault();
  readonly agent: MockAgent;
  private settings: AppSettings;
  private readonly latencyMs: number;
  private readonly persistSettings: boolean;
  private state: ConnectionState = "offline";
  private readonly listeners = new Set<(event: ServerEvent) => void>();
  private readonly connectionListeners = new Set<(change: ConnectionChange) => void>();

  constructor(options: MockDaemonClientOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.persistSettings = options.persistSettings ?? typeof localStorage !== "undefined";
    const stored = this.persistSettings ? readJson<AppSettings>(STORAGE_KEYS.mockSettings) : null;
    this.settings = mergeSettings(MOCK_DEFAULTS, stored ?? undefined);
    this.agent = new MockAgent(
      { emit: (event) => this.emit(event), settings: () => this.settings },
      { speed: options.speed ?? 1 },
    );
    seedVault(this.vault, this.agent, this.settings);
    if ((options.installHooks ?? true) && typeof window !== "undefined") {
      window.__ddlMock = this.testHooks();
    }
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  // ── Event stream ───────────────────────────────────────────────────────

  connect(): void {
    if (this.state === "online" || this.state === "connecting") return;
    this.setState("connecting");
    setTimeout(() => {
      this.setState("online");
      this.emit({
        type: "hello",
        serverVersion: `mock-${__APP_VERSION__}`,
        apiVersion: API_VERSION,
      });
    }, 0);
  }

  disconnect(): void {
    this.setState("offline");
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
    switch (event.type) {
      case "surface.subscribe":
        this.agent.subscribeSurface(event.threadId, event.surface);
        break;
      case "surface.unsubscribe":
        this.agent.unsubscribeSurface(event.threadId, event.surface);
        break;
      case "thread.read":
        this.agent.markRead(event.threadId);
        break;
      case "editor.activity":
        this.agent.noteActivity(event.notePath, event.line);
        break;
      default:
        break;
    }
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of this.connectionListeners) listener({ state, reconnected: false });
  }

  /** Events are cloned synchronously (the agent keeps mutating its own objects) and delivered async like a socket. */
  private emit(event: ServerEvent): void {
    if (this.state === "offline") return;
    const copy = clone(event);
    setTimeout(() => {
      for (const listener of this.listeners) listener(copy);
    }, 0);
  }

  private respond<T>(produce: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(clone(produce()));
        } catch (error) {
          reject(error instanceof MockNotFoundError ? notFound(error.what) : error);
        }
      }, this.latencyMs);
    });
  }

  private vaultChanged(changes: VaultChange[], origin: "client" | "external"): void {
    this.emit({
      type: "vault.changed",
      changes,
      origin,
      ...(origin === "client" ? { clientId: this.clientId } : {}),
    });
  }

  // ── REST ───────────────────────────────────────────────────────────────

  health(): Promise<HealthResponse> {
    return this.respond(() => ({
      ok: true as const,
      version: `mock-${__APP_VERSION__}`,
      apiVersion: API_VERSION,
      vaultName: "Demo Vault",
      agentMode: "mock" as const,
    }));
  }

  getTree(): Promise<VaultTreeResponse> {
    return this.respond(() => ({ vaultName: "Demo Vault", entries: this.vault.entries() }));
  }

  readNote(path: string): Promise<NoteResponse> {
    return this.respond(() => {
      const note = this.vault.toResponse(vaultPath(path));
      if (!note) throw notFound("Note");
      return note;
    });
  }

  writeNote(path: string, body: WriteNoteRequest): Promise<WriteNoteResponse> {
    return this.respond(() => {
      const target = vaultPath(path);
      const existing = this.vault.toResponse(target);
      if (body.baseVersion === null && existing) throw new ConflictError(existing);
      if (typeof body.baseVersion === "string" && existing?.version !== body.baseVersion) {
        throw new ConflictError(existing);
      }
      const note = this.vault.write(target, body.content);
      this.vaultChanged(
        [{ path: target, kind: existing ? "modified" : "created", version: note.version }],
        "client",
      );
      this.agent.observeNote(target, body.content);
      return { path: target, version: note.version, mtime: note.mtime };
    });
  }

  deleteNote(input: string): Promise<void> {
    return this.respond(() => {
      const path = vaultPath(input);
      if (!this.vault.delete(path)) throw notFound("Note");
      this.vaultChanged([{ path, kind: "deleted" }], "client");
      this.agent.observeNote(path, null);
    });
  }

  renamePath(from: string, to: string): Promise<void> {
    return this.respond(() => {
      const source = vaultPath(from);
      const target = vaultPath(to);
      if (this.vault.has(target) || this.vault.isFolder(target)) {
        const message = `“${target}” already exists`;
        throw new HttpError(409, message, { error: "conflict", message });
      }
      const moves = this.vault.rename(source, target);
      if (moves.length === 0 && !this.vault.isFolder(target)) throw notFound("Path");
      const changes: VaultChange[] = [];
      for (const move of moves) {
        changes.push({ path: move.from, kind: "deleted" });
        changes.push({ path: move.to, kind: "created", version: this.vault.get(move.to)?.version });
        this.agent.renameNote(move.from, move.to);
      }
      this.vaultChanged(changes, "client");
    });
  }

  createFolder(path: string): Promise<void> {
    return this.respond(() => {
      this.vault.createFolder(vaultPath(path));
    });
  }

  deleteFolder(path: string): Promise<void> {
    return this.respond(() => {
      const folder = vaultPath(path);
      if (!this.vault.isFolder(folder)) throw notFound("Folder");
      const removed = this.vault.deleteFolder(folder);
      for (const notePath of removed) this.agent.observeNote(notePath, null);
      this.vaultChanged(
        removed.map((p) => ({ path: p, kind: "deleted" as const })),
        "client",
      );
    });
  }

  getDailyNote(dateParam: string, create = true): Promise<DailyNoteResponse> {
    return this.respond(() => {
      const local = dateParam === "today" ? today() : parseISODate(dateParam);
      if (!local) {
        const message = 'Date must be "today" or YYYY-MM-DD';
        throw new HttpError(400, message, { error: "invalid_request", message });
      }
      const date = toISODate(local);
      const path = dailyNotePath(local, this.settings.dailyNotes);
      const existing = this.vault.toResponse(path);
      if (existing) return { ...existing, date, created: false };
      if (!create) throw notFound("Daily note");
      const content = renderDailyContent(this.vault, local, this.settings);
      const note = this.vault.write(path, content);
      this.vaultChanged([{ path, kind: "created", version: note.version }], "client");
      this.agent.observeNote(path, content);
      return { path, content, version: note.version, mtime: note.mtime, date, created: true };
    });
  }

  search(query: string): Promise<SearchResponse> {
    return this.respond(() => ({ hits: this.vault.search(query) }));
  }

  getSettings(): Promise<SettingsResponse> {
    return this.respond(() => ({ settings: this.settings }));
  }

  /** Applied when the request is sent (like the daemon on receipt), so a reload can't lose it. */
  updateSettings(patch: UpdateSettingsRequest): Promise<SettingsResponse> {
    let checked: UpdateSettingsRequest;
    try {
      checked = checkedSettingsPatch(patch);
    } catch (error) {
      return this.respond(() => {
        throw error;
      });
    }
    this.settings = mergeSettings(this.settings, checked);
    if (this.persistSettings) writeJson(STORAGE_KEYS.mockSettings, this.settings);
    this.emit({ type: "settings.changed", settings: this.settings });
    this.emit({ type: "agent.status", status: this.agent.status() });
    const settings = this.settings;
    return this.respond(() => ({ settings }));
  }

  getAgentStatus(): Promise<AgentStatusResponse> {
    return this.respond(() => this.agent.status());
  }

  setAgentEnabled(enabled: boolean): Promise<AgentStatusResponse> {
    return this.respond(() => {
      this.agent.setEnabled(enabled);
      return this.agent.status();
    });
  }

  getConnectors(): Promise<ConnectorStatus[]> {
    return this.respond(() => MOCK_CONNECTORS);
  }

  getTaskRecords(notePath: string): Promise<TaskRecordsResponse> {
    return this.respond(() => ({ records: this.agent.recordsFor(notePath) }));
  }

  listThreads(): Promise<ThreadListResponse> {
    return this.respond(() => ({ threads: this.agent.listThreads() }));
  }

  getThread(id: string): Promise<ThreadResponse> {
    return this.respond(() => this.agent.getThread(id));
  }

  postMessage(threadId: string, text: string): Promise<void> {
    return this.respond(() => this.agent.postUserMessage(threadId, text));
  }

  cancelThread(threadId: string): Promise<void> {
    return this.respond(() => this.agent.cancel(threadId));
  }

  retryThread(threadId: string): Promise<void> {
    return this.respond(() => this.agent.retry(threadId));
  }

  listApprovals(): Promise<ApprovalListResponse> {
    return this.respond(() => ({ approvals: this.agent.listApprovals() }));
  }

  decideApproval(id: string, decision: ApprovalDecisionRequest): Promise<ApprovalRequest> {
    return this.respond(() => {
      const current = this.agent.listApprovals().find((approval) => approval.id === id);
      if (current && current.status !== "pending") {
        const message = `Approval is already ${current.status}`;
        throw new HttpError(409, message, { error: "conflict", message, approval: current });
      }
      return this.agent.decide(id, decision);
    });
  }

  async getArtifact(threadId: string, artifactId: string): Promise<ArtifactContent> {
    const artifact = await this.respond(() => this.agent.readArtifact(threadId, artifactId));
    return {
      mimeType: artifact.meta.mimeType,
      blob: new Blob([artifact.content], { type: artifact.meta.mimeType }),
    };
  }

  // ── Test hooks ─────────────────────────────────────────────────────────

  private testHooks(): MockTestHooks {
    const externalWrite = (path: string, content: string) => {
      const target = normalizePath(path);
      const existed = this.vault.has(target);
      const note = this.vault.write(target, content);
      this.vaultChanged(
        [{ path: target, kind: existed ? "modified" : "created", version: note.version }],
        "external",
      );
      this.agent.observeNote(target, content);
    };
    return {
      createNote: externalWrite,
      externalEdit: externalWrite,
      deleteNote: (path) => {
        if (!this.vault.delete(path)) return;
        this.vaultChanged([{ path, kind: "deleted" }], "external");
        this.agent.observeNote(path, null);
      },
      readNote: (path) => this.vault.get(path)?.content ?? null,
      listPaths: () => this.vault.paths(),
    };
  }
}
