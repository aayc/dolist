import type { SurfaceFrame } from "@ddl/core";
import { Globe } from "lucide-react";
import { cx } from "../../lib/cx";
import { surfaceKey, useSurfaceStore } from "../../state/surface-store";
import { useIsLive, useSurfaceSubscription } from "./use-surface";

export function frameSrc(frame: SurfaceFrame): string {
  return `data:${frame.mimeType};base64,${frame.data}`;
}

export function ActionMarker({
  x,
  y,
  frame,
  label,
  fade = 1,
}: {
  x: number;
  y: number;
  frame: SurfaceFrame;
  label?: string;
  fade?: number;
}) {
  return (
    <span
      className="action-marker"
      style={{
        left: `${(x / frame.width) * 100}%`,
        top: `${(y / frame.height) * 100}%`,
        opacity: fade,
      }}
      data-testid="action-marker"
    >
      {label ? <span className="action-marker-label">{label}</span> : null}
    </span>
  );
}

export function BrowserView({ threadId }: { threadId: string }) {
  useSurfaceSubscription(threadId, "browser");
  const frame = useSurfaceStore((s) => s.frames[surfaceKey(threadId, "browser")]);
  const live = useIsLive(frame?.ts);
  const action = frame?.action;

  return (
    <div className="surface-view" data-testid="browser-view">
      <div className="browser-bar">
        <span className={cx("live-dot", live && "is-live")} title={live ? "Live" : "Idle"} />
        <Globe size={13} aria-hidden="true" />
        <span className="browser-url" title={frame?.url} data-testid="browser-url">
          {frame?.url ?? "Waiting for the browser…"}
        </span>
      </div>
      {frame?.title ? <div className="browser-title">{frame.title}</div> : null}
      <div className="surface-stage">
        {frame ? (
          <div className="surface-frame">
            <img
              src={frameSrc(frame)}
              alt={frame.title ?? "Browser screenshot"}
              width={frame.width}
              height={frame.height}
              draggable={false}
              data-testid="browser-frame"
            />
            {action && action.x !== undefined && action.y !== undefined ? (
              <ActionMarker
                x={action.x}
                y={action.y}
                frame={frame}
                label={action.text ?? action.kind}
              />
            ) : null}
          </div>
        ) : (
          <div className="surface-empty">
            No frames yet — they stream here while the agent browses.
          </div>
        )}
      </div>
    </div>
  );
}
