const KEY_ALIASES: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  spacebar: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  up: "ArrowUp",
  arrowup: "ArrowUp",
  down: "ArrowDown",
  arrowdown: "ArrowDown",
  left: "ArrowLeft",
  arrowleft: "ArrowLeft",
  right: "ArrowRight",
  arrowright: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  ctrl: "Control",
  control: "Control",
  cmd: "Meta",
  command: "Meta",
  meta: "Meta",
  super: "Meta",
  win: "Meta",
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  shift: "Shift",
  mod: "ControlOrMeta",
  controlormeta: "ControlOrMeta",
};

/**
 * Normalizes model-written key names to Playwright's (`ctrl+a` → `Control+a`, `down` → `ArrowDown`,
 * `cmd+shift+t` → `Meta+Shift+t`). Unknown names pass through so Playwright can reject them.
 */
export function normalizeBrowserKey(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Key is empty.");
  if (trimmed === "+") return "+";
  const parts = trimmed.endsWith("++")
    ? [...trimmed.slice(0, -2).split("+"), "+"]
    : trimmed.split("+");
  return parts
    .map((part) => part.trim())
    .map((part) => {
      if (part.length === 1) return part;
      const lower = part.toLowerCase();
      const alias = KEY_ALIASES[lower];
      if (alias) return alias;
      if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase();
      return part;
    })
    .join("+");
}
