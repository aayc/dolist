// @vitest-environment happy-dom
import { undoDepth } from "@codemirror/commands";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMarkdownEditor } from "../editor";
import type { MarkdownEditor } from "../types";
import { selectedEmbed } from "./layer";
import type { EmbedContent, EmbedHost, EmbedRenderer, EmbedSpec } from "./types";

const editors: MarkdownEditor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.innerHTML = "";
});

interface Recorder {
  renderer: EmbedRenderer;
  hosts: EmbedHost[];
  updates: EmbedSpec[];
  destroyed: number;
  activated: number;
}

function recorder(update = true): Recorder {
  const rec: Recorder = {
    hosts: [],
    updates: [],
    destroyed: 0,
    activated: 0,
    renderer: {
      kind: "drawing",
      matches: (target) => target.endsWith(".excalidraw"),
      mount(host): EmbedContent {
        rec.hosts.push(host);
        host.dom.textContent = `drawing ${host.spec.target}`;
        return {
          ...(update
            ? {
                update: (spec: EmbedSpec) => {
                  rec.updates.push(spec);
                  return true;
                },
              }
            : {}),
          activate: () => {
            rec.activated++;
            return true;
          },
          destroy: () => {
            rec.destroyed++;
          },
        };
      },
    },
  };
  return rec;
}

function mount(doc: string, rec: Recorder, cursor = 0): MarkdownEditor {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createMarkdownEditor(parent, {
    doc,
    callbacks: { embedRenderers: [rec.renderer] },
  });
  editor.view.dispatch({ selection: { anchor: cursor } });
  editors.push(editor);
  return editor;
}

function frame(editor: MarkdownEditor): HTMLElement {
  const element = editor.view.dom.querySelector<HTMLElement>(".cm-ddl-embed");
  if (!element) throw new Error("no embed drawn");
  return element;
}

