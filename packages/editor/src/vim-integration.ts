/**
 * Vim mode as the app ships it, loaded lazily with `@replit/codemirror-vim` (see ./vim.ts): ex
 * commands mapped to app actions, `gt`/`gT`, the system clipboard as `+`/`*` (and
 * `set clipboard=unnamed`), the vimrc, and the mode/pending-keys status for the host.
 *
 * vim.js keeps ex commands, mappings, registers and options in module-level state shared by every
 * editor, so everything here is installed once and resolves the editor it acts on from the `cm`
 * the engine passes in.
 */

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { errorMessage } from "@ddl/core";
import { CodeMirror, getCM, Vim, vim } from "@replit/codemirror-vim";
import { editorCallbacks } from "./callbacks";
import type { EditorCallbacks, VimModeName, VimrcProblem, VimStatus } from "./types";
import { vimrcFacet } from "./vim";
import { ClipboardRegister, mirrorsUnnamed, SystemClipboard } from "./vim-clipboard";
import { forgetMappings, isVimCtrlKey, noteMapping } from "./vim-keys";
import { exMappingsCreatedBy, optionsSetBy, parseVimrc } from "./vimrc";

type VimCM = NonNullable<ReturnType<typeof getCM>>;
/** The engine's API types an editor whose vim state exists (true while vim mode is on). */
type EngineCM = Parameters<typeof Vim.handleEx>[0];
/** What the helpers need from either flavor of the engine's editor object. */
interface HostCM {
  cm6: EditorView;
  openNotification(template: Node, options: { bottom?: boolean; duration?: number }): () => void;
}
type ExParams = Parameters<Parameters<typeof Vim.defineEx>[2]>[1];
type Register = Parameters<typeof Vim.defineRegister>[1];

function callbacksOf(cm: HostCM): EditorCallbacks {
  return cm.cm6.state.facet(editorCallbacks);
}

/** A notification in the vim panel, like the engine's own messages. */
function notify(cm: HostCM, message: string): void {
  const element = document.createElement("div");
  element.className = "cm-vim-message";
  element.textContent = message;
  cm.openNotification(element, { bottom: true, duration: 5000 });
}

/** Runs a host callback, or tells the user the command has no effect in this editor. */
function withHost<K extends keyof EditorCallbacks>(
  cm: HostCM,
  name: K,
  command: string,
  run: (callback: NonNullable<EditorCallbacks[K]>) => void,
): void {
  const callback = callbacksOf(cm)[name];
  if (callback) run(callback as NonNullable<EditorCallbacks[K]>);
  else notify(cm, `:${command} isn't available here`);
}

function argument(params: ExParams): string {
  return (params.argString ?? "").replace(/^!/, "").trim();
}

function save(cm: HostCM): void {
  const onSave = callbacksOf(cm).onSave;
  if (onSave) onSave();
  else CodeMirror.commands.save?.(cm);
}

function switchTab(cm: HostCM, params: ExParams, direction: 1 | -1): void {
  const count = Number.parseInt(argument(params), 10);
  withHost(cm, "onSwitchTab", "tabnext", (onSwitchTab) => {
    // `:tabnext 3` goes to tab 3; `:tabprevious 2` goes back two.
    if (Number.isFinite(count) && count > 0) {
      onSwitchTab(direction === 1 ? { index: count - 1 } : { delta: -count });
    } else {
      onSwitchTab({ delta: direction });
    }
  });
}

