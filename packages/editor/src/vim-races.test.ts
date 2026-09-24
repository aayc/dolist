// @vitest-environment happy-dom
import { getCM } from "@replit/codemirror-vim";
import { afterEach, describe, expect, it } from "vitest";
import { createMarkdownEditor } from "./editor";
import type { CreateEditorOptions, MarkdownEditor } from "./types";
import { isVimLoaded, preloadVim } from "./vim";

// Vim loads through a module-level dynamic import, so this file relies on running first in a fresh
// module graph (Vitest isolates test files): everything before `await loaded()` races the load.

const editors: MarkdownEditor[] = [];

function mount(options: Partial<CreateEditorOptions> = {}): MarkdownEditor {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createMarkdownEditor(parent, { doc: "hello\nworld", ...options });
  editors.push(editor);
  return editor;
}

async function loaded(): Promise<void> {
  await preloadVim();
  // Waiting editors are notified synchronously from the load; give queued work a turn too.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("vim lazy-load races", () => {
  it("settles every editor on its latest vim setting once the module arrives", async () => {
    expect(isVimLoaded()).toBe(false);

    const onOffOn = mount();
    onOffOn.configure({ vimMode: true });
    onOffOn.configure({ vimMode: false });
    onOffOn.configure({ vimMode: true });

    const onOff = mount({ config: { vimMode: true } });
    onOff.configure({ vimMode: false });

    const destroyed = mount({ config: { vimMode: true } });
    destroyed.destroy();
    editors.splice(editors.indexOf(destroyed), 1);

    const swapped = mount({ config: { vimMode: true } });
    const cached = swapped.getState();
    swapped.setState(swapped.createState("another note"));

    const readOnly = mount({ config: { vimMode: true, readOnly: true } });

    for (const editor of [onOffOn, onOff, swapped, readOnly])
      expect(getCM(editor.view)).toBeFalsy();
    expect(isVimLoaded()).toBe(false);

    await loaded();

    expect(isVimLoaded()).toBe(true);
    expect(getCM(onOffOn.view)).toBeTruthy();
    expect(getCM(onOff.view)).toBeFalsy();
    expect(getCM(swapped.view)).toBeTruthy();
    expect(getCM(readOnly.view)).toBeTruthy();
    expect(swapped.getDocument()).toBe("another note");

    // A state cached before the load picks vim up when it is shown again.
    swapped.setState(cached);
    expect(getCM(swapped.view)).toBeTruthy();
    expect(swapped.getDocument()).toBe("hello\nworld");
  });

  it("enables vim synchronously once loaded, and toggles cleanly", async () => {
    await loaded();
    const editor = mount({ config: { vimMode: true } });
    expect(getCM(editor.view)).toBeTruthy();
    editor.configure({ vimMode: false });
    expect(getCM(editor.view)).toBeFalsy();
    editor.configure({ vimMode: true });
    expect(getCM(editor.view)).toBeTruthy();
    expect(editor.getDocument()).toBe("hello\nworld");
  });

  it("preloadVim is idempotent", async () => {
    const [a, b] = [preloadVim(), preloadVim()];
    await Promise.all([a, b]);
    expect(isVimLoaded()).toBe(true);
  });
});