function key(target: HTMLElement, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

const DOC = "Intro\n![[Plan.excalidraw|360|right-wrap]]\nMore text";

describe("embed boxes in the editor", () => {
  it("mounts the renderer in a box sized and placed by the modifiers", () => {
    const rec = recorder();
    const editor = mount(DOC, rec);
    const box = frame(editor);
    expect(box.classList).toContain("cm-ddl-embed-right-wrap");
    expect(box.classList).toContain("cm-ddl-embed-drawing");
    expect(box.style.width).toBe("360px");
    expect(box.getAttribute("contenteditable")).toBe("false");
    expect(rec.hosts).toHaveLength(1);
    expect(rec.hosts[0]!.embed()?.text).toBe("![[Plan.excalidraw|360|right-wrap]]");
    expect(box.querySelector(".cm-ddl-embed-content")?.textContent).toBe("drawing Plan.excalidraw");
  });

  it("reserves the content's aspect ratio, and uses its natural width when none is given", () => {
    const rec = recorder();
    const editor = mount("x\n![[Plan.excalidraw|left-wrap]]", rec);
    rec.hosts[0]!.setNaturalSize({ width: 300, height: 150 });
    const box = frame(editor);
    expect(box.style.width).toBe("300px");
    expect((box.firstElementChild as HTMLElement).style.aspectRatio).toBe("300 / 150");
  });

  it("keeps the content when only the modifiers change, and remounts for another target", () => {
    const rec = recorder();
    const editor = mount(DOC, rec);
    const from = DOC.indexOf("![[");
    editor.view.dispatch({ changes: { from: from + 19, to: from + 22, insert: "280" } });
    expect(rec.hosts).toHaveLength(1);
    expect(rec.updates).toEqual([
      { target: "Plan.excalidraw", width: 280, placement: "right-wrap" },
    ]);
    expect(frame(editor).style.width).toBe("280px");
    editor.view.dispatch({ changes: { from: from + 3, to: from + 7, insert: "Other" } });
    expect(rec.hosts).toHaveLength(2);
    expect(rec.destroyed).toBe(1);
  });

  it("remounts a renderer that can't update", () => {
    const rec = recorder(false);
    const editor = mount(DOC, rec);
    const from = DOC.indexOf("![[");
    editor.view.dispatch({ changes: { from: from + 19, to: from + 22, insert: "280" } });
    expect(rec.hosts).toHaveLength(2);
    expect(rec.destroyed).toBe(1);
  });

  it("shows the syntax while the caret is on the line", () => {
    const rec = recorder();
    const editor = mount(DOC, rec);
    editor.focus();
    editor.view.dispatch({ selection: { anchor: DOC.indexOf("![[") + 4 } });
    expect(editor.view.dom.querySelector(".cm-ddl-embed")).toBeNull();
    expect(rec.destroyed).toBe(1);
  });

  it("is selected by a press, without moving the caret", () => {
    const rec = recorder();
    const editor = mount(DOC, rec, 2);
    const box = frame(editor);
    box.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }));
    expect(selectedEmbed(editor.view.state)?.from).toBe(DOC.indexOf("![["));
    expect(editor.view.state.selection.main.head).toBe(2);
    expect(frame(editor).classList).toContain("is-selected");
    box.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1 }));
    expect(editor.getDocument()).toBe(DOC);
  });

  it("Delete removes the selected embed's line, as an undoable edit", () => {
    const rec = recorder();
    const editor = mount(DOC, rec);
    const box = frame(editor);
    box.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }));
    key(frame(editor), { key: "Delete" });
    expect(editor.getDocument()).toBe("Intro\nMore text");
    expect(undoDepth(editor.view.state)).toBe(1);
  });

  it("Enter and double-click activate it; Escape deselects", () => {
    const rec = recorder();
    const editor = mount(DOC, rec);
    frame(editor).dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }),
    );
    key(frame(editor), { key: "Enter" });
    frame(editor).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(rec.activated).toBe(2);
    key(frame(editor), { key: "Escape" });
    expect(selectedEmbed(editor.view.state)).toBeNull();
  });

  it("arrow keys leave it for the line before or after", () => {
    const rec = recorder();
    const editor = mount(DOC, rec);
    frame(editor).dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }),
    );
    key(frame(editor), { key: "ArrowDown" });
    expect(editor.view.state.selection.main.head).toBe(DOC.indexOf("More"));
    expect(selectedEmbed(editor.view.state)).toBeNull();
  });

  it("inserts an embed on its own line and activates it once drawn", () => {
    const rec = recorder();
    const editor = mount("First\nSecond", rec, 8);
    editor.focus();
    const from = editor.insertEmbed("![[New.excalidraw|360|right-wrap]]");
    expect(editor.getDocument()).toBe("First\n![[New.excalidraw|360|right-wrap]]\nSecond");
    expect(editor.activateEmbed(from)).toBe(true);
    expect(rec.activated).toBe(1);
    expect(editor.activateEmbed(0)).toBe(false);
  });

  it("destroys the content with the editor", () => {
    const rec = recorder();
    const editor = mount(DOC, rec);
    editor.destroy();
    editors.splice(editors.indexOf(editor), 1);
    expect(rec.destroyed).toBe(1);
  });

  it("reports a renderer that throws instead of breaking the editor", () => {
    const error = new Error("boom");
    const renderer: EmbedRenderer = {
      kind: "drawing",
      matches: () => true,
      mount: () => {
        throw error;
      },
    };
    const thrown = vi.fn();
    const original = globalThis.queueMicrotask;
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) =>
      original(() => {
        try {
          callback();
        } catch (e) {
          thrown(e);
        }
      }),
    );
    const parent = document.createElement("div");
    document.body.append(parent);
    const editor = createMarkdownEditor(parent, {
      doc: DOC,
      callbacks: { embedRenderers: [renderer] },
    });
    editors.push(editor);
    expect(frame(editor).textContent).toContain("Couldn't show this embed");
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(thrown).toHaveBeenCalledWith(error);
        resolve();
      }, 0),
    );
  });
});
