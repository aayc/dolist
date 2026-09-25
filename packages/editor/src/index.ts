export {
  AGENT_SPARKLE_TITLE,
  type AgentLineOptions,
  agentLines,
  buildAgentLineDecorations,
} from "./agent-lines";
export {
  type AnnotationState,
  annotationField,
  getAnnotations,
  HIDDEN_BADGE_STATUSES,
  setAnnotationsEffect,
} from "./annotations/field";
export { editorCallbacks, saveDocument } from "./callbacks";
export {
  insertLink,
  toggleBold,
  toggleHighlight,
  toggleInlineCode,
  toggleItalic,
  toggleStrikethrough,
} from "./commands/formatting";
export {
  continueAlternateTask,
  continueListItem,
  continueMarkup,
  indentListItemOrInsertTab,
} from "./commands/lists";
export { type CommandTarget, toggleChecklist, toggleTaskAtLine } from "./commands/tasks";
export { documentChanges, minimalChange, type TextChange } from "./diff";
export * from "./editor";
export { type DropGeometry, type DropTarget, dropTarget, type LineBox } from "./embeds/drop";
export {
  type EmbedEdit,
  type EmbedMove,
  formatEmbed,
  insertEmbed,
  MIN_EMBED_WIDTH,
  moveEmbed,
  removeEmbed,
  resizeEmbed,
} from "./embeds/edits";
export {
  activateEmbed,
  embedSelection,
  insertEmbedAtCursor,
  type MountedEmbed,
  selectEmbed,
  selectEmbedEffect,
  selectedEmbed,
} from "./embeds/layer";
export { embedAt, embedOfLine } from "./embeds/parse";
export type {
  BlockEmbed,
  EmbedContent,
  EmbedHost,
  EmbedPlacement,
  EmbedRenderer,
  EmbedSpec,
} from "./embeds/types";
export { EmbedWidget } from "./embeds/widget";
export {
  createHeadlessEditorState,
  editorExtensions,
  type HeadlessStateOptions,
} from "./extensions";
export { editorKeymap, markdownEditingKeymap, obsidianKeymap } from "./keymap";
export {
  hostnameOf,
  LinkPopover,
  linkPreviewAt,
  linkPreviews,
  type PopoverAnchor,
  renderLinkPreview,
  webLinkPreview,
} from "./link-preview";
export { findLinkAt, followLinkAtCursor, type LinkTarget, linkAt } from "./links";
export { buildLivePreviewDecorations, type VisibleRange } from "./live-preview/decorations";
export { livePreview, livePreviewEnabled } from "./live-preview/plugin";
export { markdownSupport } from "./syntax/language";
export { ddlTags, splitWikiLink, type WikiLinkParts } from "./syntax/markdown-extensions";
export { editorTheme, markdownHighlightStyle } from "./theme";
export * from "./types";
export { isVimLoaded, preloadVim, vimClaimsKey } from "./vim";
export { parseVimrc, type VimrcCommand } from "./vimrc";
