/**
 * The journal's write-ahead log around tool calls, as a harness decorator: it only uses the
 * `Harness` interfaces, so it works the same for every harness. For each call that reaches the
 * safety gate, in the session's thread:
 *
 *   tool.requested → (the gate decides) → tool.decided → tool.started → (runs) → tool.finished
 *
 * `tool.started` ("about to run") is on disk before the harness gets the go-ahead, for every call
 * that may change something, so a restart can tell a finished step from an uncertain one. Nothing
 * here allows anything: the gate's decision is passed through unchanged, and a call whose record
 * can't be written is blocked.
 */
import { type Logger, silentLogger, type ToolResult, toolResultText } from "@ddl/core";
import type {
  Harness,
  HarnessEvent,
  HarnessSessionOptions,
  ToolCallDecision,
  ToolCallRequest,
} from "../../harness/types";
import { redactSecrets, sanitizeForDisplay } from "../../orchestrator/redact";
import type { ThreadJournal } from "../types";

export interface ToolLedgerOptions {
  journal: ThreadJournal;
  /** The thread a session's tool calls belong to (null: no thread, nothing to journal). */
  threadFor(sessionId: string): string | null;
  logger?: Logger;
}

export const UNRECORDED_CALL_REASON =
  "the action couldn't be recorded before running, so it didn't run";

export function journalingHarness(inner: Harness, options: ToolLedgerOptions): Harness {
  const logger = options.logger ?? silentLogger;
  return {
    name: inner.name,
    createSession: (session) => inner.createSession(journaled(session, options, logger)),
    ...(inner.prewarm ? { prewarm: () => inner.prewarm!() } : {}),
    ...(inner.dispose ? { dispose: () => inner.dispose!() } : {}),
  };
}

function journaled(
  session: HarnessSessionOptions,
  options: ToolLedgerOptions,
  logger: Logger,
): HarnessSessionOptions {
  const { journal } = options;
  /** Thread of each call journaled at the gate, until its result (the session may close first). */
  const calls = new Map<string, string>();
  const threadFor = (sessionId: string): string | null => {
    try {
      return options.threadFor(sessionId);
    } catch {
      return null;
    }
  };

  const beforeToolCall = async (call: ToolCallRequest): Promise<ToolCallDecision> => {
    const threadId = threadFor(call.sessionId);
    if (!threadId) return session.beforeToolCall(call);
    calls.set(call.toolCallId, threadId);
    journal.recordToolRequested(threadId, {
      callId: call.toolCallId,
      tool: call.toolName,
      sessionId: call.sessionId,
      input: sanitizeForDisplay(call.input),
    });
    const decision = await session.beforeToolCall(call);
    if (!decision.allow) {
      // Blocked because the session is closing (the agent stopping) isn't a verdict: a resumed
      // run finds the call undecided and asks again.
      if (session.signal?.aborted !== true) {
        journal.recordToolBlocked(threadId, call.toolCallId, decision.reason);
      }
      return decision;
    }
    try {
      await journal.recordToolStarting(threadId, call.toolCallId, {
        tool: call.toolName,
        target: decision.summary || call.spec?.label || call.toolName,
        ...(decision.via ? { via: decision.via } : {}),
        ...(decision.approvalId ? { approvalId: decision.approvalId } : {}),
        ...(decision.effectful === false ? { effectful: false } : {}),
      });
    } catch (error) {
      logger.error("Couldn't journal a tool call before running it; blocking it", {
        tool: call.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      calls.delete(call.toolCallId);
      journal.recordToolFinished(threadId, call.toolCallId, {
        outcome: "blocked",
        output: `Blocked: ${UNRECORDED_CALL_REASON}.`,
      });
      return { allow: false, reason: UNRECORDED_CALL_REASON };
    }
    return decision;
  };

  const onEvent = (event: HarnessEvent): void => {
    if (event.type === "message_end" && session.role === "subagent" && event.text.trim()) {
      const threadId = threadFor(session.sessionId);
      if (threadId) journal.recordReply(threadId, session.sessionId, event.text);
    }
    if (event.type === "tool_end") {
      const threadId = calls.get(event.toolCallId);
      calls.delete(event.toolCallId);
      // A call cut off by the session closing may or may not have done its work (it stays open),
      // and one blocked by it was never decided.
      const cutOff = event.isError && session.signal?.aborted === true;
      if (threadId && !cutOff) {
        journal.recordToolFinished(threadId, event.toolCallId, {
          outcome: event.blocked ? "blocked" : event.isError ? "error" : "ok",
          // Only a subagent's session is ever rebuilt; the orchestrator's results aren't kept.
          ...(session.role === "subagent"
            ? { output: outputForModel(event.result, event.isError, event.blocked === true) }
            : {}),
        });
      }
    }
    session.onEvent?.(event);
  };

  return { ...session, beforeToolCall, onEvent };
}

/** What the model read for a result (as the harnesses phrase it), secrets redacted. */
export function outputForModel(result: ToolResult, isError: boolean, blocked: boolean): string {
  const images = result.content.filter((part) => part.type === "image").length;
  let text = toolResultText(result).trim();
  if (images > 0)
    text = `${text}${text ? "\n" : ""}[${images === 1 ? "an image" : `${images} images`}]`;
  if (isError && !blocked) {
    if (!text) text = "Error: the tool reported a failure without details";
    else if (!/^error\b/i.test(text)) text = `Error: ${text}`;
  }
  return redactSecrets(text);
}
