import {
  type AgentStatusResponse,
  type ApprovalDecisionRequest,
  type ApprovalRequest,
  type AppSettings,
  type ArtifactMeta,
  agentModel,
  type ConnectorStatus,
  createId,
  type Deferred,
  deferred,
  isBlankTaskText,
  isWithinWindow,
  type MessageAuthor,
  parseDailyNotePath,
  parseTasks,
  type ServerEvent,
  type SurfaceKind,
  summarizeThread,
  type TaskAgentRecord,
  type TaskAgentStatus,
  type TextMessage,
  type Thread,
  type ThreadMessage,
  type ThreadSummary,
  type ToolCallMessage,
  type TrackedTask,
  today,
  toISODate,
  trackTasks,
} from "@ddl/core";
import {
  type BrowserPage,
  browserFocusPoint,
  type DesktopScene,
  desktopFocusPoint,
  renderBrowserFrame,
  renderDesktopFrame,
} from "./mock-frames";
import {
  buildScript,
  type RiskyAction,
  type ScriptArtifact,
  type ScriptStep,
  type TaskScript,
} from "./mock-scripts";

export interface MockAgentHost {
  emit(event: ServerEvent): void;
  settings(): AppSettings;
}

export const MOCK_CONNECTORS: ConnectorStatus[] = [
  { name: "notes", transport: "stdio", state: "connected", toolCount: 4 },
  { name: "mail", transport: "http", state: "connected", toolCount: 3 },
  { name: "calendar", transport: "sse", state: "idle", toolCount: 5 },
];

class AbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

export class MockNotFoundError extends Error {
  readonly what: string;

  constructor(what: string) {
    super(`${what} not found`);
    this.name = "MockNotFoundError";
    this.what = what;
  }
}

interface Job {
  taskId: string;
  threadId: string;
  controller: AbortController;
  approvalId: string | null;
  decision: Deferred<ApprovalDecisionRequest> | null;
}

interface TaskRef {
  id: string;
  text: string;
  line: number;
}

interface QueuedJob {
  notePath: string;
  task: TaskRef;
  threadId: string | null;
}

interface SurfaceState {
  surface: SurfaceKind;
  page?: BrowserPage;
  desktop?: DesktopScene;
  action?: { kind: string; text?: string };
  live: boolean;
  tick: number;
}

interface StoredArtifact {
  meta: ArtifactMeta;
  content: string;
}

const FRAME_INTERVAL_MS = 350;

/**
 * Simulates the daemon's agent runtime faithfully enough for UI development, e2e tests and demos:
 * task identity tracking + settle debounce, triage → working → done records, threads with streamed
 * messages and tool calls, artifacts, live surface frames and approval-gated risky actions.
 */
export class MockAgent {
  private readonly host: MockAgentHost;
  private readonly speed: number;
  private enabled = true;
  private readonly tracked = new Map<string, TrackedTask[]>();
  private readonly records = new Map<string, TaskAgentRecord>();
  private readonly threads = new Map<string, Thread>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly jobs = new Map<string, Job>();
  private readonly queue: QueuedJob[] = [];
  private readonly settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly surfaces = new Map<string, SurfaceState>();
  private readonly subscribers = new Map<string, number>();
  private readonly frameTimers = new Map<string, ReturnType<typeof setInterval>>();
  private activity: { notePath: string; line: number; at: number } | null = null;

  constructor(host: MockAgentHost, options: { speed?: number } = {}) {
    this.host = host;
    this.speed = options.speed ?? 1;
  }

  // ── Note watching ──────────────────────────────────────────────────────

