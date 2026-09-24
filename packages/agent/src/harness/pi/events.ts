/**
 * Maps Pi AgentSession events to HarnessEvents with the same semantics as ScriptedHarness: one
 * `turn_start` … `idle` bracket per run, stable message ids, tool lifecycle with a `blocked` flag.
 * Pure apart from id generation, so it is testable with synthetic events.
 */
import { createId, errorResult } from "@ddl/core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { HarnessEvent } from "../types";
import type { ToolCallLedger } from "./ledger";
import { toToolResult } from "./tools";

export interface PiEventMapperOptions {
  ledger: ToolCallLedger;
  newMessageId?: () => string;
}

export class PiEventMapper {
  private readonly ledger: ToolCallLedger;
  private readonly newMessageId: () => string;
  private messageId: string | undefined;
  private messageStreamed = false;
  private inRun = false;

  constructor(options: PiEventMapperOptions) {
    this.ledger = options.ledger;
    this.newMessageId = options.newMessageId ?? (() => createId("msg"));
  }

  map(event: AgentSessionEvent): HarnessEvent[] {
    switch (event.type) {
      case "agent_start":
        if (this.inRun) return [];
        this.inRun = true;
        return [{ type: "turn_start" }];
      case "message_start":
        if (isAssistant(event.message)) this.startMessage();
        return [];
      case "message_update":
        return this.mapDelta(event.assistantMessageEvent);
      case "message_end":
        return isAssistant(event.message) ? this.endMessage(event.message) : [];
      case "tool_execution_start":
        return [
          {
            type: "tool_start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.args,
          },
        ];
      case "tool_execution_update":
        return [
          {
            type: "tool_update",
            toolCallId: event.toolCallId,
            partial: toToolResult(event.partialResult, false),
          },
        ];
      case "tool_execution_end":
        return [this.endTool(event.toolCallId, event.toolName, event.result, event.isError)];
      case "agent_end":
        return this.endRun(event.messages, event.willRetry);
      case "agent_settled":
        this.inRun = false;
        this.messageId = undefined;
        return [{ type: "idle" }];
      default:
        return [];
    }
  }

  private startMessage(): string {
    this.messageId = this.newMessageId();
    this.messageStreamed = false;
    return this.messageId;
  }

  private mapDelta(
    update: Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"],
  ): HarnessEvent[] {
    if (update.type !== "text_delta" && update.type !== "thinking_delta") return [];
    if (!update.delta) return [];
    const messageId = this.messageId ?? this.startMessage();
    this.messageStreamed = true;
    return [{ type: update.type, messageId, delta: update.delta }];
  }

  private endMessage(message: AssistantMessage): HarnessEvent[] {
    const messageId = this.messageId ?? this.newMessageId();
    const streamed = this.messageStreamed;
    this.messageId = undefined;
    this.messageStreamed = false;
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    const failed = message.stopReason === "error" || message.stopReason === "aborted";
    const events: HarnessEvent[] = [];
    if (text || streamed || !failed) events.push({ type: "message_end", messageId, text });
    const usage = message.usage as AssistantMessage["usage"] | undefined;
    if (!usage) return events;
    const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    const costUsd = usage.cost?.total ?? 0;
    if (inputTokens > 0 || usage.output > 0) {
      events.push(
        costUsd > 0
          ? { type: "usage", inputTokens, outputTokens: usage.output, costUsd }
          : { type: "usage", inputTokens, outputTokens: usage.output },
      );
    }
    return events;
  }

  private endTool(
    toolCallId: string,
    toolName: string,
    piResult: unknown,
    piIsError: boolean,
  ): HarnessEvent {
    const settled = this.ledger.settle(toolCallId);
    if (settled.blockedReason !== undefined) {
      return {
        type: "tool_end",
        toolCallId,
        toolName,
        result: errorResult(`Blocked by safety policy: ${settled.blockedReason}`),
        isError: true,
        blocked: true,
      };
    }
    const result = settled.result ?? toToolResult(piResult, piIsError);
    const isError = piIsError || result.isError === true;
    return {
      type: "tool_end",
      toolCallId,
      toolName,
      result: isError && !result.isError ? { ...result, isError: true } : result,
      isError,
    };
  }

  /** Reports a failed run once, after Pi has decided not to retry it. */
  private endRun(messages: AgentMessage[], willRetry: boolean): HarnessEvent[] {
    if (willRetry) return [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message && isAssistant(message)) {
        return message.stopReason === "error"
          ? [{ type: "error", message: message.errorMessage || "The model request failed" }]
          : [];
      }
    }
    return [];
  }
}

function isAssistant(message: AgentMessage): message is AssistantMessage {
  return (message as { role?: unknown }).role === "assistant";
}
