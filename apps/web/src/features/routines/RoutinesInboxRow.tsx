import type { Routine } from "@ddl/core";
import { Repeat, TriangleAlert } from "lucide-react";
import { memo, useEffect } from "react";
import { useServices } from "../../app/services";
import { commandTooltip } from "../../commands/labels";
import { Count } from "../../components/Count";
import { useRoutinesStore } from "../../state/routines-store";
import { ui } from "../../state/ui-store";
import { formatDayTime } from "./routine-format";
import "../../styles/routines.css";

/** What the pinned row says: the routine that runs next, or what routines are. */
export function routinesPreview(routines: readonly Routine[], now: number = Date.now()): string {
  let next: Routine | undefined;
  for (const routine of routines) {
    if (routine.paused || routine.error || routine.nextRunAt === undefined) continue;
    if (!next || routine.nextRunAt < (next.nextRunAt ?? Infinity)) next = routine;
  }
  if (next?.nextRunAt !== undefined) {
    return `Next: ${next.name}, ${formatDayTime(next.nextRunAt, now)}`;
  }
  if (routines.length > 0) return "Nothing scheduled: every routine is paused or needs fixing.";
  return "Standing jobs the agent runs on a schedule, like a morning briefing.";
}

/** Pinned in the inbox under the orchestrator's chat: the way into the Routines section. */
export const RoutinesInboxRow = memo(function RoutinesInboxRow() {
  const { routines: actions, commands } = useServices();
  const routines = useRoutinesStore((s) => s.routines);
  const broken = routines.filter((routine) => routine.error).length;

  useEffect(() => {
    void actions.ensureLoaded();
  }, [actions]);

  return (
    <button
      type="button"
      className="inbox-item routines-row"
      data-testid="inbox-routines"
      {...commandTooltip(commands, "routines:show")}
      onClick={() => ui.showRoutines()}
    >
      <span className="inbox-item-top">
        <Repeat size={15} strokeWidth={1.75} className="routines-row-icon" aria-hidden="true" />
        <span className="inbox-item-title">Routines</span>
        {broken > 0 ? (
          <span className="routines-row-problem">
            <TriangleAlert size={13} strokeWidth={1.75} aria-hidden="true" />
            {broken} to fix
          </span>
        ) : null}
        {routines.length > 0 ? <Count value={routines.length} className="inbox-count" /> : null}
      </span>
      <span className="inbox-item-preview">{routinesPreview(routines)}</span>
    </button>
  );
});