  observeNote(path: string, content: string | null, options: { initial?: boolean } = {}): void {
    if (content === null) {
      this.forgetNote(path);
      return;
    }
    const previous = this.tracked.get(path) ?? [];
    const { tasks, diff } = trackTasks(previous, parseTasks(content));
    this.tracked.set(path, tasks);

    let changed = false;
    for (const task of tasks) {
      const record = this.records.get(task.id);
      if (!record || (record.line === task.line && record.text === task.text)) continue;
      this.records.set(task.id, { ...record, line: task.line, text: task.text });
      if (record.text !== task.text && record.threadId)
        this.retitleThread(record.threadId, task.text);
      changed = true;
    }
    for (const task of diff.removed) {
      this.clearSettle(task.id);
      if (!this.records.has(task.id)) continue;
      this.stopJob(task.id);
      this.records.delete(task.id);
      changed = true;
    }
    if (changed) this.emitRecords(path);

    if (options.initial || !this.enabled || !this.isWatched(path)) return;
    for (const task of diff.added) this.considerTask(path, task);
    for (const { task } of diff.updated) this.considerTask(path, task);
    for (const { task } of diff.statusChanged) {
      if (task.status !== "open") this.clearSettle(task.id);
    }
  }

  renameNote(from: string, to: string): void {
    const tasks = this.tracked.get(from);
    if (tasks) {
      this.tracked.delete(from);
      this.tracked.set(to, tasks);
    }
    for (const [id, record] of this.records) {
      if (record.notePath === from) this.records.set(id, { ...record, notePath: to });
    }
    for (const thread of this.threads.values()) {
      if (thread.notePath === from) thread.notePath = to;
    }
    this.emitRecords(from);
    this.emitRecords(to);
  }