function defineExCommands(): void {
  const close = (cm: HostCM, all: boolean) =>
    withHost(cm, "onClose", all ? "qall" : "quit", (onClose) => onClose({ all }));
  const saveAndClose = (cm: HostCM) => {
    save(cm);
    close(cm, false);
  };
  const saveAllAndClose = (cm: HostCM) => {
    withHost(cm, "onSaveAll", "wall", (onSaveAll) => onSaveAll());
    close(cm, true);
  };
  const open = (cm: HostCM, params: ExParams, newTab: boolean) =>
    withHost(cm, "onOpenNote", newTab ? "tabedit" : "edit", (onOpenNote) =>
      onOpenNote(argument(params) || null, { newTab }),
    );

  Vim.defineEx("write", "w", (cm) => save(cm));
  Vim.defineEx("wall", "wa", (cm) => withHost(cm, "onSaveAll", "wall", (onSaveAll) => onSaveAll()));
  Vim.defineEx("quit", "q", (cm) => close(cm, false));
  Vim.defineEx("qall", "qa", (cm) => close(cm, true));
  Vim.defineEx("wq", "wq", saveAndClose);
  Vim.defineEx("xit", "x", saveAndClose);
  Vim.defineEx("wqall", "wqa", saveAllAndClose);
  Vim.defineEx("xall", "xa", saveAllAndClose);
  Vim.defineEx("edit", "e", (cm, params) => open(cm, params, false));
  Vim.defineEx("tabedit", "tabe", (cm, params) => open(cm, params, true));
  Vim.defineEx("tabnew", "tabnew", (cm, params) => open(cm, params, true));
  Vim.defineEx("tabclose", "tabc", (cm) => close(cm, false));
  Vim.defineEx("tabnext", "tabn", (cm, params) => switchTab(cm, params, 1));
  Vim.defineEx("tabprevious", "tabp", (cm, params) => switchTab(cm, params, -1));
  Vim.defineEx("tabNext", "tabN", (cm, params) => switchTab(cm, params, -1));
  Vim.defineEx("bnext", "bn", (cm, params) => switchTab(cm, params, 1));
  Vim.defineEx("bprevious", "bp", (cm, params) => switchTab(cm, params, -1));
  Vim.defineEx("bNext", "bN", (cm, params) => switchTab(cm, params, -1));
  Vim.defineEx("bdelete", "bd", (cm) => close(cm, false));
  // Obsidian's name, so vimrc lines like `exmap back obcommand …` carry over.
  Vim.defineEx("obcommand", "obcommand", (cm, params) => {
    const id = argument(params);
    if (!id) return notify(cm, "Usage: :obcommand <command id>");
    withHost(cm, "onRunCommand", "obcommand", (run) => {
      if (!run(id)) notify(cm, `No command ${id}`);
    });
  });
}

/** `gt` (next tab, or tab N with a count) and `gT` (back one, or N, tab). */
function mapAppKeys(): void {
  Vim.mapCommand("gt", "action", "ddlSwitchTab", { forward: true }, { context: "normal" });
  Vim.mapCommand("gT", "action", "ddlSwitchTab", { forward: false }, { context: "normal" });
}

function defineAppKeys(): void {
  Vim.defineAction("ddlSwitchTab", (cm, args) => {
    withHost(cm, "onSwitchTab", args.forward ? "tabnext" : "tabprevious", (onSwitchTab) => {
      if (args.forward)
        onSwitchTab(args.repeatIsExplicit ? { index: args.repeat - 1 } : { delta: 1 });
      else onSwitchTab({ delta: -(args.repeat || 1) });
    });
  });
  mapAppKeys();
  // `:mapclear` (and a vimrc change) clears every mapping, including the app's own keys.
  const mapclear = Vim.mapclear.bind(Vim);
  Vim.mapclear = (context?: string) => {
    mapclear(context);
    if (!context || context === "normal") mapAppKeys();
    if (!context) forgetMappings();
  };
}

// ── Clipboard ───────────────────────────────────────────────────────────────────────────────

const clipboard = new SystemClipboard(
  () => (typeof navigator === "undefined" ? undefined : navigator.clipboard),
  async () => {
    try {
      const status = await navigator.permissions.query({
        name: "clipboard-read" as PermissionName,
      });
      return status.state === "granted";
    } catch {
      return false;
    }
  },
);
const clipboardRegister = new ClipboardRegister(clipboard) as unknown as Register;

/** vim.js recreates its registers on `resetVimGlobalState_`, so this is re-checked lazily. */
function ensureClipboardRegisters(): void {
  const { registers } = Vim.getRegisterController();
  if (registers["+"] !== clipboardRegister) registers["+"] = clipboardRegister;
  if (registers["*"] !== clipboardRegister) {
    if (registers["*"]) registers["*"] = clipboardRegister;
    else Vim.defineRegister("*", clipboardRegister);
  }
}

function clipboardMirrorsUnnamed(cm?: VimCM): boolean {
  return mirrorsUnnamed(Vim.getOption("clipboard", cm as EngineCM | undefined));
}

type PasteArgs = { registerName?: string } & Record<string, unknown>;
type Actions = {
  continuePaste(cm: VimCM, args: PasteArgs, vim: unknown, text: string, register: unknown): void;
};

