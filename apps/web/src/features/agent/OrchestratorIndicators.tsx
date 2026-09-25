import { LoaderCircle } from "lucide-react";
import { useServices } from "../../app/services";
import { commandTooltip } from "../../commands/labels";
import { useActivityStore } from "../../state/activity-store";
import { noteIndicator, statusIndicator } from "../editor/activity-chips";

const TOOLTIP = "Open the orchestrator's chat at this run";

/** In the note header, while the orchestrator's turn is about this note. */
export function NoteOrchestratorIndicator({ path }: { path: string }) {
  const { agent, commands } = useServices();
  const turn = useActivityStore((s) => s.turn);
  const text = noteIndicator(turn, path);
  if (!turn || !text) return null;
  return (
    <button
      type="button"
      className="note-orchestrator"
      onClick={() => agent.openTurn(turn.turnId ?? null)}
      {...commandTooltip(commands, "agent:orchestrator", TOOLTIP)}
      data-testid="note-orchestrator"
      data-phase={turn.phase}
    >
      <span className="note-orchestrator-dot" aria-hidden="true" />
      {text}
    </button>
  );
}

/** In the status bar, while the orchestrator's turn is about something other than the open note. */
export function StatusOrchestratorItem({ path }: { path: string | null }) {
  const { agent, commands } = useServices();
  const turn = useActivityStore((s) => s.turn);
  const text = statusIndicator(turn, path);
  if (!turn || !text) return null;
  return (
    <button
      type="button"
      className="status-item status-orchestrator"
      onClick={() => agent.openTurn(turn.turnId ?? null)}
      {...commandTooltip(commands, "agent:orchestrator", TOOLTIP)}
      data-testid="status-orchestrator"
      data-phase={turn.phase}
    >
      <LoaderCircle size={12} className="spin" aria-hidden="true" />
      <span className="status-orchestrator-text">{text}</span>
    </button>
  );
}
