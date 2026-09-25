import {
  createId,
  ORCHESTRATOR_THREAD_ID,
  ORCHESTRATOR_THREAD_TITLE,
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

interface Turn {
  trigger: string;
  /** How long the model "thinks" before acting. */
  delayMs: number;
  run: (signal: AbortSignal) => Promise<void>;
}

const DECISION_DELAY_MS = 250;
const REPLY_DELAY_MS = 1_500;

/**
 * The orchestrator's own chat for the mock daemon: each simulated decision is a turn (a status
 * line saying what woke it, its tool calls with the task they act on), and the user can write to
 * it and get a streamed reply. Turns run one at a time, like the real orchestrator's.
 */
export class MockOrchestrator {
  readonly thread: Thread;
  private readonly host: MockOrchestratorHost;
  private readonly turns: Turn[] = [];
  private current: AbortController | null = null;

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

  /** A new task was handed to a subagent. */
  delegated(input: {
    notePath: string;
    taskId: string;
    text: string;
    subagent: string;
    comment: string;
  }): void {
    this.enqueue(`${input.notePath} changed: 1 task`, async (signal) => {
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
    });
  }

  /** A subagent's work ended; the orchestrator looks at the report and leaves it be. */
  finished(text: string, status: TaskAgentStatus): void {
    const outcome = status === "done" ? "finished" : status === "failed" ? "failed" : "stopped";
    this.enqueue(`“${excerpt(text)}” ${outcome}`, async () => {});
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
      (signal) => this.say(this.replyTo(text), signal),
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

  private enqueue(trigger: string, run: Turn["run"], delayMs = DECISION_DELAY_MS): void {
    this.turns.push({ trigger, delayMs, run });
    if (!this.current) void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.turns.length > 0) {
      const turn = this.turns.shift()!;
      const controller = new AbortController();
      this.current = controller;
      this.setStatus("working");
      this.push(this.statusLine("working", turn.trigger));
      try {
        await this.host.sleep(turn.delayMs, controller.signal);
        await turn.run(controller.signal);
      } catch {
        if (controller.signal.aborted) this.stopped();
      }
      this.current = null;
      this.setStatus("idle");
    }
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
