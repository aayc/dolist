import type { AgentRuntime, AgentRuntimeEvents } from "@ddl/agent";
import type {
  AgentMode,
  AgentStatusResponse,
  ApprovalDecisionRequest,
  ApprovalRequest,
  ApprovalStatus,
  AppSettings,
  ArtifactMeta,
  CreateRoutineRequest,
  Routine,
  RoutineRunResponse,
  SurfaceKind,
  TaskAgentRecord,
  Thread,
  ThreadSummary,
  Unsubscribe,
} from "@ddl/core";

/**
 * An AgentRuntime that hands every call to `inner()`, asked again on each call (so it may change
 * between calls). Wrappers extend it and override only what they change.
 */
export abstract class ForwardingAgentRuntime implements AgentRuntime {
  abstract readonly mode: AgentMode;

  protected abstract inner(): AgentRuntime;

  start(): Promise<void> {
    return this.inner().start();
  }

  stop(): Promise<void> {
    return this.inner().stop();
  }

  status(): AgentStatusResponse {
    return this.inner().status();
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.inner().setEnabled(enabled);
  }

  updateSettings(settings: AppSettings): void {
    this.inner().updateSettings(settings);
  }

  noteEditorActivity(notePath: string, line: number): void {
    this.inner().noteEditorActivity(notePath, line);
  }

  getTaskRecords(notePath: string): TaskAgentRecord[] {
    return this.inner().getTaskRecords(notePath);
  }

  listThreads(filter?: {
    notePath?: string;
    taskId?: string;
    routineId?: string;
  }): ThreadSummary[] {
    return this.inner().listThreads(filter);
  }

  getThread(id: string): { thread: Thread; approvals: ApprovalRequest[] } | undefined {
    return this.inner().getThread(id);
  }

  listApprovals(filter?: { status?: ApprovalStatus }): ApprovalRequest[] {
    return this.inner().listApprovals(filter);
  }

  readArtifact(
    threadId: string,
    artifactId: string,
  ): Promise<{ meta: ArtifactMeta; body: Uint8Array } | null> {
    return this.inner().readArtifact(threadId, artifactId);
  }

  postUserMessage(threadId: string, text: string): Promise<void> {
    return this.inner().postUserMessage(threadId, text);
  }

  decideApproval(id: string, decision: ApprovalDecisionRequest): Promise<ApprovalRequest> {
    return this.inner().decideApproval(id, decision);
  }

  cancelThread(threadId: string): Promise<void> {
    return this.inner().cancelThread(threadId);
  }

  retryThread(threadId: string): Promise<void> {
    return this.inner().retryThread(threadId);
  }

  markThreadRead(threadId: string): void {
    this.inner().markThreadRead(threadId);
  }

  subscribeSurface(threadId: string, surface: SurfaceKind): Unsubscribe {
    return this.inner().subscribeSurface(threadId, surface);
  }

  listRoutines(): Routine[] {
    return this.inner().listRoutines();
  }

  getRoutine(id: string): Routine | undefined {
    return this.inner().getRoutine(id);
  }

  createRoutine(input: CreateRoutineRequest): Promise<Routine> {
    return this.inner().createRoutine(input);
  }

  setRoutinePaused(id: string, paused: boolean): Promise<Routine> {
    return this.inner().setRoutinePaused(id, paused);
  }

  runRoutine(id: string): Promise<RoutineRunResponse> {
    return this.inner().runRoutine(id);
  }

  on<K extends keyof AgentRuntimeEvents>(
    event: K,
    listener: (payload: AgentRuntimeEvents[K]) => void,
  ): Unsubscribe {
    return this.inner().on(event, listener);
  }
}
