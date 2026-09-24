import { IS_MAC } from "../lib/platform";
import { formatHotkey } from "./hotkeys";
import type { CommandRegistry } from "./registry";

export function hotkeyLabel(registry: CommandRegistry, commandId: string): string | null {
  const hotkey = registry.get(commandId)?.hotkeys?.[0];
  return hotkey ? formatHotkey(hotkey, IS_MAC) : null;
}
