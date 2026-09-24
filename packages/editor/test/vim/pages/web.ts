/**
 * Page entry for the Daily Do List editor: vim.js's own suite against it, and the vector replay.
 * Vim is loaded the way the app loads it (`preloadVim`), with the app's global ex commands and
 * registers installed.
 */
import { getCM } from "@replit/codemirror-vim";
import editorStyles from "../../../src/styles.css";
import type { MarkdownEditor } from "../../../src/types";
import { preloadVim } from "../../../src/vim";
import { caseSpecOf, type VectorCase } from "../format";
import { VimHarness } from "../harness/harness";
import { createWebHarnessEditor, WEB_GEOMETRY_CSS, webEditor } from "../harness/web-editor";
import { upstreamEditorSpec } from "../upstream/recorder";
import {
  runUpstreamSuite,
  testground,
  type UpstreamOptions,
  type UpstreamResult,
  upstreamCodeMirror,
} from "../upstream/runner";

export interface ReplayMismatch {
  name: string;
  step: number;
  expected: unknown;
  actual: unknown;
}

export interface ReplayRun {
  passed: number;
  mismatches: ReplayMismatch[];
  errors: Array<{ name: string; error: string }>;
}

declare global {
  interface Window {
    __vimWeb: {
      runUpstream(): Promise<UpstreamResult[]>;
      replay(vectors: VectorCase[]): Promise<ReplayRun>;
    };
  }
}

const style = document.createElement("style");
style.textContent = `${editorStyles}\n${WEB_GEOMETRY_CSS}`;
document.head.appendChild(style);

const root = document.getElementById("root")!;
root.classList.add("vim-geometry");

let lastEditor: MarkdownEditor | null = null;

function makeUpstream(_place: HTMLElement, options: UpstreamOptions) {
  lastEditor?.destroy();
  const editor = webEditor(testground(), upstreamEditorSpec(options));
  lastEditor = editor;
  const cm = getCM(editor.view)!;
  Object.assign(cm.getInputField(), {
    _handleInputEventForTest: (text: string) => cm.replaceSelection(text),
  });
  cm.setSize(420, 300);
  cm.refresh();
  return cm;
}

let harness: VimHarness | null = null;

window.__vimWeb = {
  async runUpstream() {
    await preloadVim();
    // Tests size the editor themselves (`cm.setSize`); only fonts and padding are pinned.
    testground().classList.add("vim-font");
    return runUpstreamSuite(upstreamCodeMirror(makeUpstream), {
      after: () => {
        lastEditor?.destroy();
        lastEditor = null;
      },
    });
  },
  async replay(vectors) {
    await preloadVim();
    harness ??= new VimHarness((spec) => createWebHarnessEditor(root, spec));
    const run: ReplayRun = { passed: 0, mismatches: [], errors: [] };
    for (const vector of vectors) {
      try {
        const actual = harness.run(caseSpecOf(vector));
        const step = vector.steps.findIndex(
          (s, i) => JSON.stringify(s.expect) !== JSON.stringify(actual.steps[i]?.expect),
        );
        if (step === -1) run.passed++;
        else {
          run.mismatches.push({
            name: vector.name,
            step,
            expected: vector.steps[step]?.expect,
            actual: actual.steps[step]?.expect,
          });
        }
      } catch (error) {
        run.errors.push({
          name: vector.name,
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
      }
    }
    return run;
  },
};
