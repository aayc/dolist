import { dirname } from "@ddl/core";
import { useMemo, useState } from "react";
import { useServices } from "../../app/services";
import { Highlight } from "../../components/Highlight";
import { fuzzyMatch } from "../../lib/fuzzy";
import { IS_MAC } from "../../lib/platform";
import { useTabsStore } from "../../state/tabs-store";
import { ui } from "../../state/ui-store";
import { useVaultStore } from "../../state/vault-store";
import { displayName } from "../explorer/tree";
import { PromptList } from "../overlays/PromptList";
import "../../styles/prompt.css";

interface Ranked {
  path: string;
  name: string;
  folder: string;
  score: number;
  nameIndices: number[];
}

const MAX_RESULTS = 50;

export function rankNotes(query: string, files: readonly string[], limit = MAX_RESULTS): Ranked[] {
  const out: Ranked[] = [];
  for (const path of files) {
    const name = displayName(path, "file");
    const folder = dirname(path);
    const byName = fuzzyMatch(query, name);
    if (byName) {
      out.push({ path, name, folder, score: byName.score + 4, nameIndices: byName.indices });
      continue;
    }
    const byPath = fuzzyMatch(query, path.replace(/\.md$/i, ""));
    if (byPath) out.push({ path, name, folder, score: byPath.score, nameIndices: [] });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return out.slice(0, limit);
}

export function QuickSwitcher() {
  const { workspace } = useServices();
  const files = useVaultStore((s) => s.files);
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    if (query.trim()) return rankNotes(query, files);
    const open = new Set(useTabsStore.getState().tabs);
    return [...files]
      .sort((a, b) => Number(open.has(b)) - Number(open.has(a)) || b.localeCompare(a))
      .slice(0, MAX_RESULTS)
      .map((path) => ({
        path,
        name: displayName(path, "file"),
        folder: dirname(path),
        score: 0,
        nameIndices: [],
      }));
  }, [query, files]);

  const create = () => {
    const name = query.trim();
    if (!name) return;
    ui.closeOverlay();
    void workspace.createNote({ name });
  };

  const mod = IS_MAC ? "⌘" : "Ctrl+";
  return (
    <PromptList
      label="Quick switcher"
      placeholder="Find or create a note…"
      query={query}
      onQueryChange={setQuery}
      testId="switcher"
      empty={
        query.trim() ? (
          <>
            No notes found. Press <kbd>{mod}↵</kbd> to create “{query.trim()}”.
          </>
        ) : (
          "No notes yet"
        )
      }
      items={results.map((result) => ({
        key: result.path,
        render: () => (
          <>
            <span className="prompt-item-title">
              <Highlight text={result.name} indices={result.nameIndices} />
            </span>
            {result.folder ? <span className="prompt-item-meta">{result.folder}</span> : null}
          </>
        ),
      }))}
      onChoose={(index, event) => {
        const result = results[index];
        if (!result) return;
        ui.closeOverlay();
        void workspace.openNote(result.path, {
          newTab: event.shiftKey || event.metaKey || event.ctrlKey,
        });
      }}
      onModEnter={create}
      footer={
        <>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>⇧↵</kbd> new tab
          </span>
          <span>
            <kbd>{mod}↵</kbd> create
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </>
      }
    />
  );
}
