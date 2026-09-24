/**
 * The facade the daemon talks to. `createAgentRuntime()` composes the watcher, orchestrator,
 * subagents, safety gate, approvals, threads, execution provider and connectors.
 */

import type { ConnectorToolSource } from "@ddl/connectors";
import type {
  AgentMode,
  AgentStatusResponse,
  ApprovalDecisionRequest,
  ApprovalRequest,
  ApprovalStatus,
  AppSettings,
  ArtifactMeta,
  Logger,
  ServerEventOf,
  ServerEventPayload,
  SurfaceKind,
  TaskAgentRecord,
  Thread,
  ThreadSummary,
  Unsubscribe,
} from "@ddl/core";
import type { StorageProvider } from "@ddl/storage";
import type { ExecutionProvider } from "./execution/types";
import type { Harness } from "./harness/types";
import type { LlmClient } from "./llm/types";
import type { SafetyPolicy } from "./safety/types";

/**
 * Runtime events are the agent's `ServerEvent`s, which the daemon's WebSocket hub forwards as-is
 * (`status` goes out as `agent.status`).
 */
export interface AgentRuntimeEvents {
  "task.record": ServerEventOf<"task.record">["record"];
  "task.records": ServerEventPayload<"task.records">;
  "thread.upsert": ServerEventOf<"thread.upsert">["thread"];
  "thread.message": ServerEventPayload<"thread.message">;
  "thread.delta": ServerEventPayload<"thread.delta">;
  "approval.upsert": ServerEventOf<"approval.upsert">["approval"];
  status: ServerEventOf<"agent.status">["status"];
  "surface.frame": ServerEventPayload<"surface.frame">;
}

export interface AgentRuntime {
  readonly mode: AgentMode;
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): AgentStatusResponse;
  setEnabled(enabled: boolean): Promise<void>;
  /** Apply changed settings (daily-note folder/format, settle delay, model, …). */
  updateSettings(settings: AppSettings): void;
  /** Editor presence: the user is typing on `line` of `notePath` right now. */
  noteEditorActivity(notePath: string, line: number): void;

  getTaskRecords(notePath: string): TaskAgentRecord[];
  listThreads(filter?: { notePath?: string; taskId?: string }): ThreadSummary[];
  getThread(id: string): { thread: Thread; approvals: ApprovalRequest[] } | undefined;
  listApprovals(filter?: { status?: ApprovalStatus }): ApprovalRequest[];
  readArtifact(
    threadId: string,
    artifactId: string,
  ): Promise<{ meta: ArtifactMeta; body: Uint8Array } | null>;

  /** The user replied in a thread (steers a running subagent or resumes a finished one). */
  postUserMessage(threadId: string, text: string): Promise<void>;
  decideApproval(id: string, decision: ApprovalDecisionRequest): Promise<ApprovalRequest>;
  cancelThread(threadId: string): Promise<void>;
  retryThread(threadId: string): Promise<void>;
  markThreadRead(threadId: string): void;
  /** Frames for a surface only flow while at least one subscriber exists. */
  subscribeSurface(threadId: string, surface: SurfaceKind): Unsubscribe;

  on<K extends keyof AgentRuntimeEvents>(
    event: K,
    listener: (payload: AgentRuntimeEvents[K]) => void,
  ): Unsubscribe;
}

export interface AgentRuntimeOptions {
  mode: AgentMode;
  /** The vault. Notes are watched through it; threads/state persist in its sidecar folder. */
  storage: StorageProvider;
  settings: AppSettings;
  /** DDL_HOME, for machine-local state (workspaces, browser profile, sessions). */
  home: string;
  /** Required in `live` mode. */
  llm?: LlmClient;
  /** Defaults: PiHarness in `live`, ScriptedHarness in `mock`. */
  harness?: Harness;
  execution: ExecutionProvider;
  connectors?: ConnectorToolSource;
  safetyPolicy?: Partial<SafetyPolicy>;
  logger?: Logger;
  /** Injectable clock for tests. */
  now?: () => number;
}
