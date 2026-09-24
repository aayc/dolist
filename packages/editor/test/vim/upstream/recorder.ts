/**
 * Records upstream tests as vector cases. Each test runs against the oracle editor while the
 * recorder captures the keys the engine sees (from the keyboard events upstream's `typeKey`
 * dispatches) and the host API calls between them. A test is recorded only when it passes and
 * only uses serializable API; the generator then replays the recording through the harness and
 * keeps it only if every step reproduces the state observed here.
 */
import type { EditorView } from "@codemirror/view";
import { CodeMirror, getCM, Vim } from "@replit/codemirror-vim";
import {
  type ApiCall,
  type CaseSpec,
  DEFAULT_OPTIONS,
  type EditorOptions,
  type ExpectedState,
  type SelectionRange,
  type StepSpec,
} from "../format";
import { type EditorSpec, messageText, snapshotEditor, type VimCM } from "../harness/harness";
import { createOracleEditor } from "../harness/oracle-editor";
import { testground, type UpstreamOptions, upstreamCodeMirror } from "./runner";

export interface Recording {
  test: string;
  spec: CaseSpec;
  observed: ExpectedState[];
}

export interface RecordingSkip {
  test: string;
  reason: string;
}

type Pos = { line: number; ch: number };

function posArg(pos: Pos): [number, number] {
  return [pos.line, pos.ch];
}

function rangeArg(anchor: Pos, head: Pos): SelectionRange {
  return anchor.line === head.line && anchor.ch === head.ch
    ? [anchor.line, anchor.ch]
    : [anchor.line, anchor.ch, head.line, head.ch];
}

/** The editor options upstream's CM6 runner derives from `testVim` options. */
export function upstreamEditorSpec(options: UpstreamOptions): EditorSpec {
  return {
    doc: options.value,
    tabSize: options.tabSize || options.indentUnit || 4,
    indentUnit: options.indentWithTabs ? "\t" : " ".repeat(options.indentUnit || 2),
  };
}

class TestRecording {
  readonly steps: StepSpec[] = [];
  readonly observed: ExpectedState[] = [];
  unserializable: string | null = null;
  /**
   * `testVim` sets up (mapclear, langmap(''), resetVimGlobalState_) before running the test body;
   * that setup is the README's per-case reset, so recording starts after it.
   */
  started = false;
  private keys: string[] = [];
  private message: string | undefined;
  private scrolled = false;

  readonly test: string;
  readonly spec: EditorSpec;
  readonly view: EditorView;
  readonly cm: VimCM;

  constructor(test: string, spec: EditorSpec, view: EditorView, cm: VimCM) {
    this.test = test;
    this.spec = spec;
    this.view = view;
    this.cm = cm;
  }

  key(token: string): void {
    this.keys.push(token);
  }

  notify(message: string): void {
    this.message = message;
  }

  /** Ends the pending key step (called whenever the test touches the editor from outside). */
  flush(): void {
    if (this.keys.length === 0) return;
    this.steps.push({ keys: this.keys });
    this.keys = [];
    this.snapshot();
  }

  api(call: ApiCall, perform: () => void): void {
    this.flush();
    perform();
    this.steps.push({ api: call });
    this.snapshot();
  }

  fail(reason: string): void {
    this.unserializable ??= reason;
  }

  private snapshot(): void {
    const state = snapshotEditor(this.view, this.cm, {
      prompt: this.promptState(),
      message: this.message,
      viewport: true,
    });
    if (state.scrollTop) this.scrolled = true;
    this.observed.push(state);
    this.message = undefined;
  }

  private promptState(): { prefix: string; text: string } | undefined {
    const dialog = this.cm.state.dialog;
    const input = dialog?.querySelector("input");
    if (!dialog || !input || !dialog.isConnected) return undefined;
    return { prefix: input.parentElement?.textContent ?? "", text: input.value };
  }

