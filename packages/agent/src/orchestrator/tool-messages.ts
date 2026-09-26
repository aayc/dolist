import { createId, type MessageAuthor, type ToolCallMessage, toolResultText } from "@ddl/core";
import type { HarnessEvent } from "../harness/types";
import { previewText, sanitizeForDisplay } from "./redact";

type ToolStart = Pick<
  Extract<HarnessEvent, { type: "tool_start" }>,
  "toolCallId" | "toolName" | "input"
>;
type ToolEnd = Extract<HarnessEvent, { type: "tool_end" }>;

/** A thread's tool-call rows: each runs from `tool_start` until `tool_end` gives its outcome. */
export class ToolCallRows {
  /** Display labels of the session's tools by name. */
  labels: ReadonlyMap<string, string> = new Map();
  private readonly running = new Map<string, ToolCallMessage>();
  private readonly author: MessageAuthor;
  private readonly now: () => number;

  constructor(author: MessageAuthor, now: () => number) {
    this.author = author;
    this.now = now;
  }

  start(event: ToolStart): ToolCallMessage {
    const label = this.labels.get(event.toolName);
    const message: ToolCallMessage = {
      id: createId("msg"),
      kind: "tool_call",
      author: this.author,
      createdAt: this.now(),
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(label ? { label } : {}),
      input: sanitizeForDisplay(event.input),
      status: "running",
    };
    this.running.set(event.toolCallId, message);
    return message;
  }

  end(event: ToolEnd): ToolCallMessage {
    const started =
      this.running.get(event.toolCallId) ?? this.start({ ...event, input: undefined });
    this.running.delete(event.toolCallId);
    const preview = previewText(toolResultText(event.result), 300);
    return {
      ...started,
      status: event.blocked ? "blocked" : event.isError ? "error" : "ok",
      ...(preview ? { resultPreview: preview } : {}),
      endedAt: this.now(),
    };
  }

  /** Ends every running row as failed with `reason`, e.g. when the run stops. */
  close(reason: string): ToolCallMessage[] {
    const endedAt = this.now();
    const closed = [...this.running.values()].map(
      (message): ToolCallMessage => ({
        ...message,
        status: "error",
        resultPreview: reason,
        endedAt,
      }),
    );
    this.running.clear();
    return closed;
  }
}
