import { isOrchestratorThread } from "@ddl/core";
import { useServices } from "../../app/services";
import { useUiStore } from "../../state/ui-store";
import { RoutinesView } from "../routines/RoutinesView";
import { RoutineView } from "../routines/RoutineView";
import { ensureAgentCommands } from "./agent-commands";
import { Inbox } from "./Inbox";
import { OrchestratorView } from "./OrchestratorView";
import { TaskPending } from "./TaskPending";
import { ThreadView } from "./ThreadView";
import "../../styles/agent.css";

/**
 * Right panel content (lazy chunk): the inbox, a thread, a task still being triaged, or the
 * routines.
 */
export function AgentPanel() {
  ensureAgentCommands(useServices());
  const view = useUiStore((s) => s.rightView);
  if (view.kind === "thread" && isOrchestratorThread(view.threadId)) return <OrchestratorView />;
  if (view.kind === "thread") return <ThreadView key={view.threadId} threadId={view.threadId} />;
  if (view.kind === "task") return <TaskPending taskId={view.taskId} />;
  if (view.kind === "routines") return <RoutinesView />;
  if (view.kind === "routine")
    return <RoutineView key={view.routineId} routineId={view.routineId} />;
  return <Inbox />;
}