  toCase(name: string): Recording {
    const options: EditorOptions = {};
    if (this.spec.tabSize !== DEFAULT_OPTIONS.tabSize) options.tabSize = this.spec.tabSize;
    if (this.spec.indentUnit !== DEFAULT_OPTIONS.indentUnit)
      options.indentUnit = this.spec.indentUnit;
    const spec: CaseSpec = {
      name,
      origin: `upstream:${this.test}`,
      doc: this.spec.doc,
      selection: [[0, 0]],
      ...(Object.keys(options).length > 0 ? { options } : {}),
      ...(this.scrolled ? { scrollTop: 0 } : {}),
      steps: this.steps,
    };
    const observed = this.scrolled
      ? this.observed
      : this.observed.map(({ scrollTop: _scrollTop, ...rest }) => rest);
    return { test: this.test, spec, observed };
  }
}

const UNSERIALIZABLE_OPTIONS: ReadonlyArray<readonly [keyof UpstreamOptions, string]> = [
  ["lineWrapping", "soft-wrapped editor"],
  ["mode", "language mode"],
];

const READS = [
  "getCursor",
  "getValue",
  "listSelections",
  "getLine",
  "getRange",
  "getSelection",
  "getSelections",
  "lineCount",
  "lastLine",
  "somethingSelected",
  "getWrapperElement",
  "getInputField",
  "charCoords",
  "getScrollInfo",
  "defaultTextHeight",
  "getOption",
  "indexFromPos",
  "getMode",
] as const;

export class UpstreamRecorder {
  private current: TestRecording | null = null;
  private inKey = 0;
  private testName = "";
  readonly recordings: Recording[] = [];
  readonly skipped: RecordingSkip[] = [];
  private readonly names = new Map<string, number>();

  /**
   * Engine code runs inside the keyboard events `typeKey` dispatches (including prompt keyup
   * handlers), while the test's own editor calls happen between them. Counting nested
   * `dispatchEvent` calls tells the two apart.
   */
  constructor() {
    document.addEventListener("keydown", this.onKeyDown, true);
    const dispatchEvent = EventTarget.prototype.dispatchEvent;
    const recorder = this;
    EventTarget.prototype.dispatchEvent = function (this: EventTarget, event: Event) {
      const keyboard = event instanceof KeyboardEvent || event.type === "input";
      if (keyboard) recorder.inKey++;
      try {
        return dispatchEvent.call(this, event);
      } finally {
        if (keyboard) recorder.inKey--;
      }
    };
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    const recording = this.current;
    if (!recording) return;
    const target = event.target;
    if (!(target instanceof Node) || !recording.view.dom.contains(target)) return;
    const token = Vim.vimKeyFromEvent(event, recording.cm.state.vim ?? undefined);
    if (token === undefined) {
      recording.fail(`key the engine can't see (key "${event.key}")`);
      return;
    }
    recording.key(token);
  };

  /** The `CodeMirror` object for `vimTests`, with a recording `Vim`. */
  codeMirror() {
    return upstreamCodeMirror((place, options) => this.make(place, options), {
      vim: this.recordingVim(),
      commands: this.recordingCommands(),
      onIsMacSet: () => this.current?.fail("changes CodeMirror.isMac"),
    });
  }

  beforeTest(name: string): void {
    this.testName = name;
    this.current = null;
    this.inKey = 0;
  }

  afterTest(name: string, passed: boolean): void {
    const recording = this.current;
    this.current = null;
    if (!recording) {
      this.skipped.push({ test: name, reason: "no editor" });
      return;
    }
    recording.flush();
    recording.view.destroy();
    if (!passed) {
      this.skipped.push({ test: name, reason: "fails against the oracle editor" });
    } else if (recording.unserializable) {
      this.skipped.push({ test: name, reason: recording.unserializable });
    } else if (recording.steps.length === 0) {
      this.skipped.push({ test: name, reason: "no steps" });
    } else {
      const base = `upstream/${name.replace(/^vim_/, "").replaceAll("/", "<slash>").replaceAll(" ", "<Space>")}`;
      const count = (this.names.get(base) ?? 0) + 1;
      this.names.set(base, count);
      this.recordings.push(recording.toCase(count === 1 ? base : `${base}#${count}`));
    }
  }

