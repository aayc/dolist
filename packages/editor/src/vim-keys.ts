/**
 * The Ctrl keys vim owns outside insert mode, for the app's shortcut policy (`vimClaimsKey`).
 * Lists vim.js's default normal/visual bindings (a unit test checks it against the engine's
 * keymap) plus the Ctrl keys a mapping has been created for.
 */

export const DEFAULT_VIM_CTRL_KEYS: ReadonlySet<string> = new Set([
  "<C-Space>",
  "<C-BS>",
  "<C-n>",
  "<C-p>",
  "<C-[>",
  "<C-c>",
  "<C-Esc>",
  "<C-f>",
  "<C-b>",
  "<C-d>",
  "<C-u>",
  "<C-w>",
  "<C-i>",
  "<C-o>",
  "<C-e>",
  "<C-y>",
  "<C-v>",
  "<C-q>",
  "<C-r>",
  "<C-a>",
  "<C-x>",
]);

const mappedCtrlKeys = new Set<string>();

/** The Ctrl keys (`<C-…>`, lowercase letter) a mapping's left-hand side starts with. */
export function ctrlKeysOf(lhs: string): string[] {
  const match = /^<C-(?:S-)?([^>]+)>/i.exec(lhs);
  if (!match) return [];
  const key = match[1]!;
  return [`<C-${key.length === 1 ? key.toLowerCase() : key}>`];
}

export function noteMapping(lhs: string, context: string | undefined): void {
  if (context === "insert") return;
  for (const key of ctrlKeysOf(lhs)) mappedCtrlKeys.add(key);
}

export function forgetMappings(): void {
  mappedCtrlKeys.clear();
}

export function isVimCtrlKey(key: string): boolean {
  const normalized = /^<C-.>$/.test(key) ? `<C-${key.charAt(3).toLowerCase()}>` : key;
  return DEFAULT_VIM_CTRL_KEYS.has(normalized) || mappedCtrlKeys.has(normalized);
}
