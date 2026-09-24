/**
 * Page entry for vim.js's own suite against plain CodeMirror 6, built exactly like upstream's CM6
 * runner (`basicSetup`, JavaScript/XML modes, `indentWithTab`, a 420×300 editor).
 */
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { xml } from "@codemirror/lang-xml";
import { indentUnit } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { CodeMirror, getCM, vim } from "@replit/codemirror-vim";
import { basicSetup } from "codemirror";
import type { VimCM } from "../harness/harness";
import {
  runUpstreamSuite,
  testground,
  type UpstreamOptions,
  type UpstreamResult,
  upstreamCodeMirror,
} from "../upstream/runner";

declare global {
  interface Window {
    __vimUpstream: { run(): Promise<UpstreamResult[]> };
  }
}

let lastView: EditorView | null = null;

function make(_place: HTMLElement, options: UpstreamOptions): VimCM {
  lastView?.destroy();
  const extensions: Extension[] = [
    vim({}),
    basicSetup,
    options.mode === "xml" ? xml() : javascript(),
    EditorState.tabSize.of(options.tabSize || options.indentUnit || 4),
    indentUnit.of(options.indentWithTabs ? "\t" : " ".repeat(options.indentUnit || 2)),
    keymap.of([indentWithTab]),
  ];
  if (options.lineWrapping) extensions.push(EditorView.lineWrapping);
  const view = new EditorView({ doc: options.value, extensions, parent: testground() });
  lastView = view;
  const cm = getCM(view)!;
  Object.assign(cm.getInputField(), {
    _handleInputEventForTest: (text: string) => cm.replaceSelection(text),
  });
  view.dom.style.backgroundColor = "white";
  cm.setSize(420, 300);
  cm.refresh();
  return cm;
}

// Upstream's runner works around CM6 not indenting after an unclosed bracket.
CodeMirror.commands.newlineAndIndent = (cm) => {
  const cursor = cm.getCursor();
  const before = cm.getLine(cursor.line).slice(0, cursor.ch);
  let indent = /^\s*/.exec(before)?.[0] ?? "";
  if (/[{[(]$/.test(before)) {
    indent += cm.getOption("indentWithTabs")
      ? "\t"
      : " ".repeat(Number(cm.getOption("indentUnit")));
  }
  cm.replaceSelection(`\n${indent}`);
};

window.__vimUpstream = {
  run: () =>
    runUpstreamSuite(upstreamCodeMirror(make), {
      after: () => {
        lastView?.destroy();
        lastView = null;
      },
    }),
};
