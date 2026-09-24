/**
 * Runs vim.js's own test suite (`vimTests`) in the page against a given CodeMirror factory, the
 * way upstream's CM6 runner (packages/codemirror-vim/test/webtest-vim.js) does.
 */
import { CodeMirror, Vim } from "@replit/codemirror-vim";
import { vimTests } from "@replit/codemirror-vim-core/test/vim_test.js";
import { ORACLE_FONT_STACK, type VimCM } from "../harness/harness";

/** The options `testVim` passes to the factory. */
export interface UpstreamOptions {
  value: string;
  lineNumbers?: boolean;
  lineWrapping?: boolean;
  indentWithTabs?: boolean;
  indentUnit?: number;
  tabSize?: number;
  mode?: string;
  [key: string]: unknown;
}

export type EditorMaker = (place: HTMLElement, options: UpstreamOptions) => VimCM;

export interface UpstreamResult {
  name: string;
  status: "pass" | "fail" | "skip";
  error?: string;
}

/** Tests upstream's own CM6 runner disables. */
export const UPSTREAM_DISABLED: Readonly<Record<string, string>> = {
  vim_ex_set_filetype: "disabled upstream: CM6 has no mode option",
  vim_ex_set_filetype_null: "disabled upstream: CM6 has no mode option",
  vim_zb_to_bottom: "disabled upstream: depends on CM5 scroll metrics",
  vim_zt_to_top: "disabled upstream: depends on CM5 scroll metrics",
  "vim_zb<zz": "disabled upstream: depends on CM5 scroll metrics",
};

const TEST_TIMEOUT_MS = 5000;

/**
 * Integer line heights and the generated oracle font keep the pixel-based page motions
 * (`page_motions`, `HML`) independent of the machine's fonts.
 */
const GEOMETRY_STYLE = `#testground .cm-scroller { font-family: ${ORACLE_FONT_STACK}; font-size: 16px; line-height: 20px; }`;

export function testground(): HTMLElement {
  let root = document.getElementById("testground");
  if (!root) {
    const style = document.createElement("style");
    style.textContent = GEOMETRY_STYLE;
    document.head.appendChild(style);
    root = document.createElement("div");
    root.id = "testground";
    Object.assign(root.style, {
      height: "300px",
      position: "fixed",
      top: "100px",
      right: "100px",
      width: "500px",
    });
    document.body.appendChild(root);
  }
  return root;
}

/**
 * The `CodeMirror` object vim_test.js expects: a factory plus the statics it reads. `vim` wraps
 * `Vim` (the recorder observes calls through it).
 */
export function upstreamCodeMirror(
  make: EditorMaker,
  statics: {
    vim?: typeof Vim;
    commands?: typeof CodeMirror.commands;
    onIsMacSet?: () => void;
  } = {},
) {
  const factory = (place: HTMLElement, options: UpstreamOptions) => make(place, options);
  // The tests call `new Pos(line, ch)`, so this must be a constructible function.
  const Pos = function Pos(line: number, ch: number) {
    return new CodeMirror.Pos(line, ch);
  };
  const codeMirror = Object.assign(factory, {
    Vim: statics.vim ?? Vim,
    Pos,
    commands: statics.commands ?? CodeMirror.commands,
    on: CodeMirror.on,
    off: CodeMirror.off,
    defineMode: () => {},
  });
  Object.defineProperty(codeMirror, "isMac", {
    get: () => CodeMirror.isMac,
    set: (value: boolean) => {
      statics.onIsMacSet?.();
      CodeMirror.isMac = value;
    },
    configurable: true,
  });
  return codeMirror as typeof codeMirror & { isMac: boolean };
}

function withTimeout(run: () => unknown): Promise<unknown> {
  return Promise.race([
    Promise.resolve().then(run),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${TEST_TIMEOUT_MS}ms`)), TEST_TIMEOUT_MS),
    ),
  ]);
}

export interface RunHooks {
  before?: (name: string) => void;
  after?: (name: string, passed: boolean) => void;
  /** Tests not to run (reason shown as the skip reason). */
  skip?: Readonly<Record<string, string>>;
}

export async function runUpstreamSuite(
  codeMirror: ReturnType<typeof upstreamCodeMirror>,
  hooks: RunHooks = {},
): Promise<UpstreamResult[]> {
  testground();
  const tests: Array<{ name: string; fn: () => unknown }> = [];
  vimTests(codeMirror, (name, fn) => {
    tests.push({ name, fn });
  });
  // Upstream's runner (Linux CI) sees a non-Mac platform; the suite depends on it.
  const isMac = CodeMirror.isMac;
  CodeMirror.isMac = false;
  const results: UpstreamResult[] = [];
  try {
    for (const { name, fn } of tests) {
      const skipped = hooks.skip?.[name] ?? UPSTREAM_DISABLED[name];
      if (skipped) {
        results.push({ name, status: "skip", error: skipped });
        continue;
      }
      hooks.before?.(name);
      try {
        await withTimeout(fn);
        results.push({ name, status: "pass" });
        hooks.after?.(name, true);
      } catch (error) {
        results.push({
          name,
          status: "fail",
          error: error instanceof Error ? error.message : String(error),
        });
        hooks.after?.(name, false);
      }
    }
  } finally {
    CodeMirror.isMac = isMac;
  }
  return results;
}
