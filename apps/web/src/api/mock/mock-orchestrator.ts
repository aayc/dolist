import {
  createId,
  ORCHESTRATOR_THREAD_ID,
  ORCHESTRATOR_THREAD_TITLE,
  type OrchestratorActivity,
  type OrchestratorOutcome,
  type OrchestratorTrigger,
  type ServerEvent,
  summarizeThread,
  type TaskAgentStatus,
  type TextMessage,
  type Thread,
  type ThreadMessage,
  type ToolCallMessage,
} from "@ddl/core";

export interface MockOrchestratorHost {
  emit(event: ServerEvent): void;
  /** Resolves after `ms` (scaled by the mock's speed); rejects when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Task texts agents are working on right now, and how many finished today. */
  work(): { working: string[]; done: number };
}

/** A tool call recorded in the chat as the turn makes it. */
export type MockTool = (
  toolName: string,
  label: string,
  input: Record<string, unknown>,
  resultPreview: string,
) => Promise<void>;

interface Turn {
  /** The status line that opens it in the chat. */
  label: string;
  trigger: OrchestratorTrigger;
  /** How long the model "thinks" before acting. */
  delayMs: number;
  run: (signal: AbortSignal) => Promise<OrchestratorOutcome>;
}

const READING_MS = 120;
const DECISION_DELAY_MS = 250;
const REPLY_DELAY_MS = 1_500;
/** Like the daemon: a finished turn's outcome stays in the status this long. */
const OUTCOME_STATUS_MS = 8_000;

/**
 * The orchestrator's own chat for the mock daemon: each simulated decision is a turn (a status
 * line saying what woke it, its tool calls with the task they act on), and the user can write to
 * it and get a streamed reply. Turns run one at a time, like the real orchestrator's, and report
 * their phases as `orchestrator.activity`.
 */
export class MockOrchestrator {
  readonly thread: Thread;
  private readonly host: MockOrchestratorHost;
  private readonly turns: Turn[] = [];
  private current: AbortController | null = null;
  private turnActivity: OrchestratorActivity | null = null;
  /** Lines noticed per note and not yet taken by a turn. */
  private readonly noticed = new Map<string, OrchestratorActivity>();
  private ended: { activity: OrchestratorActivity; at: number } | null = null;

  constructor(host: MockOrchestratorHost) {
    this.host = host;
    const now = Date.now();
    this.thread = {
      id: ORCHESTRATOR_THREAD_ID,
      taskId: null,
      notePath: null,
      title: ORCHESTRATOR_THREAD_TITLE,
      status: "idle",
      createdAt: now,
      updatedAt: now,
      messages: [],
      artifacts: [],
      surfaces: [],
    };
  }

  /** What it is doing now (`AgentStatusResponse.orchestrator`), as the daemon reports it. */
  get activity(): OrchestratorActivity {
    if (this.turnActivity) return this.turnActivity;
    const waiting = [...this.noticed.values()].at(-1);
    if (waiting) return waiting;
    if (this.ended && Date.now() - this.ended.at < OUTCOME_STATUS_MS) return this.ended.activity;
    return { phase: "idle" };
  }

  /** Unsettled lines of a note that may be requests; none withdraws the ones noticed before. */
  notice(notePath: string, lines: ReadonlyArray<{ line: number; text: string }>): void {
    const previous = this.noticed.get(notePath);
    if (lines.length === 0) {
      if (!previous) return;
      this.noticed.delete(notePath);
      this.emitActivity({ phase: "idle", trigger: noteTrigger(notePath, []) });
      return;
    }
    const activity: OrchestratorActivity = {
      phase: "noticed",
      trigger: noteTrigger(notePath, lines),
      startedAt: previous?.startedAt ?? Date.now(),
    };
    this.noticed.delete(notePath);
    this.noticed.set(notePath, activity);
    this.emitActivity(activity);
  }

  /** Lines of a note settled: a turn decides (`act` does it and says what it did). */
  noteSettled(input: {
    notePath: string;
    lines: ReadonlyArray<{ line: number; text: string }>;
    act: (tool: MockTool, signal: AbortSignal) => Promise<OrchestratorOutcome>;
  }): void {
    const count = input.lines.length;
    this.enqueue(
      `${input.notePath} changed: ${count} ${count === 1 ? "line" : "lines"}`,
      noteTrigger(input.notePath, input.lines),
      (signal) =>
        input.act(
          (toolName, label, toolInput, resultPreview) =>
            this.tool(toolName, label, toolInput, resultPreview, signal),
          signal,
        ),
    );
  }

