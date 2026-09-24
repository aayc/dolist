/** List editing: Enter continues lists and tasks, Tab indents list items. */
import { indentMore, insertTab } from "@codemirror/commands";
import { insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, StateCommand } from "@codemirror/state";
import { isListLine } from "../task-lines";
import { selectedLines } from "./tasks";

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

/**
 * Enter: continue lists/tasks/quotes (Enter on a task line starts `- [ ] `). An empty item ends
 * the list, like Obsidian, instead of turning a tight list into a loose one.
 */
export const continueMarkup: StateCommand = insertNewlineContinueMarkupCommand({
  nonTightLists: false,
});

const LIST_ITEM_PREFIX = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)(\[.\][ \t]+)?/;

function inListItem(state: EditorState, pos: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  for (; node; node = node.parent) {
    if (node.name === "FencedCode") return false;
    if (node.name === "ListItem") return true;
  }
  return false;
}

/**
 * Enter fallback for list items `continueMarkup` doesn't recognize — notably top-level items
 * indented with a tab. Continues the item (tasks get a fresh `[ ] `) or, on an empty item, removes
 * its markup.
 */
export const continueListItem: StateCommand = ({ state, dispatch }) => {
  const { main } = state.selection;
  if (state.readOnly || state.selection.ranges.length > 1 || !main.empty) return false;
  const line = state.doc.lineAt(main.head);
  const match = LIST_ITEM_PREFIX.exec(line.text);
  if (!match || main.head < line.from + match[0].length || !inListItem(state, main.head)) {
    return false;
  }
  const [prefix, indent = "", bullet, number, delimiter = ".", space = " ", box] = match;
  if (line.text.slice(prefix.length).trim() === "") {
    dispatch(
      state.update({
        changes: { from: line.from, to: line.to },
        selection: { anchor: line.from },
        userEvent: "input",
        scrollIntoView: true,
      }),
    );
    return true;
  }
  const marker = bullet ?? `${Number(number) + 1}${delimiter}`;
  const insert = `${state.lineBreak}${indent}${marker}${space}${box ? "[ ] " : ""}`;
  let from = main.head;
  while (from > line.from + prefix.length && /\s/.test(line.text[from - line.from - 1] ?? "")) {
    from--;
  }
  dispatch(
    state.update({
      changes: { from, to: main.head, insert },
      selection: { anchor: from + insert.length },
      userEvent: "input",
      scrollIntoView: true,
    }),
  );
  return true;
};

const ALTERNATE_BULLET_TASK = /^[ \t]*[-*+][ \t]+\[[^ xX]\][ \t]/;

/**
 * Enter on a bullet task with an Obsidian status other than `[ ]`/`[x]` (`[/]`, `[-]`, `[>]`, …):
 * `continueMarkup` only knows GFM boxes and would continue with a plain bullet.
 */
export const continueAlternateTask: StateCommand = (target) => {
  const { state } = target;
  const line = state.doc.lineAt(state.selection.main.head);
  return ALTERNATE_BULLET_TASK.test(line.text) && continueListItem(target);
};

/** Tab: indent list items (like Obsidian), otherwise insert a tab / indent the selection. */
export const indentListItemOrInsertTab: StateCommand = (target) => {
  if (target.state.readOnly) return false;
  if (selectedLines(target.state).some((line) => isListLine(line.text))) return indentMore(target);
  return insertTab(target);
};
