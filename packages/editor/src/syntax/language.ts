import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { type EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  AlternateTaskSyntax,
  DisableIndentedCode,
  HashtagSyntax,
  HighlightSyntax,
  WikiLinkSyntax,
} from "./markdown-extensions";

/**
 * GFM markdown plus the Obsidian extensions. Fenced-code languages come from
 * `@codemirror/language-data` and are only loaded (dynamic import) when a block uses them.
 * Created once so every editor state shares the same language and parser instances.
 */
export const markdownSupport = markdown({
  base: markdownLanguage,
  codeLanguages: languages,
  addKeymap: false,
  completeHTMLTags: false,
  extensions: [
    DisableIndentedCode,
    AlternateTaskSyntax,
    WikiLinkSyntax,
    HighlightSyntax,
    HashtagSyntax,
  ],
});

/** Auto-pair brackets like Obsidian, but never quotes (apostrophes are common in prose). */
export const markdownLanguageData = markdownSupport.language.data.of({
  closeBrackets: { brackets: ["(", "[", "{"] },
});

const HTML_NODES = new Set(["HTMLBlock", "HTMLTag"]);
const HTML_INPUT_RULE_CHARS = new Set([">", "/", '"', "'"]);

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

function inHtml(state: EditorState, pos: number): boolean {
  // `resolve` (not `resolveInner`) stays in the markdown tree instead of entering mounted HTML.
  let node: SyntaxNode | null = syntaxTree(state).resolve(pos, -1);
  for (; node; node = node.parent) if (HTML_NODES.has(node.name)) return true;
  return false;
}

/**
 * lang-markdown mounts lang-html in HTML blocks and tags, and with it HTML's input rules: `>` and
 * `</` insert closing tags, quotes are paired. Like Obsidian, insert exactly what was typed there
 * (otherwise typing `<div>x</div>` yields `<div>x</div></div>`).
 */
export const literalHtmlTyping = Prec.highest(
  EditorView.inputHandler.of((view, from, _to, text, insert) => {
    if (view.composing || !HTML_INPUT_RULE_CHARS.has(text) || !inHtml(view.state, from)) {
      return false;
    }
    view.dispatch(insert());
    return true;
  }),
);