function installClipboard(): void {
  Vim.defineOption("clipboard", "", "string");
  ensureClipboardRegisters();

  // vim.js pastes `+` from an async clipboard read (and throws when it's denied); read the cache
  // instead so `"+p` is synchronous like every other register, and let `clipboard=unnamed` paste
  // what was copied in another app.
  Vim.defineAction("paste", function (this: Actions, cm, args, vim) {
    ensureClipboardRegisters();
    const name = (args as PasteArgs).registerName;
    const controller = Vim.getRegisterController();
    let register: unknown = controller.getRegister(name);
    let text = controller.getRegister(name).toString();
    if ((!name || name === '"') && clipboardMirrorsUnnamed(cm)) {
      const system = clipboard.content;
      if (system.text !== "" && system.text !== text) {
        register = system;
        text = system.text;
      }
    }
    this.continuePaste(cm, args as PasteArgs, vim, text, register);
  });

  // `set clipboard=unnamed(plus)`: whatever goes to the unnamed register also goes to the system.
  const controllerPrototype = Object.getPrototypeOf(Vim.getRegisterController()) as {
    pushText(
      this: ReturnType<typeof Vim.getRegisterController>,
      name: string | null | undefined,
      operator: string,
      text: string,
      linewise?: boolean,
      blockwise?: boolean,
    ): void;
  };
  const pushText = controllerPrototype.pushText;
  controllerPrototype.pushText = function (name, operator, text, linewise, blockwise) {
    pushText.call(this, name, operator, text, linewise, blockwise);
    if ((!name || name === '"') && clipboardMirrorsUnnamed()) {
      clipboard.write({
        text: this.unnamedRegister.toString(),
        linewise: Boolean(linewise),
        blockwise: Boolean(blockwise),
      });
    }
  };

  if (typeof window === "undefined") return;
  const refresh = () => void clipboard.refresh(false);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  for (const type of ["copy", "cut", "paste"] as const) {
    document.addEventListener(type, (event) => {
      const text = event.clipboardData?.getData("text/plain");
      if (type === "paste" && text) clipboard.observe(text);
      // Copy/cut data is only set after the event; read it once it is on the clipboard.
      else setTimeout(refresh);
    });
  }
}

// ── vimrc ───────────────────────────────────────────────────────────────────────────────────

let appliedVimrc = "";
let vimrcExMappings: string[] = [];
/** Values options had before any vimrc changed them, restored when the vimrc changes. */
const optionBaseline = new Map<string, unknown>();

function applyVimrc(cm: VimCM, text: string): VimrcProblem[] {
  const engine = cm as EngineCM;
  Vim.mapclear();
  for (const lhs of vimrcExMappings) Vim.unmap(lhs, "");
  vimrcExMappings = [];
  for (const [name, value] of optionBaseline) Vim.setOption(name, value, engine);

  const { commands, problems } = parseVimrc(text);
  const lastEx = Vim.getRegisterController().getRegister(":");
  const lastExText = lastEx.toString();
  const openNotification = cm.openNotification;
  for (const command of commands) {
    let message: string | null = null;
    cm.openNotification = (template: Node) => {
      message = template.textContent ?? "";
      return () => {};
    };
    try {
      if (command.kind === "exmap") {
        Vim.map(`:${command.name}`, `:${command.command}`, "");
      } else {
        for (const name of optionsSetBy(command.input)) {
          if (!optionBaseline.has(name)) optionBaseline.set(name, Vim.getOption(name));
        }
        Vim.handleEx(engine, command.input);
        const mapping = /^(\w*map|\w*noremap)!?\s+(\S+)/.exec(command.input);
        if (mapping) noteMapping(mapping[2]!, mapping[1]!.startsWith("i") ? "insert" : undefined);
      }
      vimrcExMappings.push(...exMappingsCreatedBy(command));
    } catch (error) {
      message = errorMessage(error);
    } finally {
      cm.openNotification = openNotification;
    }
    if (message !== null) problems.push({ line: command.line, message });
  }
  lastEx.setText(lastExText);
  appliedVimrc = text;
  return problems.sort((a, b) => a.line - b.line);
}

// ── Status ──────────────────────────────────────────────────────────────────────────────────

function modeOf(cm: VimCM): VimModeName {
  const state = cm.state.vim;
  if (!state) return "normal";
  if (state.insertMode) return cm.state.overwrite ? "replace" : "insert";
  if (state.visualMode)
    return state.visualBlock ? "visual-block" : state.visualLine ? "visual-line" : "visual";
  return "normal";
}

/**
 * Vim's "showcmd": the adapter's `status` holds the keys of the command being typed; a register
 * picked with `"x` is its own finished command in vim.js, so it is read from the input state.
 */
function pendingKeys(cm: VimCM): string {
  const state = cm.state.vim;
  if (!state) return "";
  const register = state.inputState.registerName;
  return `${register ? `"${register}` : ""}${state.status ?? ""}`;
}

