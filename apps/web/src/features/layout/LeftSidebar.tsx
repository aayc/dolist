import { Suspense, useRef } from "react";
import { SearchView } from "../../app/lazy";
import { LEFT_WIDTH, ui, useUiStore } from "../../state/ui-store";
import { FileExplorer } from "../explorer/FileExplorer";
import { PanelFallback } from "./PanelFallback";
import { ResizeHandle } from "./ResizeHandle";

export function LeftSidebar() {
  const open = useUiStore((s) => s.leftOpen);
  const width = useUiStore((s) => s.leftWidth);
  const view = useUiStore((s) => s.leftView);
  const ref = useRef<HTMLElement>(null);
  if (!open) return null;
  return (
    <aside ref={ref} className="sidebar sidebar-left" style={{ width }} data-testid="left-sidebar">
      {view === "files" ? (
        <FileExplorer />
      ) : (
        <Suspense fallback={<PanelFallback />}>
          <SearchView />
        </Suspense>
      )}
      <ResizeHandle
        side="left"
        target={ref}
        value={width}
        min={LEFT_WIDTH.min}
        max={LEFT_WIDTH.max}
        onCommit={(leftWidth) => ui.set({ leftWidth })}
      />
    </aside>
  );
}
