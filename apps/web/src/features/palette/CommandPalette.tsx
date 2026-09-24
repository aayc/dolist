import { useMemo, useState } from "react";
import { useServices } from "../../app/services";
import { KEYS } from "../../commands/hotkeys";
import { shortcutOf } from "../../commands/labels";
import type { Command } from "../../commands/registry";
import { Highlight } from "../../components/Highlight";
import { Keycaps } from "../../components/Keycaps";
import { fuzzyFilter } from "../../lib/fuzzy";
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
            <Keycaps hotkey={shortcutOf(item)} />
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
            <Keycaps hotkey={[KEYS.up, KEYS.down]} /> navigate
          </span>
          <span>
            <Keycaps hotkey={KEYS.enter} /> run
          </span>
          <span>
            <Keycaps hotkey={KEYS.escape} /> close
          </span>
        </>
      }
    />
  );
}
