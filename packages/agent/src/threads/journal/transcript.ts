/**
 * Rebuilds the conversation of a thread's latest agent session from its journal, to restore the
 * session after a restart or a handover: the prompts, the model's text and tool calls, and each
 * call's result as the model read it. A call without a result gets one saying why, so the model
 * never mistakes a step the restart cut off for one that finished.
 */
import type { PersistedJournalEvent } from "@ddl/contract";
import type { TranscriptEntry, TranscriptToolCall } from "../../harness/types";

export const INTERRUPTED_RESULT =
  "Error: interrupted — the agent restarted before this finished. It changed nothing, so you can do it again if you still need it.";
export const UNCERTAIN_RESULT =
  "Error: interrupted — the agent restarted while this was running, so it may or may not have happened. Check before doing it again.";
export const UNDECIDED_RESULT =
  "Error: not run — the agent restarted before the user decided. Call the tool again if you still need it; the user will be asked again.";

export interface SessionTranscript {
  /** The session the conversation belonged to. */
  sessionId: string;
  entries: TranscriptEntry[];
}

type AssistantEntry = Extract<TranscriptEntry, { role: "assistant" }>;

interface CallState {
  name: string;
  outcome?: "ok" | "error" | "blocked";
  output?: string;
  allowed?: boolean;
  reason?: string;
  started?: { effectful: boolean };
}

/** Null when the journal has no prompt to an agent session. */
export function buildTranscript(
  events: readonly PersistedJournalEvent[],
): SessionTranscript | null {
  let sessionId: string | undefined;
  for (let i = events.length - 1; i >= 0 && sessionId === undefined; i--) {
    const event = events[i]!;
    if (event.type === "run.prompted") sessionId = event.session;
  }
  if (sessionId === undefined) return null;
  const start = events.findIndex((e) => e.type === "run.prompted" && e.session === sessionId);
  const session = events.slice(start);

  const calls = new Map<string, CallState>();
  for (const event of session) {
    if (event.type === "tool.requested" && event.session === sessionId) {
      calls.set(event.call, { name: event.tool });
      continue;
    }
    const call =
      event.type.startsWith("tool.") && "call" in event ? calls.get(event.call) : undefined;
    if (!call) continue;
    switch (event.type) {
      case "tool.decided":
        call.allowed = event.allowed;
        if (event.reason !== undefined) call.reason = event.reason;
        break;
      case "tool.started":
        call.started = { effectful: event.effectful !== false };
        break;
      case "tool.finished":
        call.outcome ??= event.outcome;
        if (event.output !== undefined) call.output ??= event.output;
        break;
      default:
        break;
    }
  }

  const entries: TranscriptEntry[] = [];
  /** The assistant message being rebuilt, and whether results of its calls came in already. */
  const open: { message: AssistantEntry | null; resultsSeen: boolean } = {
    message: null,
    resultsSeen: false,
  };
  const flush = () => {
    const message = open.message;
    if (!message) return;
    entries.push(message);
    for (const call of message.toolCalls) entries.push(resultOf(call, calls.get(call.id)!));
    open.message = null;
    open.resultsSeen = false;
  };
  const current = (): AssistantEntry => {
    if (open.resultsSeen) flush();
    open.message ??= { role: "assistant", text: "", toolCalls: [] };
    return open.message;
  };
  for (const event of session) {
    switch (event.type) {
      case "run.prompted":
        if (event.session !== sessionId) break;
        flush();
        entries.push({ role: "user", text: event.text });
        break;
      case "run.text": {
        if (event.session !== sessionId) break;
        if (open.message && open.message.toolCalls.length > 0) flush();
        const message = current();
        message.text = message.text ? `${message.text}\n\n${event.text}` : event.text;
        break;
      }
      case "tool.requested":
        if (event.session !== sessionId) break;
        current().toolCalls.push({ id: event.call, name: event.tool, input: event.input });
        break;
      case "tool.finished":
        if (open.message?.toolCalls.some((call) => call.id === event.call)) {
          open.resultsSeen = true;
        }
        break;
      default:
        break;
    }
  }
  flush();
  return { sessionId, entries };
}

function resultOf(call: TranscriptToolCall, state: CallState): TranscriptEntry {
  const base = { role: "tool" as const, toolCallId: call.id, toolName: call.name };
  if (state.outcome !== undefined) {
    return { ...base, output: state.output ?? "", isError: state.outcome !== "ok" };
  }
  if (state.started) {
    return {
      ...base,
      output: state.started.effectful ? UNCERTAIN_RESULT : INTERRUPTED_RESULT,
      isError: true,
    };
  }
  if (state.allowed === false) {
    return {
      ...base,
      output: `Blocked by safety policy: ${state.reason ?? "denied"}`,
      isError: true,
    };
  }
  return { ...base, output: UNDECIDED_RESULT, isError: true };
}
