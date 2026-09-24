import { IS_MAC } from "../lib/platform";
import { reportError } from "../lib/report-error";
import type { CommandRegistry } from "./registry";

/**
 * Global hotkeys, registered in the capture phase so they win over the editor and over browser
 * defaults (e.g. Chrome's ⌘⇧D). Some browser shortcuts (⌘W, ⌘N, ⌘⇧N) cannot be intercepted in a
 * regular tab; they work in the native shells.
 */
export function installGlobalHotkeys(registry: CommandRegistry, isMac = IS_MAC): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    const command = registry.findByEvent(event, isMac);
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    void Promise.resolve(command.run({ event })).catch(reportError);
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
}