  /** A new task was handed to a subagent. */
  delegated(input: {
    notePath: string;
    taskId: string;
    threadId: string;
    line: number;
    text: string;
    subagent: string;
    comment: string;
  }): void {
    const trigger: OrchestratorTrigger = {
      kind: "task",
      notePath: input.notePath,
      lines: [{ line: input.line, text: input.text }],
      summary: quoted(input.text),
    };
    this.enqueue(`${input.notePath} changed: 1 task`, trigger, async (signal) => {
      await this.tool(
        "post_comment",
        "Comment on task",
        { taskId: input.taskId, text: input.comment },
        "Comment posted.",
        signal,
      );
      await this.tool(
        "spawn_subagent",
        "Delegate to subagent",
        { taskId: input.taskId, goal: input.text, capabilities: [capabilityOf(input.subagent)] },
        `Subagent started for ${input.taskId}.`,
        signal,
      );
      return { kind: "delegated", count: 1, threadId: input.threadId, text: input.text };
    });
  }

  /** A subagent's work ended; the orchestrator looks at the report and leaves it be. */
  finished(text: string, status: TaskAgentStatus): void {
    const outcome = status === "done" ? "finished" : status === "failed" ? "failed" : "stopped";
    const label = `“${excerpt(text)}” ${outcome}`;
    this.enqueue(label, { kind: "other", summary: label }, async () => ({ kind: "no_action" }));
  }

  /** The user wrote in the chat. */
  write(text: string): void {
    this.push({
      id: createId("msg"),
      kind: "text",
      role: "user",
      author: "you",
      createdAt: Date.now(),
      text,
    });
    this.enqueue(
      "You wrote to me",
      { kind: "message", summary: "your message" },
      async (signal) => {
        const reply = this.replyTo(text);
        await this.say(reply, signal);
        return { kind: "replied", threadId: this.thread.id, text: excerpt(reply) };
      },
      REPLY_DELAY_MS,
    );
  }

  /** Stops the turn in progress (Stop in the chat). */
  cancel(): void {
    this.current?.abort();
  }

  private replyTo(text: string): string {
    const { working, done } = this.host.work();
    if (/\b(what|status|doing|working|running|progress)\b/i.test(text)) {
      const now =
        working.length === 0
          ? "Nothing is running right now."
          : `Working on ${working.map((t) => `“${excerpt(t)}”`).join(" and ")}.`;
      return done > 0 ? `${now} Done today: ${done}.` : now;
    }
    return "Got it — I'll keep that in mind for your tasks.";
  }

