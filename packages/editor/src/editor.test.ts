// @vitest-environment happy-dom
import { undo, undoDepth } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { runScopeHandlers } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getAnnotations } from "./annotations/field";
import { createMarkdownEditor } from "./editor";
import type { CreateEditorOptions, EditorCallbacks, LineAnnotation, MarkdownEditor } from "./types";
import { preloadVim } from "./vim";

beforeAll(() => preloadVim());

/** The adapter type vim's API expects once vim state exists (always true after `vimMode: true`). */
type VimAdapter = Parameters<typeof Vim.handleEx>[0];

function vimAdapter(editor: MarkdownEditor): VimAdapter {
  const cm = getCM(editor.view);
  if (!cm) throw new Error("vim mode is not enabled");
  return cm as VimAdapter;
}

const editors: MarkdownEditor[] = [];

function mount(options: Partial<CreateEditorOptions> = {}): MarkdownEditor {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createMarkdownEditor(parent, { doc: "", ...options });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = "";
});

function annotation(id: string, line: number): LineAnnotation {
  return { id, line, status: "working", label: "Researching…", unread: 2, threadId: `t-${id}` };
}

function mousedown(el: Element, init: MouseEventInit = {}): void {
  el.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }),
  );
}

const DOC = "# Today\n- [ ] book flights\n- [ ] email Sam";

describe("createMarkdownEditor", () => {
  it("mounts with the configured classes and document", () => {
    const editor = mount({ doc: DOC, config: { fontSize: 20 } });
    expect(editor.getDocument()).toBe(DOC);
    const root = editor.view.dom;
    expect(root.classList).toContain("cm-ddl-editor");
    expect(root.classList).toContain("cm-ddl-live-preview");
    expect(root.classList).toContain("cm-ddl-readable");
    expect(root.getAttribute("style")).toContain("--ddl-editor-font-size: 20px");
  });

  it("reports user edits and external edits to onDocChange", () => {
    const onDocChange = vi.fn();
    const editor = mount({ doc: "a", callbacks: { onDocChange } });
    editor.view.dispatch({ changes: { from: 1, insert: "b" }, userEvent: "input.type" });
    editor.setDocument("abc");
    expect(onDocChange.mock.calls).toEqual([
      ["ab", { userEvent: true }],
      ["abc", { userEvent: false }],
    ]);
  });

  it("reports cursor line changes once per line", () => {
    const onCursorLine = vi.fn();
    const editor = mount({ doc: DOC, callbacks: { onCursorLine } });
    editor.view.dispatch({ selection: { anchor: 10 } });
    editor.view.dispatch({ selection: { anchor: 12 } });
    editor.scrollToLine(2);
    expect(onCursorLine.mock.calls).toEqual([[1], [2]]);
  });
});

