import type { AgentRuntime } from "@ddl/agent";
import type { ConnectorToolSource } from "@ddl/connectors";
import {
  type AgentMode,
  type AgentStatusResponse,
  type ApprovalRequest,
  type AppSettings,
  agentModel,
  DEFAULT_MODEL,
  type TaskAgentRecord,
  type ThreadSummary,
  type Unsubscribe,
} from "@ddl/core";

export interface NullAgentRuntimeOptions {
  /** What `status().mode` reports. Default `off`. */
  mode?: AgentMode;
  model?: string;
  enabled?: boolean;
  /** Why agents are unavailable; surfaced as `AgentStatusResponse.problem`. */
  problem?: string;
  connectors?: Pick<ConnectorToolSource, "status">;
}

export class AgentUnavailableError extends Error {
  constructor(message = "The agent runtime is not running") {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

/**
 * Runtime used for `DDL_AGENT_MODE=off`, in tests, and as the fallback when the real runtime cannot
 * be created: no tasks, threads or approvals, and it never emits events. Notes keep working.
 */
export class NullAgentRuntime implements AgentRuntime {
  readonly mode: AgentMode;
  private enabled: boolean;
  private model: string;
  private problem: string | undefined;
  private readonly connectors: Pick<ConnectorToolSource, "status"> | undefined;

  constructor(options: NullAgentRuntimeOptions = {}) {
    this.mode = options.mode ?? "off";
    this.enabled = options.enabled ?? true;
    this.model = options.model ?? DEFAULT_MODEL;
    this.problem = options.problem;
    this.connectors = options.connectors;
  }

  setProblem(problem: string | undefined): void {
    this.problem = problem;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

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

  on(): Unsubscribe {
    return () => {};
  }

  private unavailable(): AgentUnavailableError {
    return this.problem ? new AgentUnavailableError(this.problem) : new AgentUnavailableError();
  }
}
