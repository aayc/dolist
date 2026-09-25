import type { ThreadMessage, ThreadSummary } from "@ddl/core";
import { type AgentState, findRecordIn } from "../../state/agent-reducer";

/** What a tool call of the orchestrator acted on: its task, and that task's thread if it has one. */
export interface TaskRef {
  taskId: string;
  threadId: string | null;
  /** The task's text (its thread's title), when known. */
  title: string | null;
}

/** The task id an orchestrator tool call carries in its input (`taskId`), if any. */
export function taskIdOf(message: ThreadMessage): string | null {
  if (message.kind !== "tool_call") return null;
  const input = message.input;
  if (typeof input !== "object" || input === null) return null;
  const taskId = (input as { taskId?: unknown }).taskId;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : null;
}

const indexes = new WeakMap<object, Map<string, ThreadSummary>>();

/** Threads by task id, built once per thread list (the store replaces it on every change). */
function threadsByTask(threads: AgentState["threads"]): Map<string, ThreadSummary> {
  let index = indexes.get(threads);
  if (!index) {
    index = new Map();
    for (const thread of Object.values(threads)) {
      if (!thread.taskId) continue;
      const known = index.get(thread.taskId);
      if (!known || thread.updatedAt > known.updatedAt) index.set(thread.taskId, thread);
    }
    indexes.set(threads, index);
  }
  return index;
}

/** The task behind `taskId`, from thread summaries and loaded records; null when unknown. */
export function resolveTask(state: AgentState, taskId: string): TaskRef | null {
  const thread = threadsByTask(state.threads).get(taskId);
  const record = findRecordIn(state.records, taskId);
  if (!thread && !record) return null;
  return {
    taskId,
    threadId: thread?.id ?? record?.threadId ?? null,
    title: thread?.title ?? record?.text ?? null,
  };
}