describe("setDocument", () => {
  it("applies external edits minimally, keeping the selection and badges", () => {
    const editor = mount({ doc: DOC });
    const cursor = DOC.indexOf("Sam");
    editor.view.dispatch({ selection: { anchor: cursor } });
    editor.setAnnotations([annotation("a", 1), annotation("b", 2)]);

    editor.setDocument("# Today\n- [ ] new task\n- [ ] book flights\n- [ ] email Sam");

    const { state } = editor.view;
    expect(state.sliceDoc(state.selection.main.head, state.selection.main.head + 3)).toBe("Sam");
    expect(getAnnotations(state).map((a) => [a.id, a.line])).toEqual([
      ["a", 2],
      ["b", 3],
    ]);
    // External changes are not part of the local undo history.
    undo(editor.view);
    expect(editor.getDocument()).toContain("new task");
  });

  it("keeps a caret at a line start on its line when remote lines are inserted above it", () => {
    // The caret waits on the empty line after Enter; another device adds a task above it.
    const editor = mount({ doc: "- [ ] A\n" });
    editor.view.dispatch({ selection: { anchor: 8 } });
    editor.setDocument("- [ ] A\n- [ ] remote\n");
    expect(editor.view.state.selection.main.head).toBe(editor.getDocument().length);
    editor.view.dispatch(editor.view.state.replaceSelection("typed"));
    expect(editor.getDocument()).toBe("- [ ] A\n- [ ] remote\ntyped");

    // A selection that ends at that line start doesn't grow over the inserted lines.
    editor.setDocument("one\ntwo\n", { resetHistory: true });
    editor.view.dispatch({ selection: { anchor: 0, head: 4 } });
    editor.setDocument("one\nnew\ntwo\n");
    const { from, to } = editor.view.state.selection.main;
    expect(editor.view.state.sliceDoc(from, to)).toBe("one\n");
  });

  it("normalizes line endings and ignores no-op updates", () => {
    const onDocChange = vi.fn();
    const editor = mount({ doc: "a\nb", callbacks: { onDocChange } });
    editor.setDocument("a\r\nb");
    expect(onDocChange).not.toHaveBeenCalled();
  });

  it("starts fresh with resetHistory", () => {
    const editor = mount({ doc: "one" });
    editor.view.dispatch({ changes: { from: 3, insert: " two" }, userEvent: "input.type" });
    editor.setAnnotations([annotation("a", 0)]);
    editor.setDocument("- [ ] other note", { resetHistory: true });
    expect(editor.getDocument()).toBe("- [ ] other note");
    expect(undoDepth(editor.view.state)).toBe(0);
    expect(getAnnotations(editor.view.state)).toEqual([]);
  });
});

describe("setState", () => {
  it("re-applies the current config to a cached state and clears its badges", () => {
    const editor = mount({ doc: DOC });
    editor.setAnnotations([annotation("a", 1)]);
    const cached = editor.getState();
    editor.setState(editor.createState("other"));
    editor.configure({ readOnly: true, livePreview: false, readableLineLength: false });

    editor.setState(cached);

    const { view } = editor;
    expect(editor.getDocument()).toBe(DOC);
    expect(view.state.readOnly).toBe(true);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
    expect(view.dom.classList).not.toContain("cm-ddl-live-preview");
    expect(view.dom.classList).not.toContain("cm-ddl-readable");
    expect(getAnnotations(view.state)).toEqual([]);
  });

  it("keeps per-note undo history", () => {
    const editor = mount({ doc: "note A" });
    editor.view.dispatch({ changes: { from: 6, insert: "!" }, userEvent: "input.type" });
    const noteA = editor.getState();
    editor.setState(editor.createState("note B"));
    editor.setState(noteA);
    undo(editor.view);
    expect(editor.getDocument()).toBe("note A");
  });

  it("adopts foreign states and routes callbacks to the editor showing the state", () => {
    const first = vi.fn();
    const second = vi.fn();
    const editorA = mount({ doc: "a", callbacks: { onDocChange: first } });
    const editorB = mount({ doc: "b", callbacks: { onDocChange: second } });

    editorB.setState(editorA.createState("from A"));
    editorB.view.dispatch({ changes: { from: 0, insert: ">" }, userEvent: "input.type" });
    expect(second).toHaveBeenCalledWith(">from A", { userEvent: true });
    expect(first).not.toHaveBeenCalled();

    editorB.setState(EditorState.create({ doc: "plain state" }));
    editorB.setAnnotations([annotation("x", 0)]);
    expect(getAnnotations(editorB.view.state)).toHaveLength(1);
  });
});

