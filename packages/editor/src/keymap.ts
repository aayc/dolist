import { closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, historyKeymap, indentLess } from "@codemirror/commands";
import { deleteMarkupBackward } from "@codemirror/lang-markdown";
import { searchKeymap } from "@codemirror/search";
import { type Extension, Prec } from "@codemirror/state";
import { type KeyBinding, keymap } from "@codemirror/view";
import { saveDocument } from "./callbacks";
import { insertLink, toggleBold, toggleItalic } from "./commands/formatting";
import {
  continueAlternateTask,
  continueListItem,
  continueMarkup,
  indentListItemOrInsertTab,
} from "./commands/lists";
import { toggleChecklist } from "./commands/tasks";
import { followLinkAtCursor } from "./links";

/** List/task continuation on Enter, markup-aware Backspace, list indentation with Tab. */
export const markdownEditingKeymap: readonly KeyBinding[] = [
  { key: "Enter", run: continueAlternateTask },
  { key: "Enter", run: continueMarkup },
  { key: "Enter", run: continueListItem },
  { key: "Backspace", run: deleteMarkupBackward },
  { key: "Tab", run: indentListItemOrInsertTab, shift: indentLess },
];

/** Obsidian's default hotkeys. Mod-e is deliberately unbound (the host toggles reading view). */
export const obsidianKeymap: readonly KeyBinding[] = [
  { key: "Mod-b", run: toggleBold },
  { key: "Mod-i", run: toggleItalic },
  { key: "Mod-k", run: insertLink },
  { key: "Mod-l", run: toggleChecklist },
  { key: "Mod-Enter", run: toggleChecklist },
  { key: "Mod-s", run: saveDocument, preventDefault: true },
  { key: "Alt-Enter", run: followLinkAtCursor },
];

export const editorKeymap: Extension = [
  // Above the defaults, which bind Enter, Backspace, Mod-i and Mod-Enter to generic commands.
  Prec.high(keymap.of([...markdownEditingKeymap, ...obsidianKeymap])),
  keymap.of([...closeBracketsKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap]),
];
