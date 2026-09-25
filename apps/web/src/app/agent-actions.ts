import {
  type ApprovalDecisionRequest,
  type ApprovalRequest,
  type CitedSource,
  ORCHESTRATOR_THREAD_ID,
  resolveLineAnchors,
  resolveTaskAnchors,
} from "@ddl/core";
import type { DaemonClient } from "../api/client";
import { errorMessage, HttpError } from "../api/errors";
import { chipTarget } from "../features/editor/activity-chips";
import { perfCancel, perfStart } from "../perf/perf";
import { activityEventCount, seedActivity, useActivityStore } from "../state/activity-store";
import {
  applyApprovalList,
  applyRecordsSnapshot,
  applyThreadList,
  applyThreadResponse,
} from "../state/agent-reducer";
import {
  dispatchAgentEvent,
  findRecordByTask,
  updateAgentState,
  useAgentStore,
} from "../state/agent-store";
import { toast } from "../state/toast-store";
import { type ThreadTab, ui } from "../state/ui-store";

/**
 * A 503 means the agent can't act from here right now (another device runs it, the always-on
 * machine can't be reached, or it's off); the daemon's message says which.
 */
export function failureTitle(error: unknown, title: string): string {
  return error instanceof HttpError && error.status === 503
    ? "The agent can't act right now"
    : title;
}

export interface NoteNavigator {
  openNote(path: string, options?: { focus?: boolean }): Promise<boolean>;
  activeDocument(): string | null;
  scrollToLine(line: number): void;
}

/** Agent-side user actions: loading threads/records, approvals, thread controls. */
export class AgentActions {
  private readonly client: DaemonClient;
  private navigator: NoteNavigator | null = null;
  private readonly recordNotes = new Set<string>();
  private readonly threadLoads = new Map<string, Promise<void>>();
  private readonly refetchTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(client: DaemonClient) {
    this.client = client;
  }

  attach(navigator: NoteNavigator): void {
    this.navigator = navigator;
  }

  async loadOverview(): Promise<void> {
    const eventsBefore = activityEventCount();
    const [status, threads, approvals] = await Promise.allSettled([
      this.client.getAgentStatus(),
      this.client.listThreads(),
      this.client.listApprovals(),
    ]);
    if (status.status === "fulfilled") seedActivity(status.value.orchestrator, eventsBefore);
    updateAgentState((state) => {
      let next = state;
      if (status.status === "fulfilled") next = { ...next, status: status.value };
      if (threads.status === "fulfilled") next = applyThreadList(next, threads.value.threads);
      if (approvals.status === "fulfilled")
        next = applyApprovalList(next, approvals.value.approvals);
      return next;
    });
  }

  /** Fetches a note's task records once (events keep them current afterwards). */
  refreshRecords(notePath: string, force = false): void {
    if (!force && this.recordNotes.has(notePath)) return;
    this.recordNotes.add(notePath);
    this.client.getTaskRecords(notePath).then(
      (response) => updateAgentState((s) => applyRecordsSnapshot(s, notePath, response.records)),
      () => this.recordNotes.delete(notePath),
    );
  }

  forgetRecords(notePath: string): void {
    this.recordNotes.delete(notePath);
  }

  /** `quiet`: a failure isn't reported (for background lookups such as link previews). */
  loadThread(threadId: string, force = false, quiet = false): Promise<void> {
    if (!force && useAgentStore.getState().details[threadId]) return Promise.resolve();
    const pending = this.threadLoads.get(threadId);
    if (pending) return pending;
    const promise = this.client
      .getThread(threadId)
      .then((response) => updateAgentState((s) => applyThreadResponse(s, response)))
      .catch((error: unknown) => {
        if (quiet) return;
        toast({ kind: "error", title: "Couldn't load the thread", body: errorMessage(error) });
      })
      .finally(() => this.threadLoads.delete(threadId));
    this.threadLoads.set(threadId, promise);
    return promise;
  }

  /** The web pages a thread cites, loading the thread if needed (empty if it can't be loaded). */
  async sourcesOf(threadId: string): Promise<readonly CitedSource[]> {
    await this.loadThread(threadId, false, true);
    return useAgentStore.getState().details[threadId]?.sources ?? [];
  }

  /** Debounced full refetch (e.g. an artifact appeared whose metadata only the REST shape has). */
  scheduleThreadRefetch(threadId: string): void {
    if (this.refetchTimers.has(threadId)) return;
    this.refetchTimers.set(
      threadId,
      setTimeout(() => {
        this.refetchTimers.delete(threadId);
        void this.loadThread(threadId, true);
      }, 150),
    );
  }

