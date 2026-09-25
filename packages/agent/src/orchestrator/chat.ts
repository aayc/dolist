import {
  createId,
  type Logger,
  ORCHESTRATOR_THREAD_ID,
  ORCHESTRATOR_THREAD_TITLE,
  type StatusMessage,
  silentLogger,
  type TaskAgentStatus,
  type TextMessage,
  type Thread,
  type ToolCallMessage,
  toolResultText,
} from "@ddl/core";
import type { HarnessEvent } from "../harness/types";
import type { ThreadStore } from "../threads/types";
import { previewText, sanitizeForDisplay } from "./redact";

/** The chat keeps this many messages; older ones are dropped at the end of each turn. */
export const ORCHESTRATOR_CHAT_MAX_MESSAGES = 500;

export interface OrchestratorChatOptions {
  threads: ThreadStore;
  now?: () => number;
  logger?: Logger;
  maxMessages?: number;
}

/** One message of the user's direct conversation with the orchestrator. */
export interface ChatExchange {
  author: "you" | "orchestrator";
  text: string;
  createdAt: number;
}

export interface TurnEnd {
  error?: string;
  /** The user stopped the turn. */
  cancelled?: boolean;
  /** The agent is shutting down mid-turn. */
  interrupted?: boolean;
}

interface Stream {
  id: string;
  text: string;
  createdAt: number;
  posted: boolean;
}

interface Thinking {
  messageId: string;
  createdAt: number;
  /** Thinking time of finished segments. */
  totalMs: number;
  /** Start of the segment in progress. */
  since: number | null;
}

/**
 * The orchestrator's own chat (`ORCHESTRATOR_THREAD_ID`): every turn as a status line saying what
 * woke it, its streamed text, its tool calls (with the task ids they act on), and one collapsed
 * "Thought for N s" line when it reasoned — never the reasoning itself. The thread's status is
 * `working` during a turn and `idle` otherwise.
 */
export class OrchestratorChat {
  readonly threadId = ORCHESTRATOR_THREAD_ID;
  private readonly threads: ThreadStore;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly maxMessages: number;
  private readonly streams = new Map<string, Stream>();
  private readonly tools = new Map<string, ToolCallMessage>();
  private labels: ReadonlyMap<string, string> = new Map();
  private thinking: Thinking | null = null;
  private inTurn = false;

  constructor(options: OrchestratorChatOptions) {
    this.threads = options.threads;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
    this.maxMessages = options.maxMessages ?? ORCHESTRATOR_CHAT_MAX_MESSAGES;
  }

  /**
   * Creates the thread when it doesn't exist yet. A thread left mid-turn by a daemon that died is
   * settled: running tool calls end as interrupted and the status goes back to idle.
   */
  ensure(): Thread {
    const thread = this.thread();
    if (!this.inTurn) {
      for (const message of thread.messages) {
        if (message.kind === "tool_call" && message.status === "running") {
          this.threads.upsertMessage(this.threadId, {
            ...message,
            status: "error",
            resultPreview: "Interrupted",
            endedAt: message.endedAt ?? message.createdAt,
          });
        }
      }
      this.threads.setStatus(this.threadId, "idle");
    }
    this.threads.trimMessages(this.threadId, this.maxMessages);
    return this.threads.get(this.threadId) ?? thread;
  }

  /** Starts recording a turn. `labels`: display labels of the session's tools by name. */
  beginTurn(trigger: string, labels: ReadonlyMap<string, string>): void {
    this.thread();
    this.closeOpenRows("Interrupted");
    this.inTurn = true;
    this.labels = labels;
    this.status("system", "working", trigger);
    this.threads.setStatus(this.threadId, "working");
  }

  /** The session's tools changed (a new session was created during the turn). */
  setLabels(labels: ReadonlyMap<string, string>): void {
    this.labels = labels;
  }

