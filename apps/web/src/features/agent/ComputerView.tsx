import { Monitor } from "lucide-react";
import { cx } from "../../lib/cx";
import { formatTimestamp } from "../../lib/format";
import { type SurfaceAction, surfaceKey, useSurfaceStore } from "../../state/surface-store";
import { ActionMarker, frameSrc } from "./BrowserView";
import { useIsLive, useSurfaceSubscription } from "./use-surface";

const NO_ACTIONS: readonly SurfaceAction[] = [];
const MARKERS = 5;

/** Consecutive duplicates are dropped by the store, so frame time + action identify an entry. */
function actionKey(action: SurfaceAction): string {
  return `${action.ts}:${action.kind}:${action.x ?? ""}:${action.y ?? ""}:${action.text ?? ""}`;
}

function describe(action: SurfaceAction): string {
  const where =
    action.x !== undefined && action.y !== undefined ? ` at ${action.x}, ${action.y}` : "";
  return `${action.kind}${action.text ? ` “${action.text}”` : ""}${where}`;
}

export function ComputerView({ threadId }: { threadId: string }) {
  useSurfaceSubscription(threadId, "computer");
  const key = surfaceKey(threadId, "computer");
  const frame = useSurfaceStore((s) => s.frames[key]);
  const actions = useSurfaceStore((s) => s.actions[key] ?? NO_ACTIONS);
  const live = useIsLive(frame?.ts);
  const clicks = actions.filter((a) => a.x !== undefined && a.y !== undefined).slice(-MARKERS);

  return (
    <div className="surface-view" data-testid="computer-view">
      <div className="browser-bar">
        <span className={cx("live-dot", live && "is-live")} title={live ? "Live" : "Idle"} />
        <Monitor size={13} aria-hidden="true" />
        <span className="browser-url">Computer use</span>
      </div>
      <div className="surface-stage">
        {frame ? (
          <div className="surface-frame">
            <img
              src={frameSrc(frame)}
              alt="Latest screenshot"
              width={frame.width}
              height={frame.height}
              draggable={false}
              data-testid="computer-frame"
            />
            {clicks.map((click, index) => (
              <ActionMarker
                key={actionKey(click)}
                x={click.x!}
                y={click.y!}
                frame={frame}
                fade={(index + 1) / clicks.length}
                label={index === clicks.length - 1 ? click.kind : undefined}
              />
            ))}
          </div>
        ) : (
          <div className="surface-empty">No screenshots yet.</div>
        )}
      </div>
      <ol className="action-log" aria-label="Action log" data-testid="action-log">
        {[...actions].reverse().map((action) => (
          <li key={actionKey(action)}>
            <time>{formatTimestamp(action.ts)}</time>
            <span>{describe(action)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