  openInbox(): void {
    ui.showInbox();
  }

  openThread(threadId: string, tab: ThreadTab = "chat"): void {
    ui.showThread(threadId, tab);
    void this.loadThread(threadId);
    this.markRead(threadId);
  }

  /** The orchestrator's chat, scrolled to the turn that `turnId` (its opening line) starts. */
  openTurn(turnId: string | null): void {
    ui.set({ chatFocus: turnId ? { messageId: turnId, at: Date.now() } : null });
    this.openThread(ORCHESTRATOR_THREAD_ID);
  }

  /** An activity chip: the thread its outcome acted in, else the orchestrator's chat at its turn. */
  openActivityChip(key: string): void {
    const chip = useActivityStore.getState().chips.find((c) => c.key === key);
    const target = chip ? chipTarget(chip) : { turnId: null };
    if ("threadId" in target) this.openThread(target.threadId);
    else this.openTurn(target.turnId);
  }

  /** Badge click: open the task's thread (or a pending view until the orchestrator creates one). */
  openTaskThread(taskId: string, threadId: string | null, start?: number): void {
    perfStart("thread:open", start);
    const resolved = threadId ?? findRecordByTask(taskId)?.threadId ?? null;
    if (resolved) {
      this.openThread(resolved);
      return;
    }
    perfCancel("thread:open");
    ui.showTask(taskId);
  }

  markRead(threadId: string): void {
    this.client.send({ type: "thread.read", threadId });
  }

  async decide(approval: ApprovalRequest, decision: ApprovalDecisionRequest): Promise<void> {
    const optimistic: ApprovalRequest = {
      ...approval,
      status: decision.decision === "approve" ? "approved" : "denied",
      ...(decision.scope ? { scope: decision.scope } : {}),
      ...(decision.note ? { decisionNote: decision.note } : {}),
      decidedAt: Date.now(),
    };
    dispatchAgentEvent({ type: "approval.upsert", approval: optimistic });
    try {
      const updated = await this.client.decideApproval(approval.id, decision);
      if (updated) dispatchAgentEvent({ type: "approval.upsert", approval: updated });
    } catch (error) {
      dispatchAgentEvent({ type: "approval.upsert", approval });
      toast({
        kind: "error",
        title: failureTitle(error, "Couldn't send your decision"),
        body: errorMessage(error),
      });
    }
  }

  async cancel(threadId: string): Promise<void> {
    await this.guard("Couldn't stop the task", () => this.client.cancelThread(threadId));
  }

  async retry(threadId: string): Promise<void> {
    await this.guard("Couldn't retry the task", () => this.client.retryThread(threadId));
  }

  /** Throws on failure: the chat shows the reply as failed, with a retry, instead of a toast. */
  postMessage(threadId: string, text: string): Promise<void> {
    return this.client.postMessage(threadId, text);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const previous = useAgentStore.getState().status;
    if (previous) useAgentStore.setState({ status: { ...previous, enabled } });
    try {
      const status = await this.client.setAgentEnabled(enabled);
      if (status) useAgentStore.setState({ status });
    } catch (error) {
      if (previous) useAgentStore.setState({ status: previous });
      toast({ kind: "error", title: "Couldn't change the agent state", body: errorMessage(error) });
    }
  }

  /** Opens the thread's note and scrolls to its task or line (resolved against local edits). */
  async revealTask(threadId: string): Promise<void> {
    const state = useAgentStore.getState();
    const thread = state.details[threadId] ?? state.threads[threadId];
    if (!thread?.notePath || !this.navigator) return;
    const opened = await this.navigator.openNote(thread.notePath, { focus: true });
    if (!opened) return;
    const record = thread.taskId ? findRecordByTask(thread.taskId) : undefined;
    if (!record) return;
    const doc = this.navigator.activeDocument();
    const { taskId, text, line } = record;
    const resolved = !doc
      ? undefined
      : record.anchor === "line"
        ? resolveLineAnchors(doc, [{ anchorId: taskId, text, line }]).get(taskId)?.line
        : resolveTaskAnchors(doc, [record]).get(taskId);
    this.navigator.scrollToLine(resolved ?? line);
  }

  async resync(): Promise<void> {
    await this.loadOverview();
    for (const notePath of [...this.recordNotes]) this.refreshRecords(notePath, true);
    for (const threadId of Object.keys(useAgentStore.getState().details)) {
      void this.loadThread(threadId, true);
    }
  }

  private async guard(title: string, run: () => Promise<void>): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (error) {
      toast({ kind: "error", title: failureTitle(error, title), body: errorMessage(error) });
      return false;
    }
  }
}
