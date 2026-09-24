import { Suspense, useRef } from "react";
import { AgentPanel } from "../../app/lazy";
import { RIGHT_WIDTH, ui, useUiStore } from "../../state/ui-store";
import { PanelFallback } from "./PanelFallback";
import { ResizeHandle } from "./ResizeHandle";

export function RightSidebar() {
  const open = useUiStore((s) => s.rightOpen);
  const width = useUiStore((s) => s.rightWidth);
  const ref = useRef<HTMLElement>(null);
  if (!open) return null;
  return (
    <aside
      ref={ref}
      className="sidebar sidebar-right"
      style={{ width }}
      aria-label="Agent panel"
      data-testid="right-panel"
    >
      <ResizeHandle
        side="right"
        target={ref}
        value={width}
        min={RIGHT_WIDTH.min}
        max={RIGHT_WIDTH.max}
        onCommit={(rightWidth) => ui.set({ rightWidth })}
      />
      <Suspense fallback={<PanelFallback />}>
        <AgentPanel />
      </Suspense>
    </aside>
  );
}