describe("widgets", () => {
  it("toggles tasks from the checkbox unless read-only", () => {
    const editor = mount({ doc: "- [ ] task" });
    const checkbox = () => editor.view.dom.querySelector(".cm-ddl-checkbox");
    const box = checkbox();
    expect(box?.getAttribute("role")).toBe("checkbox");
    expect(box?.getAttribute("aria-checked")).toBe("false");
    if (box) mousedown(box);
    expect(editor.getDocument()).toBe("- [x] task");
    expect(checkbox()?.getAttribute("aria-checked")).toBe("true");

    editor.configure({ readOnly: true });
    const readOnlyBox = checkbox();
    expect(readOnlyBox?.getAttribute("aria-disabled")).toBe("true");
    if (readOnlyBox) mousedown(readOnlyBox);
    expect(editor.getDocument()).toBe("- [x] task");
  });

  it("opens the agent thread from a badge by click or keyboard", () => {
    const onAnnotationClick = vi.fn();
    const editor = mount({ doc: DOC, callbacks: { onAnnotationClick } });
    editor.setAnnotations([annotation("a", 1)]);
    const badge = editor.view.dom.querySelector<HTMLElement>(".cm-ddl-badge");
    expect(badge?.getAttribute("role")).toBe("button");
    expect(badge?.getAttribute("aria-label")).toBe(
      "Agent is working: Researching…, 2 unread. Open agent thread",
    );
    expect(badge?.title).toBe("Researching… (2 unread)");
    expect(badge?.querySelector<HTMLElement>(".cm-ddl-badge-unread")?.hidden).toBe(false);
    badge?.click();
    badge?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onAnnotationClick).toHaveBeenCalledTimes(2);
    expect(onAnnotationClick).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("updates a badge in place when its status changes", () => {
    const onAnnotationClick = vi.fn();
    const editor = mount({ doc: DOC, callbacks: { onAnnotationClick } });
    editor.setAnnotations([annotation("a", 1)]);
    const badge = editor.view.dom.querySelector<HTMLElement>(".cm-ddl-badge");
    editor.setAnnotations([{ ...annotation("a", 1), status: "done", label: "Done", unread: 0 }]);
    const updated = editor.view.dom.querySelector<HTMLElement>(".cm-ddl-badge");
    expect(updated).toBe(badge);
    expect(updated?.className).toBe("cm-ddl-badge cm-ddl-badge-done cm-ddl-badge-tone-quiet");
    expect(updated?.title).toBe("Done");
    expect(updated?.querySelector<HTMLElement>(".cm-ddl-badge-unread")?.hidden).toBe(true);
    updated?.click();
    expect(onAnnotationClick).toHaveBeenCalledWith(expect.objectContaining({ status: "done" }));
  });

  it("keeps a badge's DOM while typing on its line and when its unread count changes", () => {
    const editor = mount({ doc: DOC });
    editor.setAnnotations([annotation("a", 1)]);
    const badge = editor.view.dom.querySelector<HTMLElement>(".cm-ddl-badge");
    const line = editor.view.state.doc.line(2);
    for (const [i, ch] of [..." today"].entries()) {
      editor.view.dispatch({ changes: { from: line.to + i, insert: ch }, userEvent: "input.type" });
    }
    editor.view.dispatch({ changes: { from: line.from + 6, insert: "cheap " } });
    const end = editor.view.state.doc.line(2).to;
    editor.view.dispatch({ changes: { from: end, insert: "\n- [ ] " }, userEvent: "input" });
    expect(editor.view.state.doc.line(2).text).toBe("- [ ] cheap book flights today");
    editor.setAnnotations([{ ...annotation("a", 1), unread: 0 }]);
    editor.setAnnotations([{ ...annotation("a", 1), unread: 5 }]);
    expect(editor.view.dom.querySelector(".cm-ddl-badge")).toBe(badge);
    expect(badge?.title).toBe("Researching… (5 unread)");
  });

  it("animates in only the badges that appear after the note's first set", () => {
    const editor = mount({ doc: DOC });
    const badgeOf = (id: string) =>
      [...editor.view.dom.querySelectorAll<HTMLElement>(".cm-ddl-badge")].find((b) =>
        b.getAttribute("aria-label")?.includes(`label ${id}`),
      );
    const entering = () =>
      [...editor.view.dom.querySelectorAll(".cm-ddl-badge-enter")].map(
        (b) => b.getAttribute("aria-label")?.match(/label (\w)/)?.[1],
      );
    const labelled = (id: string, line: number): LineAnnotation => ({
      ...annotation(id, line),
      label: `label ${id}`,
    });

    // What the note already had when it was shown doesn't animate.
    editor.setAnnotations([labelled("a", 1)]);
    expect(entering()).toEqual([]);
    editor.setAnnotations([labelled("a", 1), labelled("b", 2)]);
    expect(entering()).toEqual(["b"]);

    // A status change mid-animation keeps it; the class goes once the animation ends.
    const b = badgeOf("b");
    editor.setAnnotations([labelled("a", 1), { ...labelled("b", 2), status: "done" }]);
    expect(badgeOf("b")).toBe(b);
    expect(entering()).toEqual(["b"]);
    b?.querySelector(".cm-ddl-badge-icon")?.dispatchEvent(
      new Event("animationend", { bubbles: true }),
    );
    expect(entering()).toEqual(["b"]);
    b?.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(entering()).toEqual([]);

    // Showing the note again: its badges were already there.
    const cached = editor.getState();
    editor.setState(editor.createState("other"));
    editor.setState(cached);
    editor.setAnnotations([labelled("a", 1), labelled("b", 2)]);
    expect(entering()).toEqual([]);

    // A note without badges yet: after its first (empty) set, the first badge animates in.
    editor.setState(editor.createState("- [ ] new task"));
    editor.setAnnotations([]);
    editor.setAnnotations([labelled("c", 0)]);
    expect(entering()).toEqual(["c"]);
  });

  it("follows rendered wikilinks on click, in a new pane with Mod or middle click", () => {
    const onWikiLinkClick = vi.fn();
    const editor = mount({ doc: "see [[Note#Plan|the plan]]", callbacks: { onWikiLinkClick } });
    const link = editor.view.dom.querySelector(".cm-ddl-wikilink");
    expect(link?.textContent).toBe("the plan");
    if (link) {
      mousedown(link);
      mousedown(link, { button: 1 });
    }
    expect(onWikiLinkClick.mock.calls).toEqual([
      ["Note", { newPane: false, subpath: "Plan" }],
      ["Note", { newPane: true, subpath: "Plan" }],
    ]);
  });
});

describe("keyboard and vim", () => {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);

  it("saves on Mod-s", () => {
    const onSave = vi.fn();
    const editor = mount({ callbacks: { onSave } });
    const event = new KeyboardEvent("keydown", { key: "s", metaKey: mac, ctrlKey: !mac });
    expect(runScopeHandlers(editor.view, event, "editor")).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("toggles vim mode and maps :w to onSave", () => {
    const onSave = vi.fn();
    const callbacks: EditorCallbacks = { onSave };
    const editor = mount({ doc: "text", callbacks });
    expect(getCM(editor.view)).toBeNull();
    editor.configure({ vimMode: true });
    Vim.handleEx(vimAdapter(editor), "w");
    expect(onSave).toHaveBeenCalledTimes(1);
    editor.configure({ vimMode: false });
    expect(getCM(editor.view)).toBeNull();
  });

  it("keeps vim, live preview and annotations working together", () => {
    const editor = mount({ doc: DOC, config: { vimMode: true } });
    editor.setAnnotations([annotation("a", 1)]);
    const cm = vimAdapter(editor);
    // `j` needs layout, which happy-dom lacks; `:2` is the layout-free equivalent here.
    Vim.handleEx(cm, "2");
    Vim.handleKey(cm, "A", "user");
    expect(cm.state.vim.insertMode).toBe(true);
    editor.view.dispatch(editor.view.state.replaceSelection(" today"));
    expect(editor.view.state.doc.line(2).text).toBe("- [ ] book flights today");
    expect(getAnnotations(editor.view.state).map((a) => a.line)).toEqual([1]);
    expect(editor.view.dom.querySelectorAll(".cm-ddl-badge")).toHaveLength(1);
  });
});
