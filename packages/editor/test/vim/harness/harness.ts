/**
 * Applies vector cases to a CodeMirror 6 editor with vim, following the replay rules in README.md,
 * and snapshots the state after each step. The same code produces the oracle's expectations
 * (plain CM6) and replays them against the Daily Do List editor.
 */
import { EditorSelection, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { CodeMirror, getCM, Vim } from "@replit/codemirror-vim";
import {
  type ApiCall,
  type CaseSpec,
  DEFAULT_OPTIONS,
  type ExpectedState,
  type PromptState,
  type RegisterValue,
  type SelectionRange,
  type VectorCase,
  type VectorStep,
  VIEWPORT,
  type VimMode,
} from "../format";
import { ORACLE_FONT_FAMILY } from "../scripts/oracle-font";
import { insertedText, type KeySpec, keySpecOf, overwriteText } from "./keys";

/**
 * The editor font of every harness page. Only printable ASCII is in the oracle font, so the
 * layout-dependent cases (page motions, display lines) keep to ASCII documents.
 */
export const ORACLE_FONT_STACK = `"${ORACLE_FONT_FAMILY}", monospace`;

export type VimCM = NonNullable<ReturnType<typeof getCM>>;
/** The engine's API types an editor whose vim state exists (true once vim mode is entered). */
type EngineCM = Parameters<typeof Vim.handleEx>[0];

export interface EditorSpec {
  doc: string;
  tabSize: number;
  indentUnit: string;
}

export interface HarnessEditor {
  readonly view: EditorView;
  destroy(): void;
}

export type EditorFactory = (spec: EditorSpec) => HarnessEditor;

interface DialogOptions {
  onKeyDown?: (event: PromptKeyEvent, value: string, close: CloseFn) => boolean | undefined;
  onKeyUp?: (event: PromptKeyEvent, value: string, close: CloseFn) => void;
  onInput?: (event: PromptKeyEvent, value: string, close: CloseFn) => void;
  onClose?: (dialog: Element) => void;
  closeOnEnter?: boolean;
  value?: string;
}

type CloseFn = (newValue?: string) => void;

interface PromptTarget {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/** The subset of a KeyboardEvent the engine's prompt hooks read. */
interface PromptKeyEvent {
  key: string;
  keyCode: number;
  which: number;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: PromptTarget;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

interface Prompt {
  prefix: string;
  value: string;
  callback: ((value: string) => void) | undefined;
  options: DialogOptions;
  closed: boolean;
  close: CloseFn;
}

type Listener = Parameters<typeof CodeMirror.on>[2];

/** Registers are listed in this order; `+`/`*` (system clipboard) and `_` never are. */
const SNAPSHOT_REGISTERS = [
  '"',
  ..."0123456789",
  ..."abcdefghijklmnopqrstuvwxyz",
  "-",
  ".",
  ":",
  "/",
];

/**
 * vim.js tracks insert-mode Backspace/Delete for `.` repeat with a plain DOM `keydown` listener on
 * the editor's content element (`onKeyEventTargetKeyDown`). A replay has no keyboard, so the
 * listeners the engine registers through `CodeMirror.on` are remembered and called with a synthetic
 * event whenever a Backspace or Delete token is applied.
 */
const contentKeydownListeners = new WeakMap<object, Set<Listener>>();
let listenersPatched = false;

function patchListenerRegistry(): void {
  if (listenersPatched) return;
  listenersPatched = true;
  const on = CodeMirror.on;
  const off = CodeMirror.off;
  CodeMirror.on = (...args: Parameters<typeof on>) => {
    const [emitter, type, listener] = args;
    if (type === "keydown" && emitter instanceof HTMLElement) {
      const set = contentKeydownListeners.get(emitter) ?? new Set<Listener>();
      contentKeydownListeners.set(emitter, set);
      set.add(listener);
    }
    on(...args);
  };
  CodeMirror.off = (...args: Parameters<typeof off>) => {
    const [emitter, type, listener] = args;
    if (type === "keydown" && emitter instanceof HTMLElement) {
      contentKeydownListeners.get(emitter)?.delete(listener);
    }
    off(...args);
  };
}

function modeOf(cm: VimCM): VimMode {
  const vim = cm.state.vim;
  if (!vim) return "normal";
  if (vim.insertMode) return cm.state.overwrite ? "replace" : "insert";
  if (vim.visualMode) {
    if (vim.visualBlock) return "visual-block";
    return vim.visualLine ? "visual-line" : "visual";
  }
  return "normal";
}

function snapshotRegisters(): Record<string, RegisterValue> | undefined {
  const { registers } = Vim.getRegisterController();
  const out: Record<string, RegisterValue> = {};
  let any = false;
  for (const name of SNAPSHOT_REGISTERS) {
    const register = registers[name];
    if (!register) continue;
    const text = register.toString();
    if (text === "") continue;
    out[name] = {
      text,
      linewise: Boolean(register.linewise),
      blockwise: Boolean(register.blockwise),
    };
    any = true;
  }
  return any ? out : undefined;
}

function toRange(cm: VimCM, anchor: number, head: number): SelectionRange {
  const a = cm.posFromIndex(anchor);
  if (anchor === head) return [a.line, a.ch];
  const h = cm.posFromIndex(head);
  return [a.line, a.ch, h.line, h.ch];
}

function rangesOf(selection: readonly SelectionRange[]) {
  return selection.map((range) =>
    range.length === 2
      ? {
          anchor: new CodeMirror.Pos(range[0], range[1]),
          head: new CodeMirror.Pos(range[0], range[1]),
        }
      : {
          anchor: new CodeMirror.Pos(range[0], range[1]),
          head: new CodeMirror.Pos(range[2], range[3]),
        },
  );
}

/** The keyboard event the prompt hooks see; its target is whichever prompt input has focus. */
function promptKeyEvent(spec: KeySpec, focused: () => Prompt | null): PromptKeyEvent {
  const event: PromptKeyEvent = {
    key: spec.key,
    keyCode: spec.keyCode,
    which: spec.keyCode,
    code: "",
    ctrlKey: spec.ctrlKey,
    altKey: spec.altKey,
    metaKey: spec.metaKey,
    shiftKey: spec.shiftKey,
    target: {
      get value() {
        return focused()?.value ?? "";
      },
      set value(value: string) {
        const prompt = focused();
        if (prompt) prompt.value = value;
      },
      get selectionStart() {
        return focused()?.value.length ?? 0;
      },
      set selectionStart(_value: number) {},
      get selectionEnd() {
        return focused()?.value.length ?? 0;
      },
      set selectionEnd(_value: number) {},
    },
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {},
  };
  return event;
}

/** A notification's text: its `.cm-vim-message` element (without "Press ENTER…"). */
export function messageText(template: Node): string {
  if (template instanceof Element) {
    const message = template.classList.contains("cm-vim-message")
      ? template
      : template.querySelector(".cm-vim-message");
    return (message ?? template).textContent ?? "";
  }
  return template.textContent ?? "";
}

let segmenter: Intl.Segmenter | null = null;

/** Offset of the grapheme boundary before (`dir < 0`) or after `offset` within `text`. */
function graphemeBoundary(text: string, offset: number, dir: -1 | 1): number {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let previous = 0;
  for (const { index, segment } of segmenter.segment(text)) {
    const end = index + segment.length;
    if (dir < 0) {
      if (end >= offset) return index < offset ? index : previous;
      previous = index;
    } else if (index >= offset) {
      return end;
    }
  }
  return dir < 0 ? previous : text.length;
}

/** README rule 2: `<BS>`/`<Del>` with no selection delete one grapheme cluster (or a line break). */
export function deleteByGrapheme(state: EditorState, forward: boolean) {
  return state.changeByRange((range) => {
    if (!range.empty) {
      return {
        changes: { from: range.from, to: range.to },
        range: EditorSelection.cursor(range.from),
      };
    }
    const line = state.doc.lineAt(range.head);
    const offset = range.head - line.from;
    let from = range.head;
    let to = range.head;
    if (forward) {
      to =
        offset < line.length
          ? line.from + graphemeBoundary(line.text, offset, 1)
          : Math.min(line.to + 1, state.doc.length);
    } else {
      from =
        offset > 0
          ? line.from + graphemeBoundary(line.text, offset, -1)
          : Math.max(line.from - 1, 0);
    }
    return { changes: { from, to }, range: EditorSelection.cursor(from) };
  });
}

/** Runs cases one at a time against editors from `factory`. */
export class VimHarness {
  private readonly factory: EditorFactory;
  private editor: HarnessEditor | null = null;
  private cm: VimCM | null = null;
  private prompt: Prompt | null = null;
  private message: string | undefined;
  private viewportCase = false;
  private geometryChecked = false;
  private readonly exMappings = new Set<string>();

  constructor(factory: EditorFactory) {
    patchListenerRegistry();
    // Platform-dependent branches (`<A-…>`, `<C-c>` copy) must not depend on the host OS.
    CodeMirror.isMac = false;
    Vim.suppressErrorLogging = true;
    this.factory = factory;
  }

  /** Runs `spec` and returns it with every step's `expect` filled in from the editor. */
  run(spec: CaseSpec): VectorCase {
    this.reset();
    const editor = this.factory({
      doc: spec.doc,
      tabSize: spec.options?.tabSize ?? DEFAULT_OPTIONS.tabSize,
      indentUnit: spec.options?.indentUnit ?? DEFAULT_OPTIONS.indentUnit,
    });
    this.editor = editor;
    try {
      const cm = getCM(editor.view);
      if (!cm) throw new Error("vim is not enabled in the harness editor");
      this.cm = cm;
      this.interceptDialogs(cm);
      Vim.maybeInitVimState_(cm);
      // Until the first measurement CodeMirror estimates line heights; scrolling on estimates
      // would land elsewhere once real heights re-anchor the viewport.
      cm.refresh();
      this.checkGeometry(editor.view);
      this.viewportCase = spec.scrollTop !== undefined;
      cm.setSelections(rangesOf(spec.selection), spec.primary ?? 0);
      for (const [name, value] of Object.entries(spec.vim ?? {})) {
        Vim.setOption(name, value, cm as EngineCM);
      }
      for (const [name, value] of Object.entries(spec.registers ?? {})) {
        Vim.getRegisterController()
          .getRegister(name)
          .setText(value.text, value.linewise, value.blockwise);
      }
      if (spec.scrollTop !== undefined) {
        editor.view.scrollDOM.scrollTop = spec.scrollTop * VIEWPORT.lineHeight;
      } else {
        // Like vim after every command: the cursor starts on screen.
        editor.view.dispatch({ scrollIntoView: true });
      }
      cm.refresh();
      const steps: VectorStep[] = spec.steps.map((step) => {
        this.message = undefined;
        if ("keys" in step) {
          for (const token of step.keys) this.applyToken(token);
          return { keys: step.keys, expect: this.snapshot() };
        }
        this.applyApi(step.api);
        return { api: step.api, expect: this.snapshot() };
      });
      return { ...spec, steps };
    } finally {
      this.dispose();
    }
  }

  private reset(): void {
    Vim.resetVimGlobalState_();
    Vim.mapclear();
    Vim.langmap("", undefined);
    this.prompt = null;
    this.message = undefined;
  }

  /**
   * Fails the run when the editor doesn't lay out with the geometry the vectors record (a theme
   * that lost the oracle font, say). CodeMirror's `defaultCharacterWidth` is an estimate that can
   * be 1/64px off the glyph advance, hence the tolerance.
   */
  private checkGeometry(view: EditorView): void {
    if (this.geometryChecked) return;
    const measured = { lineHeight: view.defaultLineHeight, charWidth: view.defaultCharacterWidth };
    if (
      measured.lineHeight !== VIEWPORT.lineHeight ||
      Math.abs(measured.charWidth - VIEWPORT.charWidth) > 0.01
    ) {
      throw new Error(
        `harness editor geometry ${JSON.stringify(measured)} differs from the vectors' ` +
          `(lineHeight ${VIEWPORT.lineHeight}, charWidth ${VIEWPORT.charWidth})`,
      );
    }
    this.geometryChecked = true;
  }

  private dispose(): void {
    for (const lhs of this.exMappings) Vim.unmap(lhs, "");
    this.exMappings.clear();
    this.editor?.destroy();
    this.editor = null;
    this.cm = null;
    this.prompt = null;
  }

  private interceptDialogs(cm: VimCM): void {
    cm.openDialog = (
      template: Element,
      callback: ((value: string) => void) | undefined,
      options?: DialogOptions,
    ) => this.openDialog(template, callback, options ?? {});
    cm.openNotification = (template: Node) => {
      this.message = messageText(template);
      return () => {};
    };
  }

  private openDialog(
    template: Element,
    callback: ((value: string) => void) | undefined,
    options: DialogOptions,
  ): CloseFn {
    const input = template.querySelector("input");
    // Dialogs without an input ("recording @q") are status lines, not prompts.
    if (!input) return () => {};
    const prompt: Prompt = {
      prefix: input.parentElement?.textContent ?? "",
      value: options.value ?? "",
      callback,
      options,
      closed: false,
      close: (newValue) => {
        if (typeof newValue === "string") {
          prompt.value = newValue;
          return;
        }
        if (prompt.closed) return;
        prompt.closed = true;
        if (this.prompt === prompt) this.prompt = null;
        options.onClose?.(template);
      },
    };
    this.prompt = prompt;
    return prompt.close;
  }

  /** README "How a replay applies a token". */
  private applyToken(token: string): void {
    const cm = this.cm!;
    const prompt = this.prompt;
    const event = promptKeyEvent(keySpecOf(token), () => this.prompt);
    if (prompt) this.sendToPrompt(prompt, token, event);
    else this.sendToEditor(token);
    // The keyup goes to the focused element: a prompt the key left open (or opened).
    const open = this.prompt;
    if (open) {
      try {
        open.options.onKeyUp?.(event, open.value, open.close);
      } catch {}
    }
    cm.refresh();
  }

  private sendToEditor(token: string): void {
    const cm = this.cm!;
    const spec = keySpecOf(token);
    const content = this.editor!.view.contentDOM;
    // DOM semantics: listeners added while the key is handled don't see that key.
    const listening = [...(contentKeydownListeners.get(content) ?? [])];
    let vim = Vim.maybeInitVimState_(cm);
    vim.status = (vim.status || "") + token;
    let handled = Boolean(Vim.multiSelectHandleKey(cm, token, "user"));
    vim = Vim.maybeInitVimState_(cm);
    if (!handled && vim.insertMode && cm.state.overwrite) {
      const text = overwriteText(spec);
      if (text !== null) {
        handled = true;
        cm.overWriteSelection(text);
      } else if (spec.key === "Backspace") {
        handled = true;
        CodeMirror.commands.cursorCharLeft(cm);
      }
    }
    if (handled) CodeMirror.signal(cm, "vim-keypress", token);
    else if (vim.insertMode) this.nativeEdit(token);
    if (spec.key === "Backspace" || spec.key === "Delete") {
      const current = contentKeydownListeners.get(content);
      const event = {
        key: spec.key,
        keyCode: spec.keyCode,
        ctrlKey: spec.ctrlKey,
        altKey: spec.altKey,
        metaKey: spec.metaKey,
        shiftKey: spec.shiftKey,
      };
      for (const listener of listening) if (current?.has(listener)) listener(event);
    }
  }

  private nativeEdit(token: string): void {
    const view = this.editor!.view;
    const text = insertedText(token);
    if (text !== null) {
      view.dispatch(view.state.replaceSelection(text), {
        userEvent: "input.type",
        scrollIntoView: true,
      });
      return;
    }
    if (token === "<BS>" || token === "<Del>") {
      const forward = token === "<Del>";
      view.dispatch(
        view.state.update(deleteByGrapheme(view.state, forward), {
          userEvent: forward ? "delete.forward" : "delete.backward",
          scrollIntoView: true,
        }),
      );
    }
  }

  /** README rule 1: the engine's keydown hook, then the text field's default behavior. */
  private sendToPrompt(prompt: Prompt, token: string, event: PromptKeyEvent): void {
    const spec = keySpecOf(token);
    const { options } = prompt;
    // Each block below is one DOM event listener: an exception ends that listener only (the
    // browser reports it and goes on with the default action and the next event).
    try {
      // The adapter's dialog keydown handler, which looks at key codes only.
      if (!options.onKeyDown?.(event, prompt.value, prompt.close)) {
        if (spec.keyCode === 13) {
          if (prompt.prefix === ":") this.trackExMappingInput(prompt.value);
          prompt.callback?.(prompt.value);
        }
        if (spec.keyCode === 27 || (options.closeOnEnter !== false && spec.keyCode === 13)) {
          event.preventDefault();
          prompt.close();
        }
      }
    } catch {}
    if (prompt.closed) return;
    if (!event.defaultPrevented) {
      const text = insertedText(token);
      const before = prompt.value;
      if (text !== null && text !== "\n" && text !== "\t") {
        prompt.value += text;
      } else if (token === "<BS>" && prompt.value.length > 0) {
        prompt.value = prompt.value.slice(
          0,
          graphemeBoundary(prompt.value, prompt.value.length, -1),
        );
      }
      if (prompt.value !== before) {
        try {
          options.onInput?.(event, prompt.value, prompt.close);
        } catch {}
      }
    }
  }

  private applyApi(call: ApiCall): void {
    const cm = this.cm!;
    const args = call.args;
    const pos = (value: unknown) => {
      const [line, ch] = value as [number, number];
      return new CodeMirror.Pos(line, ch);
    };
    switch (call.op) {
      case "setCursor":
        cm.setCursor(args[0] as number, args[1] as number);
        break;
      case "setSelections":
        cm.setSelections(
          rangesOf(args[0] as SelectionRange[]),
          (args[1] as number | undefined) ?? 0,
        );
        break;
      case "setValue":
        cm.setValue(args[0] as string);
        break;
      case "replaceRange":
        cm.replaceRange(
          args[0] as string,
          pos(args[1]),
          args[2] === undefined ? undefined : pos(args[2]),
        );
        break;
      case "setOption":
        cm.setOption(args[0] as string, args[1]);
        break;
      case "vimSetOption":
        Vim.setOption(args[0] as string, args[1]);
        break;
      case "map":
        Vim.map(args[0] as string, args[1] as string, args[2] as string);
        this.trackExMapping(args[0]);
        break;
      case "noremap":
        Vim.noremap(args[0] as string, args[1] as string, args[2] as string);
        this.trackExMapping(args[0]);
        break;
      case "unmap":
        Vim.unmap(args[0] as string, args[1] as string);
        break;
      case "mapclear":
        Vim.mapclear(args[0] as string | undefined);
        break;
      case "setRegister":
        Vim.getRegisterController()
          .getRegister(args[0] as string)
          .setText(
            args[1] as string,
            args[2] as boolean | undefined,
            args[3] as boolean | undefined,
          );
        break;
      case "pushText":
        Vim.getRegisterController().pushText(
          args[0] as string | null,
          args[1] as string,
          args[2] as string,
          args[3] as boolean | undefined,
          args[4] as boolean | undefined,
        );
        break;
      case "ex":
        Vim.handleEx(cm as EngineCM, args[0] as string);
        break;
    }
    cm.refresh();
  }

  /**
   * vim.js keeps ex-command mappings (`:map :x :y`) outside the state `resetVimGlobalState_`
   * resets, so the harness removes the ones a case created.
   */
  private trackExMapping(lhs: unknown): void {
    if (typeof lhs === "string" && lhs.startsWith(":") && lhs !== ":") this.exMappings.add(lhs);
  }

  private trackExMappingInput(input: string): void {
    const match = /^[\s:]*(\w+)!?\s+(:\S+)/.exec(input);
    if (match && /^(?:map|no(?:r(?:e(?:m(?:ap?)?)?)?)?)$/.test(match[1]!))
      this.trackExMapping(match[2]);
  }

  private snapshot(): ExpectedState {
    return snapshotEditor(this.editor!.view, this.cm!, {
      prompt: this.prompt ? { prefix: this.prompt.prefix, text: this.prompt.value } : undefined,
      message: this.message,
      viewport: this.viewportCase,
    });
  }
}

export interface SnapshotExtras {
  prompt: PromptState | undefined;
  message: string | undefined;
  viewport: boolean;
}

/** The README "Expected state" of an editor. */
export function snapshotEditor(view: EditorView, cm: VimCM, extras: SnapshotExtras): ExpectedState {
  const { selection } = view.state;
  const expect: ExpectedState = {
    doc: view.state.doc.toString(),
    selection: selection.ranges.map((range) => toRange(cm, range.anchor, range.head)),
    mode: modeOf(cm),
  };
  if (selection.ranges.length > 1) expect.primary = selection.mainIndex;
  const registers = snapshotRegisters();
  if (registers) expect.registers = registers;
  if (extras.prompt) expect.prompt = extras.prompt;
  if (extras.message !== undefined) expect.message = extras.message;
  if (extras.viewport)
    expect.scrollTop = Math.round(view.scrollDOM.scrollTop / VIEWPORT.lineHeight);
  return expect;
}
