// @vitest-environment happy-dom
import { getCM, Vim } from "@replit/codemirror-vim";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMarkdownEditor } from "./editor";
import type { EditorCallbacks, EditorConfig, MarkdownEditor, VimStatus } from "./types";
import { preloadVim, vimClaimsKey } from "./vim";

const editors: MarkdownEditor[] = [];

function mount(callbacks: EditorCallbacks = {}, config: Partial<EditorConfig> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const editor = createMarkdownEditor(parent, {
    doc: "one two\nthree",
    config: { vimMode: true, ...config },
    callbacks,
  });
  editors.push(editor);
  const cm = getCM(editor.view);
  if (!cm) throw new Error("vim is not on");
  return { editor, cm };
}

function keys(cm: NonNullable<ReturnType<typeof getCM>>, ...tokens: string[]): void {
  for (const token of tokens) Vim.handleKey(cm, token, "user");
}

const KEY_NAMES: Record<string, string> = { "<Esc>": "Escape", "<CR>": "Enter" };

/**
 * Real keydown events, so the adapter's key handler (pending keys, events) runs too; like separate
 * keystrokes, each is followed by a microtask checkpoint.
 */
async function press(editor: MarkdownEditor, ...tokens: string[]): Promise<void> {
  for (const token of tokens) {
    const ctrl = /^<C-(.)>$/.exec(token);
    const key = ctrl ? ctrl[1]! : (KEY_NAMES[token] ?? token);
    editor.view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        ctrlKey: Boolean(ctrl),
        bubbles: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
  }
}

beforeAll(() => preloadVim());

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  Vim.mapclear();
});

describe("vim ex commands", () => {
  it("map to the host's callbacks", () => {
    const callbacks = {
      onSave: vi.fn(),
      onSaveAll: vi.fn(),
      onClose: vi.fn(),
      onOpenNote: vi.fn(),
      onSwitchTab: vi.fn(),
      onRunCommand: vi.fn(() => true),
    };
    const { cm } = mount(callbacks);
    const ex = (input: string) => Vim.handleEx(cm as Parameters<typeof Vim.handleEx>[0], input);

    ex("w");
    ex("write");
    expect(callbacks.onSave).toHaveBeenCalledTimes(2);
    ex("wa");
    expect(callbacks.onSaveAll).toHaveBeenCalledOnce();
    for (const command of ["q", "q!", "quit", "tabc", "bd"]) ex(command);
    expect(callbacks.onClose.mock.calls).toEqual(Array(5).fill([{ all: false }]));
    callbacks.onClose.mockClear();
    ex("qa");
    expect(callbacks.onClose).toHaveBeenLastCalledWith({ all: true });
    ex("wq");
    ex("x");
    expect(callbacks.onSave).toHaveBeenCalledTimes(4);
    expect(callbacks.onClose).toHaveBeenLastCalledWith({ all: false });
    ex("xa");
    expect(callbacks.onSaveAll).toHaveBeenCalledTimes(2);
    expect(callbacks.onClose).toHaveBeenLastCalledWith({ all: true });

    ex("e Garden Redesign");
    ex("edit");
    ex("e!");
    ex("tabe Notes/Idea.md");
    ex("tabnew");
    expect(callbacks.onOpenNote.mock.calls).toEqual([
      ["Garden Redesign", { newTab: false }],
      [null, { newTab: false }],
      [null, { newTab: false }],
      ["Notes/Idea.md", { newTab: true }],
      [null, { newTab: true }],
    ]);

    for (const command of ["tabn", "tabn 3", "tabp", "tabp 2", "tabN", "bn", "bp", "bN"])
      ex(command);
    expect(callbacks.onSwitchTab.mock.calls.map(([to]) => to)).toEqual([
      { delta: 1 },
      { index: 2 },
      { delta: -1 },
      { delta: -2 },
      { delta: -1 },
      { delta: 1 },
      { delta: -1 },
      { delta: -1 },
    ]);

    ex("obcommand daily:today");
    expect(callbacks.onRunCommand).toHaveBeenCalledWith("daily:today");
  });

  it("tell the user when this editor can't do it", () => {
    const { editor, cm } = mount({ onRunCommand: () => false });
    const ex = (input: string) => Vim.handleEx(cm as Parameters<typeof Vim.handleEx>[0], input);
    const message = () => editor.view.dom.querySelector(".cm-vim-message")?.textContent;
    ex("q");
    expect(message()).toBe(":quit isn't available here");
    ex("obcommand nope:nothing");
    expect(message()).toBe("No command nope:nothing");
    ex("obcommand");
    expect(message()).toBe("Usage: :obcommand <command id>");
  });
});

