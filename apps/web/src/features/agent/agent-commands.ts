import { isActiveTaskStatus } from "@ddl/core";
import type { Services } from "../../app/services";
import { parseHotkey } from "../../commands/hotkeys";
import type { Command } from "../../commands/registry";
import { useAgentStore } from "../../state/agent-store";
import { ui } from "../../state/ui-store";

/** The thread shown in the agent panel, while its agent is at work. */
function workingThread(): string | null {
  const { rightOpen, rightView } = ui.get();
  if (!rightOpen || rightView.kind !== "thread") return null;
  const { details, threads } = useAgentStore.getState();
  const status = details[rightView.threadId]?.status ?? threads[rightView.threadId]?.status;
  return status && isActiveTaskStatus(status) ? rightView.threadId : null;
}

export function agentCommands(agent: Pick<Services["agent"], "cancel">): Command[] {
  return [
    {
      id: "agent:stop",
      name: "Stop the agent on this task",
      label: "Stop",
      hotkeys: [parseHotkey("Mod+.")],
      when: () => workingThread() !== null,
      run: () => {
        const threadId = workingThread();
        if (threadId) void agent.cancel(threadId);
      },
    },
  ];
}

/**
 * Registers the agent panel's commands once its chunk is loaded (they only apply while it shows a
 * thread), before any control that names them renders; they stay registered from then on.
 */
export function ensureAgentCommands({ commands, agent }: Pick<Services, "commands" | "agent">) {
  if (!commands.get("agent:stop")) commands.registerAll(agentCommands(agent));
}