function statusOf(cm: VimCM): VimStatus {
  const mode = modeOf(cm);
  const macro = Vim.getVimGlobalState_().macroModeState;
  return {
    mode,
    pending: mode === "insert" || mode === "replace" ? "" : pendingKeys(cm),
    recording: macro.isRecording ? (macro.latestRegister ?? null) : null,
  };
}

function sameStatus(a: VimStatus | null, b: VimStatus): boolean {
  return a !== null && a.mode === b.mode && a.pending === b.pending && a.recording === b.recording;
}

/**
 * Reports the vim status of its view to the host and applies the vimrc. Runs after `vim()`'s own
 * plugin, so the adapter's `cm` exists. The adapter's events fire on every keystroke in insert
 * mode, so the report compares three fields and calls the host only when something changed. It
 * waits for the end of the keystroke: vim.js passes through intermediate states (it clears the
 * input state before `"a` stores the register).
 */
const vimStatusPlugin = ViewPlugin.fromClass(
  class {
    private readonly view: EditorView;
    private cm: VimCM | null = null;
    private last: VimStatus | null = null;
    private scheduled = false;
    private readonly onEvent = () => {
      if (this.scheduled) return;
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        this.report();
      });
    };

    constructor(view: EditorView) {
      this.view = view;
      this.attach();
      this.applyVimrc(view.state.facet(vimrcFacet));
      this.report();
    }

    update(update: ViewUpdate) {
      if (getCM(this.view) !== this.cm) this.attach();
      const vimrc = update.state.facet(vimrcFacet);
      if (vimrc !== update.startState.facet(vimrcFacet)) this.applyVimrc(vimrc);
    }

    destroy() {
      this.detach();
      const view = this.view;
      // A state swap recreates the plugin right away; only report "off" when vim really is.
      queueMicrotask(() => {
        if (!getCM(view)) view.state.facet(editorCallbacks).onVimStatus?.(null);
      });
    }

    private attach() {
      this.detach();
      const cm = getCM(this.view);
      if (!cm) return;
      this.cm = cm;
      for (const event of ["vim-mode-change", "vim-keypress", "vim-command-done"])
        cm.on(event, this.onEvent);
    }

    private detach() {
      if (!this.cm) return;
      for (const event of ["vim-mode-change", "vim-keypress", "vim-command-done"]) {
        this.cm.off(event, this.onEvent);
      }
      this.cm = null;
    }

    private applyVimrc(text: string) {
      const cm = this.cm;
      if (!cm || text === appliedVimrc) return;
      const problems = applyVimrc(cm, text);
      this.view.state.facet(editorCallbacks).onVimrcApplied?.(problems);
    }

    private report() {
      if (!this.cm) return;
      const status = statusOf(this.cm);
      if (sameStatus(this.last, status)) return;
      this.last = status;
      this.view.state.facet(editorCallbacks).onVimStatus?.(status);
    }
  },
);

/**
 * Clipboard registers are read when the user names them (`"+`, `"*`, insert-mode `<C-r>`):
 * refresh before the key that uses them arrives. Registered before vim's key handler, which
 * stops the keys it handles.
 */
const clipboardPrefetch = EditorView.domEventHandlers({
  focus: () => {
    void clipboard.refresh(false);
  },
  keydown: (event, view) => {
    const state = getCM(view)?.state.vim;
    if (!state) return false;
    const naming =
      (event.key === "+" || event.key === "*") && state.inputState.keyBuffer.join("").endsWith('"');
    if (naming || (event.key === "r" && event.ctrlKey && state.insertMode)) {
      ensureClipboardRegisters();
      void clipboard.refresh(true);
    }
    return false;
  },
});

// ── Install ─────────────────────────────────────────────────────────────────────────────────

let installed = false;

export function installVimIntegration(): void {
  if (installed) return;
  installed = true;
  defineExCommands();
  defineAppKeys();
  installClipboard();
}

export function vimExtension() {
  return [clipboardPrefetch, vim(), vimStatusPlugin];
}

export function vimClaimsKey(event: KeyboardEvent): boolean {
  if (!(event.target instanceof Element)) return false;
  const root = event.target.closest(".cm-editor");
  const view = root instanceof HTMLElement ? EditorView.findFromDOM(root) : null;
  const cm = view ? getCM(view) : null;
  const state = cm?.state.vim;
  if (!state || state.insertMode) return false;
  const key = Vim.vimKeyFromEvent(event, state);
  return key !== undefined && isVimCtrlKey(key);
}
