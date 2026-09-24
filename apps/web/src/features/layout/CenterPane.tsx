import { useTabsStore } from "../../state/tabs-store";
import { EditorHost } from "../editor/EditorHost";
import { NoteHeader } from "../tabs/NoteHeader";
import { TabBar } from "../tabs/TabBar";
import { EmptyState } from "./EmptyState";

export function CenterPane() {
  const hasNote = useTabsStore((s) => s.active !== null);
  return (
    <main className="center" data-testid="center">
      <TabBar />
      {/* The editor stays mounted (one instance for the app's lifetime); it is only hidden. */}
      <div className="note-view" hidden={!hasNote}>
        <NoteHeader />
        <EditorHost />
      </div>
      {hasNote ? null : <EmptyState />}
    </main>
  );
}
