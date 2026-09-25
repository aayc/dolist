import { useAgentStore } from "../../state/agent-store";
import { readOnlyReason } from "./placement";

/**
 * Why this device can't act on the agent right now (another device runs it, or the always-on
 * machine can't be used from here), or null: agent actions are disabled with it as their tooltip.
 */
export function useReadOnlyReason(): string | null {
  return useAgentStore((s) => readOnlyReason(s.status?.placement));
}