  onEvent(event: HarnessEvent): void {
    if (!this.inTurn) return;
    try {
      this.apply(event);
    } catch (error) {
      this.logger.error("Failed to record an orchestrator event", {
        type: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  endTurn(end: TurnEnd = {}): void {
    if (!this.inTurn) return;
    const reason = end.cancelled ? "Stopped" : end.interrupted ? "Interrupted" : "Not finished";
    this.closeOpenRows(reason);
    if (end.cancelled) {
      this.status("system", "cancelled", "You stopped this run");
    } else if (end.error && !end.interrupted) {
      this.status("system", "failed", `This run failed: ${previewText(end.error, 300)}`);
    }
    this.inTurn = false;
    this.threads.setStatus(this.threadId, "idle");
    this.threads.trimMessages(this.threadId, this.maxMessages);
  }

  /**
   * The latest messages of the user's conversation with the orchestrator (their messages and its
   * replies), oldest first, without the ids in `exclude` (messages the current digest carries).
   */
  recentExchanges(limit: number, exclude: ReadonlySet<string> = new Set()): ChatExchange[] {
    const thread = this.threads.get(this.threadId);
    if (!thread) return [];
    const out: ChatExchange[] = [];
    for (let i = thread.messages.length - 1; i >= 0 && out.length < limit; i--) {
      const message = thread.messages[i]!;
      if (message.kind !== "text" || exclude.has(message.id)) continue;
      const text = message.text.trim();
      if (!text) continue;
      if (message.role === "user") out.push({ author: "you", text, createdAt: message.createdAt });
      else if (message.role === "agent" && message.author === "orchestrator") {
        out.push({ author: "orchestrator", text, createdAt: message.createdAt });
      }
    }
    return out.reverse();
  }

  private thread(): Thread {
    return (
      this.threads.get(this.threadId) ??
      this.threads.create({
        id: this.threadId,
        taskId: null,
        notePath: null,
        title: ORCHESTRATOR_THREAD_TITLE,
      })
    );
  }

  // ── Events → messages ─────────────────────────────────────────────────────

  private apply(event: HarnessEvent): void {
    switch (event.type) {
      case "thinking_delta":
        this.think();
        return;
      case "text_delta": {
        this.stopThinking();
        let stream = this.streams.get(event.messageId);
        if (!stream) {
          stream = { id: createId("msg"), text: "", createdAt: this.now(), posted: false };
          this.streams.set(event.messageId, stream);
        }
        stream.text += event.delta;
        if (!stream.posted) {
          // Leading whitespace alone doesn't open a message bubble.
          if (stream.text.trim() === "") return;
          stream.posted = true;
          this.threads.upsertMessage(this.threadId, this.textMessage(stream, stream.text, true));
          return;
        }
        this.threads.appendDelta(this.threadId, stream.id, event.delta);
        return;
      }
      case "message_end": {
        this.stopThinking();
        const stream = this.streams.get(event.messageId);
        this.streams.delete(event.messageId);
        const text = (event.text || stream?.text || "").trim();
        if (stream?.posted || text) {
          const final = stream ?? {
            id: createId("msg"),
            text,
            createdAt: this.now(),
            posted: false,
          };
          this.threads.upsertMessage(this.threadId, this.textMessage(final, text, false));
        }
        return;
      }
      case "tool_start": {
        this.stopThinking();
        const label = this.labels.get(event.toolName);
        const message: ToolCallMessage = {
          id: createId("msg"),
          kind: "tool_call",
          author: "orchestrator",
          createdAt: this.now(),
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(label ? { label } : {}),
          input: sanitizeForDisplay(event.input),
          status: "running",
        };
        this.tools.set(event.toolCallId, message);
        this.threads.upsertMessage(this.threadId, message);
        return;
      }
      case "tool_end": {
        const started = this.tools.get(event.toolCallId);
        this.tools.delete(event.toolCallId);
        const label = this.labels.get(event.toolName);
        const preview = previewText(toolResultText(event.result), 300);
        this.threads.upsertMessage(this.threadId, {
          ...(started ?? {
            id: createId("msg"),
            kind: "tool_call",
            author: "orchestrator",
            createdAt: this.now(),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            ...(label ? { label } : {}),
            input: undefined,
          }),
          status: event.blocked ? "blocked" : event.isError ? "error" : "ok",
          ...(preview ? { resultPreview: preview } : {}),
          endedAt: this.now(),
        });
        return;
      }
      default:
        return;
    }
  }

  private textMessage(stream: Stream, text: string, streaming: boolean): TextMessage {
    return {
      id: stream.id,
      kind: "text",
      role: "agent",
      author: "orchestrator",
      text,
      ...(streaming ? { streaming: true } : {}),
      createdAt: stream.createdAt,
    };
  }

  /** One line per turn, placed where it first thought, updated as thinking resumes. */
  private think(): void {
    const at = this.now();
    if (!this.thinking) {
      this.thinking = { messageId: createId("msg"), createdAt: at, totalMs: 0, since: at };
      this.threads.upsertMessage(this.threadId, this.thinkingMessage("Thinking…"));
      return;
    }
    this.thinking.since ??= at;
  }

  private stopThinking(): void {
    const thinking = this.thinking;
    if (!thinking || thinking.since === null) return;
    thinking.totalMs += this.now() - thinking.since;
    thinking.since = null;
    const seconds = Math.max(1, Math.round(thinking.totalMs / 1000));
    this.threads.upsertMessage(this.threadId, this.thinkingMessage(`Thought for ${seconds} s`));
  }

  private thinkingMessage(text: string): StatusMessage {
    const thinking = this.thinking!;
    return {
      id: thinking.messageId,
      kind: "status",
      author: "orchestrator",
      status: "working",
      text,
      createdAt: thinking.createdAt,
    };
  }

  private status(author: "system" | "orchestrator", status: TaskAgentStatus, text: string): void {
    this.threads.upsertMessage(this.threadId, {
      id: createId("msg"),
      kind: "status",
      author,
      status,
      text,
      createdAt: this.now(),
    });
  }

  /** Ends streaming bubbles, running tool rows and thinking left open by a turn. */
  private closeOpenRows(reason: string): void {
    this.stopThinking();
    this.thinking = null;
    for (const stream of this.streams.values()) {
      if (stream.posted) {
        this.threads.upsertMessage(
          this.threadId,
          this.textMessage(stream, stream.text.trim(), false),
        );
      }
    }
    this.streams.clear();
    for (const message of this.tools.values()) {
      this.threads.upsertMessage(this.threadId, {
        ...message,
        status: "error",
        resultPreview: reason,
        endedAt: this.now(),
      });
    }
    this.tools.clear();
  }
}