  noteActivity(notePath: string, line: number): void {
    this.activity = { notePath, line, at: Date.now() };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      for (const timer of this.settleTimers.values()) clearTimeout(timer);
      this.settleTimers.clear();
    }
    this.emitStatus();
  }

  private isWatched(path: string): boolean {
    const settings = this.host.settings();
    const date = parseDailyNotePath(path, settings.dailyNotes);
    if (!date) return false;
    const { pastDays, futureDays } = settings.agent.watch;
    return isWithinWindow(date, today(), pastDays, futureDays);
  }

  private considerTask(path: string, task: TrackedTask): void {
    if (task.status !== "open" || isBlankTaskText(task.text) || this.records.has(task.id)) {
      this.clearSettle(task.id);
      return;
    }
    this.scheduleSettle(path, task.id);
  }

  private scheduleSettle(path: string, taskId: string): void {
    this.clearSettle(taskId);
    const timer = setTimeout(() => {
      this.settleTimers.delete(taskId);
      this.onSettled(path, taskId);
    }, this.scaled(this.host.settings().agent.settleMs));
    this.settleTimers.set(taskId, timer);
  }

  private clearSettle(taskId: string): void {
    const timer = this.settleTimers.get(taskId);
    if (timer !== undefined) clearTimeout(timer);
    this.settleTimers.delete(taskId);
  }

  private onSettled(path: string, taskId: string): void {
    if (!this.enabled) return;
    const task = this.tracked.get(path)?.find((t) => t.id === taskId);
    if (task?.status !== "open" || isBlankTaskText(task.text) || this.records.has(taskId)) return;
    const activity = this.activity;
    const settle = this.scaled(this.host.settings().agent.settleMs);
    if (
      activity?.notePath === path &&
      activity.line === task.line &&
      Date.now() - activity.at < settle
    ) {
      this.scheduleSettle(path, taskId);
      return;
    }
    this.startJob(path, task, null);
  }

  // ── Jobs ───────────────────────────────────────────────────────────────

  private startJob(path: string, task: TaskRef, threadId: string | null): void {
    const settings = this.host.settings();
    const date = parseDailyNotePath(path, settings.dailyNotes);
    const existing = this.records.get(task.id);
    const record: TaskAgentRecord = {
      taskId: task.id,
      notePath: path,
      date: date ? toISODate(date) : null,
      text: task.text,
      line: task.line,
      status: "triaging",
      summary: "Reading the task…",
      threadId: threadId ?? existing?.threadId ?? null,
      updatedAt: Date.now(),
      unread: existing?.unread ?? 0,
    };
    if (this.jobs.size >= Math.max(1, settings.agent.maxConcurrentSubagents)) {
      this.records.set(task.id, {
        ...record,
        status: "queued",
        summary: "Waiting for a free agent",
      });
      this.emitRecord(task.id);
      this.queue.push({ notePath: path, task, threadId: record.threadId });
      this.emitStatus();
      return;
    }
    this.records.set(task.id, record);
    this.emitRecord(task.id);
    const job: Job = {
      taskId: task.id,
      threadId: record.threadId ?? "",
      controller: new AbortController(),
      approvalId: null,
      decision: null,
    };
    this.jobs.set(task.id, job);
    this.emitStatus();
    this.run(job, buildScript(task.text), record.threadId).catch((error: unknown) => {
      if (!job.controller.signal.aborted) this.fail(job, error);
    });
  }

  private async run(job: Job, script: TaskScript, threadId: string | null): Promise<void> {
    const { signal } = job.controller;
    await this.sleep(700, signal);
    const thread = (threadId && this.threads.get(threadId)) || this.createThread(job.taskId);
    job.threadId = thread.id;
    this.patchRecord(job.taskId, {
      status: "working",
      summary: script.workingSummary,
      threadId: thread.id,
    });
    this.setThreadStatus(thread, "working", `Started a ${script.subagent} subagent`);
    const author: MessageAuthor = `subagent:${script.subagent}`;
    await this.say(
      thread,
      "orchestrator",
      `Picked this up — handing it to a **${script.subagent}** subagent.`,
      signal,
    );
    await this.say(thread, author, script.intro, signal);
    for (const step of script.steps) await this.runStep(thread, author, step, signal);
    if (script.artifact) this.addArtifact(thread, author, script.artifact);
    if (script.risky) {
      await this.runRisky(job, thread, author, script.risky, signal);
      return;
    }
    await this.say(thread, author, script.finalText, signal);
    this.finish(job, thread, "done", script.doneSummary);
  }

  private async runStep(
    thread: Thread,
    author: MessageAuthor,
    step: ScriptStep,
    signal: AbortSignal,
  ): Promise<void> {
    const message: ToolCallMessage = {
      id: createId("msg"),
      kind: "tool_call",
      author,
      createdAt: Date.now(),
      toolCallId: createId("call"),
      toolName: step.toolName,
      label: step.label,
      input: step.input,
      status: "running",
    };
    this.pushMessage(thread, message);
    if (step.surface) this.showSurface(thread, step.surface, step, true);
    await this.sleep(step.durationMs, signal);
    if (step.surface) this.setSurfaceLive(thread.id, step.surface, false);
    this.replaceMessage(thread, {
      ...message,
      status: "ok",
      resultPreview: step.resultPreview,
      endedAt: Date.now(),
    });
  }

  private async runRisky(
    job: Job,
    thread: Thread,
    author: MessageAuthor,
    risky: RiskyAction,
    signal: AbortSignal,
  ): Promise<void> {
    const message: ToolCallMessage = {
      id: createId("msg"),
      kind: "tool_call",
      author,
      createdAt: Date.now(),
      toolCallId: createId("call"),
      toolName: risky.toolName,
      label: risky.toolLabel,
      input: risky.input,
      status: "running",
    };
    this.pushMessage(thread, message);
    if (risky.page)
      this.showSurface(thread, "browser", { page: risky.page, action: { kind: "click" } }, false);

    const now = Date.now();
    const approval: ApprovalRequest = {
      id: createId("apr"),
      threadId: thread.id,
      taskId: job.taskId,
      toolName: risky.toolName,
      toolLabel: risky.toolLabel,
      input: risky.input,
      summary: risky.summary,
      risk: risky.risk,
      categories: risky.categories,
      reason: risky.reason,
      status: "pending",
      createdAt: now,
      expiresAt: now + this.host.settings().agent.approvalTimeoutMs,
    };
    this.approvals.set(approval.id, approval);
    this.host.emit({ type: "approval.upsert", approval });
    this.pushMessage(thread, {
      id: createId("msg"),
      kind: "approval",
      author: "system",
      createdAt: now,
      approvalId: approval.id,
    });
    this.patchRecord(job.taskId, { status: "waiting_approval", summary: "Needs approval" });
    this.setThreadStatus(thread, "waiting_approval", "Waiting for your approval");
    this.emitStatus();

    job.approvalId = approval.id;
    job.decision = deferred<ApprovalDecisionRequest>();
    const decision = await this.waitFor(job.decision.promise, signal);
    job.approvalId = null;
    job.decision = null;

    const approved = decision.decision === "approve";
    this.patchRecord(job.taskId, {
      status: "working",
      summary: approved ? "Finishing up…" : "Wrapping up…",
    });
    this.setThreadStatus(
      thread,
      "working",
      approved ? "Approved — continuing" : "Denied — skipping that step",
    );
    if (approved) {
      await this.sleep(800, signal);
      this.replaceMessage(thread, {
        ...message,
        status: "ok",
        resultPreview: "Done",
        endedAt: Date.now(),
      });
      await this.say(thread, author, risky.approvedText, signal);
      this.finish(job, thread, "done", risky.approvedSummary);
      return;
    }
    this.replaceMessage(thread, {
      ...message,
      status: "blocked",
      resultPreview: decision.note ? `Denied: ${decision.note}` : "Denied by you",
      endedAt: Date.now(),
    });
    const note = decision.note ? `\n\n> Your note: ${decision.note}` : "";
    await this.say(thread, author, `${risky.deniedText}${note}`, signal);
    this.finish(job, thread, "done", risky.deniedSummary);
  }

  private finish(job: Job, thread: Thread, status: TaskAgentStatus, summary: string): void {
    this.patchRecord(job.taskId, { status, ...(summary ? { summary } : {}) });
    this.setThreadStatus(thread, status, status === "done" ? "Task complete" : undefined);
    this.jobs.delete(job.taskId);
    for (const surface of thread.surfaces) this.setSurfaceLive(thread.id, surface, false);
    this.emitStatus();
    this.drainQueue();
  }

  private fail(job: Job, error: unknown): void {
    this.jobs.delete(job.taskId);
    const message = error instanceof Error ? error.message : String(error);
    this.patchRecord(job.taskId, { status: "failed", summary: "Something went wrong" });
    const thread = this.threads.get(job.threadId);
    if (thread) this.setThreadStatus(thread, "failed", message);
    this.emitStatus();
    this.drainQueue();
  }

  private stopJob(taskId: string): void {
    const job = this.jobs.get(taskId);
    if (!job) return;
    job.controller.abort(new AbortError());
    this.jobs.delete(taskId);
    this.drainQueue();
  }

  private drainQueue(): void {
    const max = Math.max(1, this.host.settings().agent.maxConcurrentSubagents);
    while (this.queue.length > 0 && this.jobs.size < max) {
      const next = this.queue.shift()!;
      if (this.records.get(next.task.id)?.status === "queued") {
        this.startJob(next.notePath, next.task, next.threadId);
      }
    }
  }

  // ── Threads ────────────────────────────────────────────────────────────

  private createThread(taskId: string): Thread {
    const record = this.records.get(taskId);
    const now = Date.now();
    const thread: Thread = {
      id: createId("thr"),
      taskId,
      notePath: record?.notePath ?? null,
      title: record?.text ?? "Task",
      status: "triaging",
      createdAt: now,
      updatedAt: now,
      messages: [],
      artifacts: [],
      surfaces: [],
    };
    this.threads.set(thread.id, thread);
    this.emitThread(thread);
    return thread;
  }

  private retitleThread(threadId: string, title: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.title = title;
    this.emitThread(thread);
  }

  private pushMessage(thread: Thread, message: ThreadMessage): void {
    thread.messages.push(message);
    thread.updatedAt = Date.now();
    this.host.emit({ type: "thread.message", threadId: thread.id, message });
    this.emitThread(thread);
  }

  private replaceMessage(thread: Thread, message: ThreadMessage): void {
    const index = thread.messages.findIndex((m) => m.id === message.id);
    if (index === -1) thread.messages.push(message);
    else thread.messages[index] = message;
    thread.updatedAt = Date.now();
    this.host.emit({ type: "thread.message", threadId: thread.id, message });
    this.emitThread(thread);
  }

  private setThreadStatus(thread: Thread, status: TaskAgentStatus, text?: string): void {
    thread.status = status;
    this.pushMessage(thread, {
      id: createId("msg"),
      kind: "status",
      author: "system",
      createdAt: Date.now(),
      status,
      ...(text ? { text } : {}),
    });
  }

  private async say(thread: Thread, author: MessageAuthor, text: string, signal: AbortSignal) {
    const message: TextMessage = {
      id: createId("msg"),
      kind: "text",
      role: "agent",
      author,
      createdAt: Date.now(),
      text: "",
      streaming: true,
    };
    this.pushMessage(thread, message);
    let streamed = "";
    for (const word of text.split(/(?<=\s)/)) {
      await this.sleep(26, signal);
      streamed += word;
      message.text = streamed;
      this.host.emit({
        type: "thread.delta",
        threadId: thread.id,
        messageId: message.id,
        delta: word,
      });
    }
    this.replaceMessage(thread, { ...message, text, streaming: false });
    this.bumpUnread(thread);
  }

  private addArtifact(thread: Thread, author: MessageAuthor, artifact: ScriptArtifact): void {
    const id = createId("art");
    const meta: ArtifactMeta = {
      id,
      threadId: thread.id,
      title: artifact.title,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      ...(artifact.language ? { language: artifact.language } : {}),
      path: `.daily-do-list/artifacts/${thread.id}/${id}`,
      size: artifact.content.length,
      createdAt: Date.now(),
    };
    this.artifacts.set(id, { meta, content: artifact.content });
    thread.artifacts.push(meta);
    this.pushMessage(thread, {
      id: createId("msg"),
      kind: "artifact",
      author,
      createdAt: Date.now(),
      artifactId: id,
    });
  }

  private bumpUnread(thread: Thread): void {
    if (!thread.taskId) return;
    const record = this.records.get(thread.taskId);
    if (record) this.patchRecord(thread.taskId, { unread: record.unread + 1 });
  }

  // ── Records & status ───────────────────────────────────────────────────

  private patchRecord(taskId: string, patch: Partial<TaskAgentRecord>): void {
    const record = this.records.get(taskId);
    if (!record) return;
    this.records.set(taskId, { ...record, ...patch, updatedAt: Date.now() });
    this.emitRecord(taskId);
  }

  private emitRecord(taskId: string): void {
    const record = this.records.get(taskId);
    if (record) this.host.emit({ type: "task.record", record });
  }

  private emitRecords(notePath: string): void {
    this.host.emit({ type: "task.records", notePath, records: this.recordsFor(notePath) });
  }

  private emitThread(thread: Thread): void {
    this.host.emit({
      type: "thread.upsert",
      thread: summarizeThread(thread, this.pendingFor(thread.id)),
    });
  }

  private emitStatus(): void {
    this.host.emit({ type: "agent.status", status: this.status() });
  }

  private pendingFor(threadId: string): number {
    let count = 0;
    for (const approval of this.approvals.values()) {
      if (approval.threadId === threadId && approval.status === "pending") count++;
    }
    return count;
  }

  status(): AgentStatusResponse {
    let running = 0;
    let queued = 0;
    for (const record of this.records.values()) {
      if (record.status === "queued") queued++;
      else if (this.jobs.has(record.taskId)) running++;
    }
    let pendingApprovals = 0;
    for (const approval of this.approvals.values())
      if (approval.status === "pending") pendingApprovals++;
    return {
      mode: "mock",
      enabled: this.enabled,
      model: agentModel(this.host.settings().agent),
      running,
      queued,
      pendingApprovals,
      connectors: MOCK_CONNECTORS,
      execution: {
        provider: "mock",
        capabilities: { shell: false, browser: true, computer: true },
      },
    };
  }

  // ── Queries & commands (REST) ──────────────────────────────────────────

  recordsFor(notePath: string): TaskAgentRecord[] {
    return [...this.records.values()].filter((r) => r.notePath === notePath);
  }

  listThreads(): ThreadSummary[] {
    return [...this.threads.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => summarizeThread(t, this.pendingFor(t.id)));
  }

  getThread(id: string): { thread: Thread; approvals: ApprovalRequest[] } {
    const thread = this.threads.get(id);
    if (!thread) throw new MockNotFoundError("Thread");
    return {
      thread,
      approvals: [...this.approvals.values()].filter((a) => a.threadId === id),
    };
  }

  listApprovals(): ApprovalRequest[] {
    return [...this.approvals.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  readArtifact(threadId: string, artifactId: string): StoredArtifact {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.meta.threadId !== threadId) throw new MockNotFoundError("Artifact");
    return artifact;
  }

  decide(id: string, request: ApprovalDecisionRequest): ApprovalRequest {
    const approval = this.approvals.get(id);
    if (!approval) throw new MockNotFoundError("Approval");
    if (approval.status !== "pending") return approval;
    const updated: ApprovalRequest = {
      ...approval,
      status: request.decision === "approve" ? "approved" : "denied",
      scope: request.scope ?? "once",
      ...(request.note ? { decisionNote: request.note } : {}),
      decidedAt: Date.now(),
    };
    this.approvals.set(id, updated);
    this.host.emit({ type: "approval.upsert", approval: updated });
    const thread = approval.threadId ? this.threads.get(approval.threadId) : undefined;
    if (thread) this.emitThread(thread);
    this.emitStatus();
    for (const job of this.jobs.values()) {
      if (job.approvalId === id) job.decision?.resolve(request);
    }
    return updated;
  }

  cancel(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) throw new MockNotFoundError("Thread");
    const job = [...this.jobs.values()].find((j) => j.threadId === threadId);
    if (!job) return;
    job.controller.abort(new AbortError());
    this.jobs.delete(job.taskId);
    const now = Date.now();
    if (job.approvalId) {
      const approval = this.approvals.get(job.approvalId);
      if (approval?.status === "pending") {
        const cancelled: ApprovalRequest = { ...approval, status: "cancelled", decidedAt: now };
        this.approvals.set(approval.id, cancelled);
        this.host.emit({ type: "approval.upsert", approval: cancelled });
      }
    }
    for (const message of [...thread.messages]) {
      if (message.kind === "tool_call" && message.status === "running") {
        this.replaceMessage(thread, {
          ...message,
          status: "error",
          resultPreview: "Cancelled",
          endedAt: now,
        });
      } else if (message.kind === "text" && message.streaming) {
        this.replaceMessage(thread, { ...message, streaming: false });
      }
    }
    for (const surface of thread.surfaces) this.setSurfaceLive(threadId, surface, false);
    this.patchRecord(job.taskId, { status: "cancelled", summary: "Stopped by you" });
    this.setThreadStatus(thread, "cancelled", "Stopped by you");
    this.emitStatus();
    this.drainQueue();
  }

  retry(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) throw new MockNotFoundError("Thread");
    if (!thread.taskId || this.jobs.has(thread.taskId)) return;
    const record = this.records.get(thread.taskId);
    const notePath = record?.notePath ?? thread.notePath;
    if (!notePath) return;
    const task = this.tracked.get(notePath)?.find((t) => t.id === thread.taskId);
    this.startJob(
      notePath,
      {
        id: thread.taskId,
        text: task?.text ?? thread.title,
        line: task?.line ?? record?.line ?? 0,
      },
      thread.id,
    );
  }

  postUserMessage(threadId: string, text: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) throw new MockNotFoundError("Thread");
    this.pushMessage(thread, {
      id: createId("msg"),
      kind: "text",
      role: "user",
      author: "you",
      createdAt: Date.now(),
      text,
    });
    const job = [...this.jobs.values()].find((j) => j.threadId === threadId);
    const signal = job?.controller.signal ?? new AbortController().signal;
    const reply = job
      ? "Got it — I'll factor that in as I go."
      : "Thanks! I've added that to this task's notes. Hit **Retry** if you'd like me to take another pass.";
    void this.sleep(500, signal)
      .then(() => this.say(thread, "orchestrator", reply, signal))
      .catch(() => {});
  }

  markRead(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread?.taskId) return;
    const record = this.records.get(thread.taskId);
    if (record && record.unread > 0) this.patchRecord(thread.taskId, { unread: 0 });
  }

  // ── Surfaces ───────────────────────────────────────────────────────────

  subscribeSurface(threadId: string, surface: SurfaceKind): void {
    const key = `${threadId}:${surface}`;
    this.subscribers.set(key, (this.subscribers.get(key) ?? 0) + 1);
    const state = this.surfaces.get(key);
    if (!state) return;
    this.emitFrame(threadId, state);
    if (state.live) this.ensureFrameTimer(threadId, key);
  }

  unsubscribeSurface(threadId: string, surface: SurfaceKind): void {
    const key = `${threadId}:${surface}`;
    const count = (this.subscribers.get(key) ?? 0) - 1;
    if (count > 0) {
      this.subscribers.set(key, count);
      return;
    }
    this.subscribers.delete(key);
    this.stopFrameTimer(key);
  }

  private showSurface(
    thread: Thread,
    surface: SurfaceKind,
    source: {
      page?: BrowserPage;
      desktop?: DesktopScene;
      action?: { kind: string; text?: string };
    },
    live: boolean,
  ): void {
    if (!thread.surfaces.includes(surface)) {
      thread.surfaces.push(surface);
      this.emitThread(thread);
    }
    const key = `${thread.id}:${surface}`;
    const state: SurfaceState = this.surfaces.get(key) ?? { surface, live: false, tick: 0 };
    if (source.page) state.page = source.page;
    if (source.desktop) state.desktop = source.desktop;
    if (source.action) state.action = source.action;
    else delete state.action;
    state.live = live;
    this.surfaces.set(key, state);
    if (this.subscribers.has(key)) {
      this.emitFrame(thread.id, state);
      if (live) this.ensureFrameTimer(thread.id, key);
    }
  }

  private setSurfaceLive(threadId: string, surface: SurfaceKind, live: boolean): void {
    const state = this.surfaces.get(`${threadId}:${surface}`);
    if (!state) return;
    state.live = live;
    if (!live) this.stopFrameTimer(`${threadId}:${surface}`);
  }

  private ensureFrameTimer(threadId: string, key: string): void {
    if (this.frameTimers.has(key)) return;
    const timer = setInterval(() => {
      const state = this.surfaces.get(key);
      if (!state?.live || !this.subscribers.has(key)) {
        this.stopFrameTimer(key);
        return;
      }
      state.tick++;
      this.emitFrame(threadId, state);
    }, FRAME_INTERVAL_MS);
    this.frameTimers.set(key, timer);
  }

  private stopFrameTimer(key: string): void {
    const timer = this.frameTimers.get(key);
    if (timer !== undefined) clearInterval(timer);
    this.frameTimers.delete(key);
  }

  private emitFrame(threadId: string, state: SurfaceState): void {
    const isBrowser = state.surface === "browser";
    const image =
      isBrowser && state.page
        ? renderBrowserFrame(state.page, state.tick)
        : !isBrowser && state.desktop
          ? renderDesktopFrame(state.desktop, state.tick)
          : null;
    if (!image) return;
    const point =
      isBrowser && state.page
        ? browserFocusPoint(state.page)
        : state.desktop
          ? desktopFocusPoint(state.desktop)
          : null;
    const action = state.action
      ? {
          kind: state.action.kind,
          ...(point ? { x: point.x, y: point.y } : {}),
          ...(state.action.text ? { text: state.action.text } : {}),
        }
      : undefined;
    this.host.emit({
      type: "surface.frame",
      threadId,
      surface: state.surface,
      mimeType: image.mimeType,
      data: image.data,
      width: image.width,
      height: image.height,
      ...(isBrowser && state.page ? { url: state.page.url, title: state.page.title } : {}),
      ...(action ? { action } : {}),
      ts: Date.now(),
    });
  }

  // ── Seeding ────────────────────────────────────────────────────────────

  /** Instantly fabricates a finished thread for an existing task (demo history on past days). */
  seedCompletedTask(notePath: string, taskText: string, completedAt: number): void {
    const task = this.tracked.get(notePath)?.find((t) => t.text === taskText);
    if (!task) return;
    const script = buildScript(task.text);
    const author: MessageAuthor = `subagent:${script.subagent}`;
    let clock = completedAt - 90_000;
    const tick = () => {
      clock += 4_000;
      return clock;
    };
    const thread: Thread = {
      id: createId("thr"),
      taskId: task.id,
      notePath,
      title: task.text,
      status: "done",
      createdAt: clock,
      updatedAt: completedAt,
      messages: [],
      artifacts: [],
      surfaces: [],
    };
    const add = (message: ThreadMessage) => thread.messages.push(message);
    const text = (who: MessageAuthor, body: string) =>
      add({
        id: createId("msg"),
        kind: "text",
        role: "agent",
        author: who,
        createdAt: tick(),
        text: body,
      });
    add({
      id: createId("msg"),
      kind: "status",
      author: "system",
      createdAt: tick(),
      status: "working",
      text: `Started a ${script.subagent} subagent`,
    });
    text("orchestrator", `Picked this up — handing it to a **${script.subagent}** subagent.`);
    text(author, script.intro);
    for (const step of script.steps) {
      const at = tick();
      add({
        id: createId("msg"),
        kind: "tool_call",
        author,
        createdAt: at,
        toolCallId: createId("call"),
        toolName: step.toolName,
        label: step.label,
        input: step.input,
        status: "ok",
        resultPreview: step.resultPreview,
        endedAt: at + step.durationMs,
      });
      if (step.surface) {
        if (!thread.surfaces.includes(step.surface)) thread.surfaces.push(step.surface);
        this.surfaces.set(`${thread.id}:${step.surface}`, {
          surface: step.surface,
          ...(step.page ? { page: step.page } : {}),
          ...(step.desktop ? { desktop: step.desktop } : {}),
          live: false,
          tick: 0,
        });
      }
    }
    if (script.artifact) {
      const id = createId("art");
      const meta: ArtifactMeta = {
        id,
        threadId: thread.id,
        title: script.artifact.title,
        kind: script.artifact.kind,
        mimeType: script.artifact.mimeType,
        path: `.daily-do-list/artifacts/${thread.id}/${id}`,
        size: script.artifact.content.length,
        createdAt: tick(),
      };
      this.artifacts.set(id, { meta, content: script.artifact.content });
      thread.artifacts.push(meta);
      add({
        id: createId("msg"),
        kind: "artifact",
        author,
        createdAt: meta.createdAt,
        artifactId: id,
      });
    }
    let summary = script.doneSummary;
    if (script.risky) {
      const at = tick();
      const approval: ApprovalRequest = {
        id: createId("apr"),
        threadId: thread.id,
        taskId: task.id,
        toolName: script.risky.toolName,
        toolLabel: script.risky.toolLabel,
        input: script.risky.input,
        summary: script.risky.summary,
        risk: script.risky.risk,
        categories: script.risky.categories,
        reason: script.risky.reason,
        status: "approved",
        scope: "once",
        createdAt: at,
        decidedAt: at + 30_000,
      };
      this.approvals.set(approval.id, approval);
      add({
        id: createId("msg"),
        kind: "approval",
        author: "system",
        createdAt: at,
        approvalId: approval.id,
      });
      text(author, script.risky.approvedText);
      summary = script.risky.approvedSummary;
    } else {
      text(author, script.finalText);
    }
    add({
      id: createId("msg"),
      kind: "status",
      author: "system",
      createdAt: completedAt,
      status: "done",
      text: "Task complete",
    });
    this.threads.set(thread.id, thread);
    const settings = this.host.settings();
    const date = parseDailyNotePath(notePath, settings.dailyNotes);
    this.records.set(task.id, {
      taskId: task.id,
      notePath,
      date: date ? toISODate(date) : null,
      text: task.text,
      line: task.line,
      status: "done",
      summary,
      threadId: thread.id,
      updatedAt: completedAt,
      unread: 0,
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private forgetNote(path: string): void {
    const tasks = this.tracked.get(path) ?? [];
    this.tracked.delete(path);
    for (const task of tasks) this.clearSettle(task.id);
    let changed = false;
    for (const [id, record] of [...this.records]) {
      if (record.notePath !== path) continue;
      this.stopJob(id);
      this.records.delete(id);
      changed = true;
    }
    if (changed) this.emitRecords(path);
  }

  private scaled(ms: number): number {
    return Math.max(0, Math.round(ms / this.speed));
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new AbortError());
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, this.scaled(ms));
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AbortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new AbortError());
        return;
      }
      const onAbort = () => reject(new AbortError());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
}
