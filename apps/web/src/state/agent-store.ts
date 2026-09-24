import type { ServerEvent } from "@ddl/core";
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

export function usePendingApprovalCount(): number {
  return useAgentStore(countPendingApprovals);
}

export function findRecordByTask(taskId: string) {
  return findRecordIn(useAgentStore.getState().records, taskId);
}
