import { type Hotkey, hotkeyKeys } from "../commands/hotkeys";
import { IS_MAC } from "../lib/platform";

/** A shortcut as one keycap per key, the same caps tooltips draw (`renderKeycaps`). */
export function Keycaps({ hotkey }: { hotkey: Hotkey | Hotkey[] | null }) {
  if (!hotkey) return null;
  const keys = (Array.isArray(hotkey) ? hotkey : [hotkey]).flatMap((h) => hotkeyKeys(h, IS_MAC));
  return (
    <span className="keycaps">
      {keys.map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </span>
  );
}
