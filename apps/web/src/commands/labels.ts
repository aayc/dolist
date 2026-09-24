import { IN_BROWSER_TAB, IS_MAC } from "../lib/platform";
import { ariaKeyShortcuts, type Hotkey } from "./hotkeys";
import type { Command, CommandRegistry } from "./registry";

/** ⌘N, ⌘T, ⌘W (with or without ⇧) never reach a page in a regular browser tab. */
function browserKeeps(hotkey: Hotkey): boolean {
  return Boolean(hotkey.mod && !hotkey.alt && !hotkey.ctrl) && /^[ntw]$/.test(hotkey.key);
}

/** The shortcut to show for a command: its first hotkey that can work where the app runs. */
export function shortcutOf(
  command: Command | undefined,
  inBrowserTab = IN_BROWSER_TAB,
): Hotkey | null {
  return command?.hotkeys?.find((h) => !(inBrowserTab && browserKeeps(h))) ?? null;
}

/** A control's name for a command: its label, else its palette name. */
export function commandLabel(registry: CommandRegistry, id: string): string {
  const command = registry.get(id);
  return command?.label ?? command?.name ?? id;
}

/**
 * Tooltip attributes for a control that runs a command: its name (the command's label unless
 * `text` is given), the command whose shortcut the tooltip shows, and `aria-keyshortcuts`.
 */
export function commandTooltip(
  registry: CommandRegistry,
  id: string,
  text = commandLabel(registry, id),
): { "data-tooltip": string; "data-command": string; "aria-keyshortcuts"?: string } {
  const hotkey = shortcutOf(registry.get(id));
  return {
    "data-tooltip": text,
    "data-command": id,
    ...(hotkey ? { "aria-keyshortcuts": ariaKeyShortcuts(hotkey, IS_MAC) } : {}),
  };
}
