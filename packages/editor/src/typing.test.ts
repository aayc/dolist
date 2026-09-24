// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createMarkdownEditor } from "./editor";
import type { MarkdownEditor } from "./types";

const editors: MarkdownEditor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function mount(doc: string): MarkdownEditor {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createMarkdownEditor(parent, { doc });
  editors.push(editor);
  editor.view.dispatch({ selection: { anchor: doc.length } });
  return editor;
}

/** Types like a user: each character goes through the view's input handlers (closeBrackets…). */
function typeText(view: EditorView, text: string): void {
  for (const ch of text) {
    const { from, to } = view.state.selection.main;
    const insert = () =>
      view.state.update({
        changes: { from, to, insert: ch },
        selection: { anchor: from + ch.length },
        userEvent: "input.type",
      });
    const handled = view.state
      .facet(EditorView.inputHandler)
      .some((handler) => handler(view, from, to, ch, insert));
    if (!handled) view.dispatch(insert());
  }
}

describe("typing markdown syntax", () => {
  it("types a task checkbox character by character", () => {
    const editor = mount("");
    typeText(editor.view, "- [ ] Research headphones");
    expect(editor.getDocument()).toBe("- [ ] Research headphones");
  });

  it("types a done checkbox and links", () => {
    const editor = mount("");
    typeText(editor.view, "- [x] see [[Daily/2026-09-24]] and [docs](https://example.com)");
    expect(editor.getDocument()).toBe(
      "- [x] see [[Daily/2026-09-24]] and [docs](https://example.com)",
    );
  });
});