describe("gt and gT", () => {
  it("switch tabs, to tab N with a count, and survive :mapclear", () => {
    const onSwitchTab = vi.fn();
    const { cm } = mount({ onSwitchTab });
    keys(cm, "g", "t");
    keys(cm, "3", "g", "t");
    keys(cm, "g", "T");
    keys(cm, "2", "g", "T");
    Vim.handleEx(cm as Parameters<typeof Vim.handleEx>[0], "mapclear");
    keys(cm, "g", "t");
    expect(onSwitchTab.mock.calls.map(([to]) => to)).toEqual([
      { delta: 1 },
      { index: 2 },
      { delta: -1 },
      { delta: -2 },
      { delta: 1 },
    ]);
  });
});

describe("vim status", () => {
  it("reports the mode, pending keys and recording only when they change", async () => {
    const statuses: VimStatus[] = [];
    const { editor } = mount({ onVimStatus: (status) => status && statuses.push(status) });
    expect(statuses).toEqual([{ mode: "normal", pending: "", recording: null }]);
    await press(editor, "i");
    // Typing in insert mode goes through vim's key handler but reports nothing new.
    await press(editor, ..."hello");
    await press(editor, "<Esc>", "v", "<Esc>", "V", "<Esc>", "<C-v>", "<Esc>", "R", "<Esc>");
    await press(editor, "2", "d", "<Esc>", '"', "a", "y", "y", "q", "q", "q");
    const summary = statuses.map((s) => `${s.mode}:${s.pending}:${s.recording ?? ""}`);
    expect(summary).toEqual([
      "normal::",
      "insert::",
      "normal::",
      "visual::",
      "normal::",
      "visual-line::",
      "normal::",
      "visual-block::",
      "normal::",
      "replace::",
      "normal::",
      "normal:2:",
      "normal:2d:",
      "normal::",
      'normal:":',
      'normal:"a:',
      'normal:"ay:',
      "normal::",
      "normal:q:",
      "normal::q",
      "normal::",
    ]);
  });
});

describe("vimrc", () => {
  it("is applied when vim starts and re-applied when it changes, reporting bad lines", () => {
    const onVimrcApplied = vi.fn();
    const { editor, cm } = mount({ onVimrcApplied }, { vimrc: 'nmap Q i\n" comment\nset bogus' });
    expect(onVimrcApplied).toHaveBeenLastCalledWith([
      { line: 2, message: "Unknown option: bogus" },
    ]);
    keys(cm, "Q");
    expect(cm.state.vim?.insertMode).toBe(true);
    keys(cm, "<Esc>");

    editor.configure({ vimrc: "nmap Z i\nset clipboard=unnamed" });
    expect(onVimrcApplied).toHaveBeenLastCalledWith([]);
    expect(Vim.getOption("clipboard")).toBe("unnamed");
    keys(cm, "Q");
    expect(cm.state.vim?.insertMode).toBe(false);
    keys(cm, "Z");
    expect(cm.state.vim?.insertMode).toBe(true);
    keys(cm, "<Esc>");

    editor.configure({ vimrc: "" });
    expect(Vim.getOption("clipboard")).toBeUndefined();
    keys(cm, "Z");
    expect(cm.state.vim?.insertMode).toBe(false);
  });
});

describe("vimClaimsKey", () => {
  it("claims the Ctrl keys vim binds, and nothing in insert mode", () => {
    const { editor, cm } = mount({}, { vimrc: "nmap <C-j> j" });
    const press = (key: string, init: KeyboardEventInit = { ctrlKey: true }) => {
      const event = new KeyboardEvent("keydown", { key, ...init });
      Object.defineProperty(event, "target", { value: editor.view.contentDOM });
      return vimClaimsKey(event);
    };
    expect(press("o")).toBe(true);
    expect(press("d")).toBe(true);
    expect(press("j")).toBe(true);
    expect(press("s")).toBe(false);
    expect(press("o", { metaKey: true })).toBe(false);
    keys(cm, "i");
    expect(press("o")).toBe(false);
    keys(cm, "<Esc>");
    const outside = new KeyboardEvent("keydown", { key: "o", ctrlKey: true });
    Object.defineProperty(outside, "target", { value: document.body });
    expect(vimClaimsKey(outside)).toBe(false);
  });
});