  private make(_place: HTMLElement, options: UpstreamOptions): VimCM {
    if (this.current) {
      this.current.fail("creates more than one editor");
      this.current.view.destroy();
    }
    const spec = upstreamEditorSpec(options);
    const editor = createOracleEditor(testground(), spec);
    const cm = getCM(editor.view)!;
    const recording = new TestRecording(this.testName.replace(/^vim_/, ""), spec, editor.view, cm);
    this.current = recording;
    for (const [option, reason] of UNSERIALIZABLE_OPTIONS) {
      if (options[option]) recording.fail(reason);
    }
    // typeKey's text input: the native insertion of README rule 2 (still part of the keypress).
    Object.assign(cm.getInputField(), {
      _handleInputEventForTest: (text: string) => {
        this.inKey++;
        try {
          editor.view.dispatch(editor.view.state.replaceSelection(text), {
            userEvent: "input.type",
          });
        } finally {
          this.inKey--;
        }
      },
    });
    this.instrument(recording);
    return cm;
  }

  private instrument(recording: TestRecording): void {
    const { cm } = recording;
    const outside = () => this.current === recording && recording.started && this.inKey === 0;
    for (const name of READS) {
      const original = cm[name].bind(cm) as (...args: unknown[]) => unknown;
      Object.assign(cm, {
        [name]: (...args: unknown[]) => {
          if (outside()) recording.flush();
          return original(...args);
        },
      });
    }
    const wrap = <A extends unknown[]>(
      name: string,
      toCall: ((...args: A) => ApiCall | string) | null,
    ) => {
      const original = (cm as unknown as Record<string, (...args: A) => unknown>)[name]!.bind(cm);
      Object.assign(cm, {
        [name]: (...args: A) => {
          if (!outside()) return original(...args);
          if (!toCall) return original(...args);
          const call = toCall(...args);
          if (typeof call === "string") {
            recording.fail(call);
            return original(...args);
          }
          let result: unknown;
          recording.api(call, () => {
            result = original(...args);
          });
          return result;
        },
      });
    };
    wrap("setCursor", (line: number | Pos, ch?: number) =>
      typeof line === "object"
        ? { op: "setCursor", args: posArg(line) }
        : { op: "setCursor", args: [line, ch ?? 0] },
    );
    wrap("setSelection", (anchor: Pos, head?: Pos) => ({
      op: "setSelections",
      args: [[rangeArg(anchor, head ?? anchor)]],
    }));
    wrap("setSelections", (ranges: Array<{ anchor: Pos; head: Pos }>, primary?: number) => ({
      op: "setSelections",
      args: [ranges.map((r) => rangeArg(r.anchor, r.head)), primary ?? 0],
    }));
    wrap("setValue", (text: string) => ({ op: "setValue", args: [text] }));
    wrap("replaceRange", (text: string, from: Pos, to?: Pos) => ({
      op: "replaceRange",
      args: to ? [text, posArg(from), posArg(to)] : [text, posArg(from)],
    }));
    wrap("setOption", (name: string, value: unknown) => ({ op: "setOption", args: [name, value] }));
    for (const name of [
      "foldCode",
      "on",
      "operation",
      "replaceSelection",
      "setSize",
      "execCommand",
    ]) {
      wrap(name, () => `calls cm.${name}`);
    }
    const openNotification = cm.openNotification.bind(cm);
    const dialogs: Pick<VimCM, "openDialog" | "openNotification"> = {
      openDialog: cm.openDialog,
      openNotification: (template, options) => {
        recording.notify(messageText(template));
        return openNotification(template, options);
      },
    };
    for (const name of ["openDialog", "openNotification"] as const) {
      Object.defineProperty(cm, name, {
        get: () => dialogs[name],
        set: (next) => {
          recording.fail(`replaces cm.${name}`);
          dialogs[name] = next;
        },
        configurable: true,
      });
    }
  }

  private recordingCommands(): typeof CodeMirror.commands {
    return new Proxy(CodeMirror.commands, {
      set: (target, property, value) => {
        this.current?.fail(`replaces CodeMirror.commands.${String(property)}`);
        return Reflect.set(target, property, value);
      },
    });
  }

