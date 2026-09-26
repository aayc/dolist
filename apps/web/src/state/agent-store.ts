import type { ServerEvent, ThreadMessage } from "@ddl/core";
import { useRef } from "react";
import { create } from "zustand";
import {
  type AgentState,
  countPendingApprovals,
  findRecordIn,
  initialAgentState,
  reduceAgentEvent,
} from "./agent-reducer";

export const useAgentStore = create<AgentState>(() => initialAgentState);

export function dispatchAgentEvent(event: ServerEvent): void {
  const state = useAgentStore.getState();
  const next = reduceAgentEvent(state, event);
  if (next !== state) useAgentStore.setState(next, true);
}

export function updateAgentState(update: (state: AgentState) => AgentState): void {
  const state = useAgentStore.getState();
  const next = update(state);
  if (next !== state) useAgentStore.setState(next, true);
}

const NO_MESSAGES: readonly ThreadMessage[] = [];

/**
 * A thread's messages for its rows. Agent text paints its own updates from the store
 * (`AgentText`), so a streamed delta or a refetched copy of a text message keeps the same array.
 */
export function useThreadMessages(threadId: string): readonly ThreadMessage[] {
  const rows = useRef(NO_MESSAGES);
  return useAgentStore((s) => {
    const next = s.details[threadId]?.messages ?? NO_MESSAGES;
    const prev = rows.current;
    const same =
      prev.length === next.length &&
      prev.every((a, i) => {
        const b = next[i]!;
        return (
          a === b || (a.kind === "text" && b.kind === "text" && a.id === b.id && a.role !== "user")
        );
      });
    if (!same) rows.current = next;
    return rows.current;
  });
}

export function usePendingApprovalCount(): number {
  return useAgentStore(countPendingApprovals);
}

export function findRecordByTask(taskId: string) {
  return findRecordIn(useAgentStore.getState().records, taskId);
}
