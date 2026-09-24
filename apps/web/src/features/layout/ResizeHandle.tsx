import { type RefObject, useRef } from "react";

interface ResizeHandleProps {
  /** Which sidebar this handle resizes; the handle sits on its inner edge. */
  side: "left" | "right";
  target: RefObject<HTMLElement | null>;
  value: number;
  min: number;
  max: number;
  onCommit(width: number): void;
}

/**
 * Drag-to-resize. The width is written straight to the element while dragging (no React renders)
 * and committed to the store on release.
 */
export function ResizeHandle({ side, target, value, min, max, onCommit }: ResizeHandleProps) {
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);

  const clamp = (width: number) => Math.min(max, Math.max(min, Math.round(width)));

  return (
    // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA window splitter; an <hr> can't take focus or pointer drags
    <div
      className={`resize-handle resize-handle-${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${side} sidebar`}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(event) => {
        const el = target.current;
        if (!el || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const width = el.getBoundingClientRect().width;
        drag.current = { startX: event.clientX, startWidth: width, width };
        document.body.classList.add("is-resizing");
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        const el = target.current;
        if (!state || !el) return;
        const delta = event.clientX - state.startX;
        state.width = clamp(side === "left" ? state.startWidth + delta : state.startWidth - delta);
        el.style.width = `${state.width}px`;
      }}
      onPointerUp={(event) => {
        const state = drag.current;
        drag.current = null;
        document.body.classList.remove("is-resizing");
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (state) onCommit(state.width);
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const step = event.key === "ArrowLeft" ? -16 : 16;
        const width = clamp(value + (side === "left" ? step : -step));
        if (target.current) target.current.style.width = `${width}px`;
        onCommit(width);
      }}
    />
  );
}
