import { useUiStore } from "../../state/ui-store";
import { Inbox } from "./Inbox";
import { TaskPending } from "./TaskPending";
import { ThreadView } from "./ThreadView";
import "../../styles/agent.css";

/** Right panel content (lazy chunk): the inbox, a thread, or a task still being triaged. */
export function AgentPanel() {
  const view = useUiStore((s) => s.rightView);
  if (view.kind === "thread") return <ThreadView key={view.threadId} threadId={view.threadId} />;
  if (view.kind === "task") return <TaskPending taskId={view.taskId} />;
  return <Inbox />;
}
