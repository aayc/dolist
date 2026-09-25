import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
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
 *
 * HTML in a note stays plain markdown `HTMLBlock`/`HTMLTag` nodes: our patch of lang-markdown
 * (`patches/`) mounts lang-html only when `htmlTagLanguage` is given, which keeps it (and the CSS
 * and JS parsers it embeds, ~60 kB gz) off the startup path, and typing HTML inserts exactly what
 * was typed, as in Obsidian.
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
