import type { Routine, ThreadSummary } from "@ddl/core";
import { ArrowLeft, FilePen, Pause, Play, ShieldAlert, TriangleAlert, X } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import { useServices } from "../../app/services";
import { Count } from "../../components/Count";
import { IconButton } from "../../components/IconButton";
import { perfStart } from "../../perf/perf";
import { routineRuns } from "../../state/agent-reducer";
import { useAgentStore } from "../../state/agent-store";
import { findRoutine, useRoutinesStore } from "../../state/routines-store";
import { ui } from "../../state/ui-store";
import { StatusChip } from "../agent/StatusChip";
import type { Notice } from "./routine-errors";
import {
  capitalize,
  extraRunsLabel,
  formatDayTime,
  idleReason,
  NOTIFY_LABELS,
  nextRunLabel,
  scheduleLabel,
} from "./routine-format";
import "../../styles/routines.css";

/** One routine in the agent panel: what it does and when, its actions, and its own inbox of runs. */
export function RoutineView({ routineId }: { routineId: string }) {
  const { routines: actions } = useServices();
  const routine = useRoutinesStore((s) => findRoutine(s, routineId));
  const loaded = useRoutinesStore((s) => s.status === "loaded");

  useEffect(() => {
    void actions.ensureLoaded();
    void actions.loadRuns(routineId);
  }, [actions, routineId]);

  return (
    <div className="routine-view" data-testid="routine-view" data-routine-id={routineId}>
      {routine ? (
        <RoutineDetails routine={routine} />
      ) : (
        <>
          <RoutineHeader title="Routine" />
          <div className="routines-scroll">
            {loaded ? (
              <div className="inbox-empty" data-testid="routine-gone">
                <p>This routine is gone.</p>
                <p className="muted">Its file was renamed, moved or deleted.</p>
              </div>
            ) : (
              <div className="thread-loading" aria-busy="true" />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function RoutineHeader({ title, routine }: { title: string; routine?: Routine }) {
  return (
    <header className="thread-header" data-tooltip-placement="bottom">
      <IconButton
        icon={ArrowLeft}
        label="Back to routines"
        onClick={() => ui.showRoutines()}
        data-testid="routine-back"
      />
      <div className="thread-heading">
        <h2
          className="thread-title"
          data-tooltip={title}
          data-tooltip-overflow=""
          data-testid="routine-title"
        >
          {title}
        </h2>
        {routine ? (
          <div className="thread-meta">
            {routine.paused ? (
              <span className="chip routine-paused" data-testid="routine-view-paused">
                <Pause size={11} strokeWidth={2} aria-hidden="true" />
                Paused
              </span>
            ) : null}
            <span className="thread-note" data-testid="routine-view-schedule">
              {scheduleLabel(routine)}
            </span>
          </div>
        ) : null}
      </div>
      <div className="thread-actions">
        <IconButton
          icon={X}
          label="Close agent panel"
          command="panel:right"
          onClick={() => ui.set({ rightOpen: false })}
        />
      </div>
    </header>
  );
}

function RoutineDetails({ routine }: { routine: Routine }) {
  const { routines: actions } = useServices();
  const threads = useAgentStore((s) => s.threads);
  const runs = useMemo(() => routineRuns(threads, routine.id), [threads, routine.id]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [starting, setStarting] = useState(false);
  const next = nextRunLabel(routine);
  const { lastRun } = routine;
  const lastRunKey = lastRun ? `${lastRun.threadId}:${lastRun.status}:${lastRun.finishedAt}` : "";

  // Why the last Run now didn't start stops being true once a run starts or ends.
  useEffect(() => {
    if (lastRunKey) setNotice(null);
  }, [lastRunKey]);

  const runNow = async () => {
    setStarting(true);
    setNotice(null);
    const result = await actions.runNow(routine);
    setStarting(false);
    if (!result.ok) setNotice(result.problem);
  };

  return (
    <>
      <RoutineHeader title={routine.name} routine={routine} />
      <div className="routine-toolbar">
        <button
          type="button"
          className="button is-primary"
          data-testid="routine-run"
          data-tooltip={`Run it once now, besides its schedule · ${extraRunsLabel(routine.extraRunsLeft)}`}
          disabled={starting}
          onClick={() => void runNow()}
        >
          <Play size={13} strokeWidth={2} aria-hidden="true" />
          {starting ? "Starting…" : "Run now"}
        </button>
        <button
          type="button"
          className="button"
          data-testid="routine-pause"
          data-tooltip={
            routine.paused
              ? "Run it on its schedule again"
              : "Stop running it on its schedule until you resume it"
          }
          onClick={() => void actions.setPaused(routine, !routine.paused)}
        >
          {routine.paused ? (
            <Play size={13} strokeWidth={2} aria-hidden="true" />
          ) : (
            <Pause size={13} strokeWidth={2} aria-hidden="true" />
          )}
          {routine.paused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          className="button"
          data-testid="routine-edit"
          data-tooltip={`Open ${routine.path} in the editor`}
          onClick={() => void actions.edit(routine)}
        >
          <FilePen size={13} strokeWidth={1.75} aria-hidden="true" />
          Edit
        </button>
      </div>
      <div className="routines-scroll">
        {notice ? (
          <div className="routines-notice is-alert" role="alert" data-testid="routine-run-problem">
            <div className="routines-notice-text">
              <p className="routines-notice-title">{notice.title}</p>
              <p>{notice.body}</p>
            </div>
            <IconButton
              icon={X}
              label="Dismiss"
              size={14}
              onClick={() => setNotice(null)}
              data-testid="routine-run-problem-dismiss"
            />
          </div>
        ) : null}
        {routine.error ? (
          <div className="routines-notice" data-testid="routine-view-problem">
            <div className="routines-notice-text">
              <p className="routines-notice-title">
                <TriangleAlert size={12} strokeWidth={1.75} aria-hidden="true" /> It can't run
              </p>
              <p>{routine.error}</p>
            </div>
          </div>
        ) : null}
        <dl className="routine-facts" data-testid="routine-facts">
          <div>
            <dt>Next run</dt>
            <dd data-testid="routine-view-next">{next ? capitalize(next) : idleReason(routine)}</dd>
          </div>
          <div>
            <dt>Tells you</dt>
            <dd data-testid="routine-view-notify">{NOTIFY_LABELS[routine.notify]}</dd>
          </div>
          <div>
            <dt>Run now</dt>
            <dd data-testid="routine-view-extra">{extraRunsLabel(routine.extraRunsLeft)}</dd>
          </div>
          {routine.uses.length > 0 ? (
            <div>
              <dt>Uses</dt>
              <dd>{routine.uses.join(", ")}</dd>
            </div>
          ) : null}
        </dl>
        {routine.instructions ? (
          <p className="routine-instructions" data-testid="routine-instructions">
            {routine.instructions}
          </p>
        ) : null}
        <section className="routine-runs" aria-label="Runs">
          <h3 className="inbox-group-title">
            Runs
            <Count value={runs.length} className="inbox-count" hidden={runs.length === 0} />
          </h3>
          {runs.length === 0 ? (
            <p className="routine-runs-empty" data-testid="routine-runs-empty">
              No runs yet. {next ? `It runs ${next}, or run it now.` : "Run it now to try it."}
            </p>
          ) : (
            runs.map((run) => <RunRow key={run.id} run={run} />)
          )}
        </section>
      </div>
    </>
  );
}

const RunRow = memo(function RunRow({ run }: { run: ThreadSummary }) {
  const { agent } = useServices();
  const preview = run.lastMessagePreview?.replace(/[*_`#>]/g, "");
  return (
    <button
      type="button"
      className="inbox-item"
      data-testid="routine-run-item"
      data-thread-id={run.id}
      data-status={run.status}
      onClick={(event) => {
        perfStart("thread:open", event.timeStamp);
        agent.openThread(run.id);
      }}
    >
      <span className="inbox-item-top">
        <span className="inbox-item-title">{capitalize(formatDayTime(run.createdAt))}</span>
        {run.pendingApprovals > 0 ? (
          <span className="routine-run-pending">
            <ShieldAlert size={13} strokeWidth={1.75} aria-hidden="true" />
            {run.pendingApprovals} to approve
          </span>
        ) : null}
      </span>
      {preview ? <span className="inbox-item-preview">{preview}</span> : null}
      <span className="inbox-item-meta">
        <StatusChip status={run.status} />
      </span>
    </button>
  );
});