  private enqueue(
    label: string,
    trigger: OrchestratorTrigger,
    run: Turn["run"],
    delayMs = DECISION_DELAY_MS,
  ): void {
    this.turns.push({ label, trigger, delayMs, run });
    if (!this.current) void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.turns.length > 0) {
      const turn = this.turns.shift()!;
      const controller = new AbortController();
      this.current = controller;
      this.setStatus("working");
      const opening = this.statusLine("working", turn.label);
      this.push(opening);
      const base = { turnId: opening.id, trigger: turn.trigger, startedAt: Date.now() };
      this.takeNoticed(turn.trigger);
      this.setPhase({ phase: "reading", ...base });
      let outcome: OrchestratorOutcome | undefined;
      try {
        await this.host.sleep(READING_MS, controller.signal);
        this.setPhase({ phase: "thinking", ...base });
        await this.host.sleep(turn.delayMs, controller.signal);
        outcome = await turn.run(controller.signal);
      } catch {
        if (controller.signal.aborted) this.stopped();
      }
      this.current = null;
      this.setStatus("idle");
      const ended: OrchestratorActivity = {
        phase: "idle",
        ...base,
        ...(outcome ? { outcome } : {}),
      };
      this.turnActivity = null;
      this.ended = { activity: ended, at: Date.now() };
      this.emitActivity(ended);
    }
  }

  private setPhase(activity: OrchestratorActivity): void {
    const now = this.turnActivity;
    if (activity.phase === now?.phase && activity.turnId === now.turnId) return;
    this.turnActivity = activity;
    this.emitActivity(activity);
  }

  /** The turn takes over the noticed lines it carries. */
  private takeNoticed(trigger: OrchestratorTrigger): void {
    if (!trigger.notePath || !trigger.lines) return;
    const noticed = this.noticed.get(trigger.notePath);
    const left = noticed?.trigger?.lines?.filter(
      (line) => !trigger.lines!.some((t) => t.line === line.line || t.text === line.text),
    );
    if (!left) return;
    if (left.length === 0) this.noticed.delete(trigger.notePath);
    else {
      this.noticed.set(trigger.notePath, {
        ...noticed,
        phase: "noticed",
        trigger: noteTrigger(trigger.notePath, left),
      });
    }
  }

  private emitActivity(activity: OrchestratorActivity): void {
    this.host.emit({ type: "orchestrator.activity", activity });
  }

  private stopped(): void {
    for (const message of [...this.thread.messages]) {
      if (message.kind === "tool_call" && message.status === "running") {
        this.replace({
          ...message,
          status: "error",
          resultPreview: "Stopped",
          endedAt: Date.now(),
        });
      } else if (message.kind === "text" && message.streaming) {
        this.replace({ ...message, streaming: false });
      }
    }
    this.push(this.statusLine("cancelled", "You stopped this run"));
  }

  private async tool(
    toolName: string,
    label: string,
    input: Record<string, unknown>,
    resultPreview: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.turnActivity) this.setPhase({ ...this.turnActivity, phase: "acting" });
    const message: ToolCallMessage = {
      id: createId("msg"),
      kind: "tool_call",
      author: "orchestrator",
      createdAt: Date.now(),
      toolCallId: createId("call"),
      toolName,
      label,
      input,
      status: "running",
    };
    this.push(message);
    await this.host.sleep(200, signal);
    this.replace({ ...message, status: "ok", resultPreview, endedAt: Date.now() });
  }

  private async say(text: string, signal: AbortSignal): Promise<void> {
    const message: TextMessage = {
      id: createId("msg"),
      kind: "text",
      role: "agent",
      author: "orchestrator",
      createdAt: Date.now(),
      text: "",
      streaming: true,
    };
    this.push(message);
    for (const word of text.split(/(?<=\s)/)) {
      await this.host.sleep(40, signal);
      message.text += word;
      this.host.emit({
        type: "thread.delta",
        threadId: this.thread.id,
        messageId: message.id,
        delta: word,
      });
    }
    this.replace({ ...message, text, streaming: false });
  }

  private statusLine(status: TaskAgentStatus, text: string): ThreadMessage {
    return {
      id: createId("msg"),
      kind: "status",
      author: "system",
      createdAt: Date.now(),
      status,
      text,
    };
  }

  private setStatus(status: TaskAgentStatus): void {
    this.thread.status = status;
    this.emitThread();
  }

  private push(message: ThreadMessage): void {
    this.thread.messages.push(message);
    this.thread.updatedAt = Date.now();
    this.host.emit({ type: "thread.message", threadId: this.thread.id, message });
    this.emitThread();
  }

  private replace(message: ThreadMessage): void {
    const index = this.thread.messages.findIndex((m) => m.id === message.id);
    if (index === -1) this.thread.messages.push(message);
    else this.thread.messages[index] = message;
    this.thread.updatedAt = Date.now();
    this.host.emit({ type: "thread.message", threadId: this.thread.id, message });
    this.emitThread();
  }

  private emitThread(): void {
    this.host.emit({ type: "thread.upsert", thread: summarizeThread(this.thread) });
  }
}

function capabilityOf(subagent: string): string {
  if (subagent === "browser") return "browser";
  if (subagent === "operator") return "computer";
  return "web";
}

function excerpt(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function quoted(text: string): string {
  return `“${excerpt(text)}”`;
}

function noteTrigger(
  notePath: string,
  lines: ReadonlyArray<{ line: number; text: string }>,
): OrchestratorTrigger {
  const sorted = [...lines].sort((a, b) => a.line - b.line).slice(0, 20);
  return {
    kind: "note",
    notePath,
    lines: sorted.map(({ line, text }) => ({ line, text })),
    summary:
      sorted.length === 1
        ? quoted(sorted[0]!.text)
        : sorted.length === 0
          ? "your note"
          : `${lines.length} lines in your note`,
  };
}
