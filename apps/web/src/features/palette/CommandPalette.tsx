import { useMemo, useState } from "react";
import { useServices } from "../../app/services";
import { formatHotkey } from "../../commands/hotkeys";
import type { Command } from "../../commands/registry";
import { Highlight } from "../../components/Highlight";
import { fuzzyFilter } from "../../lib/fuzzy";
import { IS_MAC } from "../../lib/platform";
import { ui } from "../../state/ui-store";
import { PromptList } from "../overlays/PromptList";
import "../../styles/prompt.css";

export function CommandPalette() {
  const { commands } = useServices();
  const [query, setQuery] = useState("");
  const available = useMemo(
    () => commands.list().sort((a, b) => a.name.localeCompare(b.name)),
    [commands],
  );
  const results = useMemo(
    () =>
      query.trim()
        ? fuzzyFilter(query, available, (c) => c.name, 100)
        : available.map((item) => ({ item, score: 0, indices: [] as number[] })),
    [query, available],
  );

  const run = (command: Command) => {
    ui.closeOverlay();
    commands.run(command.id);
  };

  return (
    <PromptList
      label="Command palette"
      placeholder="Type a command…"
      query={query}
      onQueryChange={setQuery}
      testId="palette"
      empty="No matching commands"
      items={results.map(({ item, indices }) => ({
        key: item.id,
        render: () => (
          <>
            <span className="prompt-item-title">
              <Highlight text={item.name} indices={indices} />
            </span>
            {item.hotkeys?.[0] ? (
              <kbd className="prompt-item-hotkey">{formatHotkey(item.hotkeys[0], IS_MAC)}</kbd>
            ) : null}
          </>
        ),
      }))}
      onChoose={(index) => {
        const result = results[index];
        if (result) run(result.item);
      }}
      footer={
        <>
          <span>
            <kbd>↑↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> run
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </>
      }
    />
  );
}
