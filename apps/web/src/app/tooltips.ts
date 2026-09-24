import { useEffect } from "react";
import { hotkeyKeys, KEYS, type KeyName } from "../commands/hotkeys";
import { shortcutOf } from "../commands/labels";
import type { CommandRegistry } from "../commands/registry";
import { IS_MAC } from "../lib/platform";
import { installTooltips } from "../lib/tooltips";
import { useServices } from "./services";

/** The keycaps of a command's shortcut, as the tooltips of its controls show them. */
export function shortcutKeys(registry: CommandRegistry, id: string): string[] | null {
  const hotkey = shortcutOf(registry.get(id));
  return hotkey ? hotkeyKeys(hotkey, IS_MAC) : null;
}

/** Runs the tooltip layer while the app is mounted; keycaps come from the command registry. */
export function useTooltips(): void {
  const { commands } = useServices();
  useEffect(
    () =>
      installTooltips({
        command: (id) => shortcutKeys(commands, id),
        named: (name) =>
          Object.hasOwn(KEYS, name) ? hotkeyKeys(KEYS[name as KeyName], IS_MAC) : null,
      }),
    [commands],
  );
}