  private recordingVim(): typeof Vim {
    const recorder = this;
    const outside = () => recorder.current?.started === true && recorder.inKey === 0;
    const api = (call: ApiCall, perform: () => unknown) => {
      let result: unknown;
      const recording = recorder.current;
      if (!recording || !outside()) return perform();
      recording.api(call, () => {
        result = perform();
      });
      return result;
    };
    const unserializable = new Set([
      "defineOption",
      "defineEx",
      "defineAction",
      "defineMotion",
      "defineOperator",
      "defineRegister",
      "mapCommand",
      "_mapCommand",
      "langmap",
      "exitVisualMode",
      "exitInsertMode",
      "handleKey",
      "multiSelectHandleKey",
      "findKey",
    ]);
    return new Proxy(Vim, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof property !== "string" || typeof value !== "function") return value;
        if (unserializable.has(property)) {
          return (...args: unknown[]) => {
            if (outside()) recorder.current?.fail(`calls Vim.${property}`);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        switch (property) {
          case "map":
          case "noremap":
          case "unmap":
            return (...args: unknown[]) =>
              api({ op: property, args: args.filter((a) => a !== undefined) }, () =>
                (value as (...a: unknown[]) => unknown).apply(target, args),
              );
          case "mapclear":
            return (context?: string) =>
              api({ op: "mapclear", args: context ? [context] : [] }, () =>
                target.mapclear(context),
              );
          case "setOption":
            return (...args: unknown[]) => {
              if (args.length > 2 && outside()) recorder.current?.fail("sets a local vim option");
              return api({ op: "vimSetOption", args: args.slice(0, 2) }, () =>
                (value as (...a: unknown[]) => unknown).apply(target, args),
              );
            };
          case "handleEx":
            return (cm: Parameters<typeof target.handleEx>[0], input: string) =>
              api({ op: "ex", args: [input] }, () => target.handleEx(cm, input));
          case "resetVimGlobalState_":
            return () => {
              const recording = recorder.current;
              if (recording && !recording.started) recording.started = true;
              else if (outside() && (recording?.steps.length ?? 0) > 0) {
                recording?.fail("resets the vim state mid-test");
              }
              target.resetVimGlobalState_();
            };
          case "getRegisterController":
            return () => {
              if (outside()) recorder.current?.flush();
              return recorder.registerController();
            };
          default:
            return (...args: unknown[]) => {
              if (outside()) recorder.current?.flush();
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
        }
      },
    });
  }

  private registerController() {
    const controller = Vim.getRegisterController();
    const outside = () => this.current?.started === true && this.inKey === 0;
    const record = (call: ApiCall, perform: () => unknown) => {
      const recording = this.current;
      if (!recording || !outside()) return perform();
      let result: unknown;
      recording.api(call, () => {
        result = perform();
      });
      return result;
    };
    return new Proxy(controller, {
      get: (target, property, receiver) => {
        if (property === "pushText") {
          return (
            name: string | null | undefined,
            operator: string,
            text: string,
            linewise?: boolean,
            blockwise?: boolean,
          ) =>
            record(
              {
                op: "pushText",
                args: [name ?? null, operator, text, linewise ?? false, blockwise ?? false],
              },
              () => target.pushText(name, operator, text, linewise, blockwise),
            );
        }
        if (property === "getRegister") {
          return (name?: string) => {
            const register = target.getRegister(name);
            return new Proxy(register, {
              get: (reg, key, rec) => {
                if (key === "setText") {
                  return (text?: string, linewise?: boolean, blockwise?: boolean) =>
                    record(
                      {
                        op: "setRegister",
                        args: [name ?? '"', text ?? "", linewise ?? false, blockwise ?? false],
                      },
                      () => reg.setText(text, linewise, blockwise),
                    );
                }
                if (outside()) this.current?.flush();
                const value = Reflect.get(reg, key, rec);
                return typeof value === "function" ? value.bind(reg) : value;
              },
            });
          };
        }
        if (outside()) this.current?.flush();
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}
