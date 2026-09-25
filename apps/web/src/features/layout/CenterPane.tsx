import { isDrawingPath } from "@ddl/core";
import { Suspense } from "react";
import { DrawingPane } from "../../app/lazy";
import { useTabsStore } from "../../state/tabs-store";
import { EditorHost } from "../editor/EditorHost";
import { NoteHeader } from "../tabs/NoteHeader";
import { TabBar } from "../tabs/TabBar";
import { EmptyState } from "./EmptyState";

export function CenterPane() {
  const hasNote = useTabsStore((s) => s.active !== null);
  // Only a drawing's path: switching between notes doesn't re-render the pane.
  const drawing = useTabsStore((s) =>
    s.active !== null && isDrawingPath(s.active) ? s.active : null,
  );
  return (
    <main className="center" data-testid="center">
      <TabBar />
      {/* The editor stays mounted (one instance for the app's lifetime); it is only hidden. */}
      <div className="note-view" hidden={!hasNote}>
        <NoteHeader />
        <EditorHost hidden={drawing !== null} />
        {drawing ? (
          <Suspense fallback={null}>
            <DrawingPane key={drawing} path={drawing} />
          </Suspense>
        ) : null}
      </div>
      {hasNote ? null : <EmptyState />}
    </main>
  );
}
