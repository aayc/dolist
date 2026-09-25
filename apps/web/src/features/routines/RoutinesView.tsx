import type { Routine } from "@ddl/core";
import { ArrowLeft, Pause, Repeat, TriangleAlert, X } from "lucide-react";
import { memo, useEffect } from "react";
import { useShallow } from "zustand/shallow";
import { useServices } from "../../app/services";
import { IconButton } from "../../components/IconButton";
import { cx } from "../../lib/cx";
import { formatTimestamp } from "../../lib/format";
import { useRoutinesStore } from "../../state/routines-store";
import { ui } from "../../state/ui-store";
import { StatusChip } from "../agent/StatusChip";
import { nextRunLabel, scheduleLabel } from "./routine-format";
import "../../styles/routines.css";

/** The Routines section in the agent panel: every routine, by name. */
export function RoutinesView() {
  const { routines: actions } = useServices();
  const { routines, status, error } = useRoutinesStore(
    useShallow((s) => ({ routines: s.routines, status: s.status, error: s.error })),
  );

  useEffect(() => {
    void actions.ensureLoaded();
  }, [actions]);

  return (
    <div className="routines-view" data-testid="routines-view">
      <header className="panel-header routines-header" data-tooltip-placement="bottom">
        <IconButton
          icon={ArrowLeft}
          label="Back to inbox"
          onClick={() => ui.showInbox()}
          data-testid="routines-back"
        />
        <span className="panel-title">Routines</span>
        <IconButton
          icon={X}
          label="Close agent panel"
          command="panel:right"
          onClick={() => ui.set({ rightOpen: false })}
        />
      </header>
      <div className="routines-scroll">
        {status === "error" ? (
          <div className="routines-notice is-alert" role="alert" data-testid="routines-error">
            <div className="routines-notice-text">
              <p className="routines-notice-title">Couldn't load your routines</p>
              <p>{error}</p>
            </div>
            <button type="button" className="link-button" onClick={() => void actions.load()}>
              Try again
            </button>
          </div>
        ) : status !== "loaded" ? (
          <div className="thread-loading" aria-busy="true" />
        ) : routines.length === 0 ? (
          <div className="inbox-empty routines-empty" data-testid="routines-empty">
            <Repeat size={28} strokeWidth={1.5} aria-hidden="true" />
            <p>No routines yet.</p>
            <p className="muted">
              A routine is a job the agent does on a schedule: a morning briefing, a weekly review,
              a price watch. Each one is a note in the Routines folder.
            </p>
          </div>
        ) : (
          routines.map((routine) => <RoutineRow key={routine.id} routine={routine} />)
        )}
      </div>
    </div>
  );
}

const RoutineRow = memo(function RoutineRow({ routine }: { routine: Routine }) {
  const next = nextRunLabel(routine);
  const last = routine.lastRun;
  return (
    <button
      type="button"
      className={cx("inbox-item routine-item", routine.error && "has-problem")}
      data-testid="routine-item"
      data-routine-id={routine.id}
      data-tooltip={routine.name}
      data-tooltip-overflow=".inbox-item-title"
      onClick={() => ui.showRoutine(routine.id)}
    >
      <span className="inbox-item-top">
        <span className="inbox-item-title" data-testid="routine-name">
          {routine.name}
        </span>
        {routine.paused ? (
          <span className="chip routine-paused" data-testid="routine-paused">
            <Pause size={11} strokeWidth={2} aria-hidden="true" />
            Paused
          </span>
        ) : null}
      </span>
      {routine.error ? (
        <span className="routine-problem" data-testid="routine-problem">
          <TriangleAlert size={12} strokeWidth={1.75} aria-hidden="true" />
          {routine.error}
        </span>
      ) : (
        <span className="routine-schedule" data-testid="routine-schedule">
          {scheduleLabel(routine)}
        </span>
      )}
      <span className="inbox-item-meta">
        {last ? (
          <span className="routine-last" data-testid="routine-last">
            <span className="sr-only">Last run:</span>
            <StatusChip status={last.status} />
            <time>{formatTimestamp(last.finishedAt ?? last.startedAt)}</time>
          </span>
        ) : (
          <span data-testid="routine-last">No runs yet</span>
        )}
        {next ? (
          <span className="routine-next" data-testid="routine-next">
            Next run {next}
          </span>
        ) : null}
      </span>
    </button>
  );
});
