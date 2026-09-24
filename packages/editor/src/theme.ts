/**
 * Overrides of CodeMirror's base theme (which a plain stylesheet can't reliably beat) and syntax
 * highlighting. Colors come exclusively from the app's `--ddl-*` CSS variables so light/dark themes
 * switch without reconfiguring the editor. Component styles (`cm-ddl-*`) live in styles.css.
 */
import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { ddlTags } from "./syntax/markdown-extensions";

const READABLE_PADDING = "max(24px, calc((100% - var(--ddl-line-width)) / 2))";

export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--ddl-text)",
    backgroundColor: "var(--ddl-bg)",
    fontSize: "var(--ddl-editor-font-size, 16px)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--ddl-font-editor)",
    lineHeight: "1.6",
  },
  ".cm-content": {
    padding: "16px 24px 30vh",
    caretColor: "var(--ddl-accent)",
  },
  // Percent padding resolves against the scroller, so clicks beside the text column still land
  // inside the content (and place the caret) instead of in an unclickable margin.
  "&.cm-ddl-readable .cm-content": {
    paddingLeft: READABLE_PADDING,
    paddingRight: READABLE_PADDING,
  },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "2px solid var(--ddl-accent)" },
  ".cm-selectionBackground": { backgroundColor: "var(--ddl-bg-hover)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--ddl-accent-soft)",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  "&.cm-focused .cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--ddl-bg-hover) 35%, transparent)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--ddl-bg)",
    color: "var(--ddl-text-faint)",
    border: "none",
    fontFamily: "var(--ddl-font-ui)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 12px", fontSize: "0.8em" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ddl-text-muted)" },
  // Fold arrows appear on hover, like Obsidian.
  ".cm-foldGutter .cm-gutterElement": { opacity: "0", transition: "opacity 0.15s" },
  ".cm-gutters:hover .cm-foldGutter .cm-gutterElement": { opacity: "1" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--ddl-bg-secondary)",
    border: "1px solid var(--ddl-border)",
    borderRadius: "4px",
    color: "var(--ddl-text-muted)",
    padding: "0 6px",
  },
  ".cm-panels": {
    backgroundColor: "var(--ddl-bg-secondary)",
    color: "var(--ddl-text)",
    fontFamily: "var(--ddl-font-ui)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--ddl-border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--ddl-border)" },
  ".cm-textfield": {
    backgroundColor: "var(--ddl-bg)",
    color: "var(--ddl-text)",
    border: "1px solid var(--ddl-border)",
    borderRadius: "4px",
  },
  ".cm-textfield:focus": { outline: "none", borderColor: "var(--ddl-accent)" },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--ddl-bg)",
    color: "var(--ddl-text)",
    border: "1px solid var(--ddl-border)",
    borderRadius: "4px",
  },
  ".cm-button:hover": { backgroundColor: "var(--ddl-bg-hover)" },
  ".cm-search label": { color: "var(--ddl-text-muted)" },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--ddl-warning) 25%, transparent)",
    outline: "none",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--ddl-warning) 55%, transparent)",
  },
  ".cm-specialChar": { color: "var(--ddl-danger)" },
  ".cm-tooltip": {
    backgroundColor: "var(--ddl-bg-secondary)",
    color: "var(--ddl-text)",
    border: "1px solid var(--ddl-border)",
    borderRadius: "6px",
  },
  // Vim block cursor (drawn by @replit/codemirror-vim over the character under the cursor).
  ".cm-fat-cursor": { background: "var(--ddl-accent)", color: "var(--ddl-bg)" },
  "&:not(.cm-focused) .cm-fat-cursor": {
    background: "none",
    outline: "solid 1px var(--ddl-accent)",
  },
  ".cm-vim-panel": { padding: "2px 8px", fontFamily: "var(--ddl-font-mono)" },
  ".cm-vim-panel input": { color: "var(--ddl-text)", fontFamily: "var(--ddl-font-mono)" },
});

export const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "700", color: "var(--ddl-text)" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--ddl-accent)" },
  { tag: tags.url, color: "var(--ddl-text-muted)" },
  { tag: ddlTags.wikiLink, color: "var(--ddl-accent)" },
  { tag: tags.monospace, fontFamily: "var(--ddl-font-mono)", fontSize: "0.9em" },
  { tag: [tags.processingInstruction, tags.contentSeparator], color: "var(--ddl-text-faint)" },
  { tag: tags.quote, color: "var(--ddl-text-muted)" },
  { tag: tags.labelName, color: "var(--ddl-text-muted)" },
  {
    tag: ddlTags.highlight,
    backgroundColor: "color-mix(in srgb, var(--ddl-warning) 30%, transparent)",
    borderRadius: "3px",
  },
  {
    tag: ddlTags.hashtag,
    color: "var(--ddl-accent)",
    backgroundColor: "var(--ddl-accent-soft)",
    borderRadius: "999px",
    padding: "0 0.35em",
  },
  // Fenced code (languages load lazily).
  {
    tag: [tags.keyword, tags.modifier, tags.operatorKeyword, tags.controlKeyword],
    color: "var(--ddl-accent)",
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--ddl-success)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--ddl-warning)" },
  { tag: tags.comment, color: "var(--ddl-text-faint)", fontStyle: "italic" },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--ddl-info)",
  },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--ddl-info)" },
  { tag: [tags.meta, tags.annotation], color: "var(--ddl-text-muted)" },
  { tag: tags.invalid, color: "var(--ddl-danger)" },
]);
