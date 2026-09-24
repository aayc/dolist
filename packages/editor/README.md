# @ddl/editor

Framework-agnostic CodeMirror 6 markdown editor for Daily Do List: Obsidian-style live preview,
task checkboxes, vim mode and agent status badges on task lines. The web app wraps it in a React
component; the desktop/mobile shells reuse the web app unchanged.

```ts
import { createMarkdownEditor } from "@ddl/editor";
import "@ddl/editor/styles.css";

const editor = createMarkdownEditor(element, {
  doc: markdown,
  config: { vimMode: true },
  callbacks: {
    onDocChange: (doc, { userEvent }) => userEvent && scheduleSave(doc),
    onAnnotationClick: (annotation) => openThread(annotation.threadId),
    onWikiLinkClick: (target, { newPane, subpath }) => openNote(target, { newPane, subpath }),
    onExternalLinkClick: (url) => window.open(url, "_blank", "noopener"),
    onCursorLine: (line) => sendPresence(line), // throttle in the host
    onSave: () => saveNow(),
  },
});

editor.setAnnotations([
  { id: "t1", line: 4, status: "working", label: "Researching…", unread: 0, threadId: "th1" },
]);
```

The contract (`MarkdownEditor`, `EditorConfig`, `EditorCallbacks`, `LineAnnotation`) lives in
[`src/types.ts`](src/types.ts).

## Features

**Live preview** (`livePreview`, on by default). Decorations are computed from the syntax tree for
the visible ranges only. Syntax is revealed while the selection touches it, and nothing is revealed
while the editor is unfocused:

- inline syntax (`**bold**`, `*italic*`, `~~strike~~`, `==highlight==`, `` `code` ``, links,
  wikilinks, `\` escapes) is revealed per element, so the rest of the line stays rendered;
- block syntax (heading `#`, quote `>`, horizontal rules) is revealed on the active line;
- bullets and task checkboxes are revealed only when the caret touches the marker itself, so the
  checkbox stays rendered while you type the task text.

Headings get size classes, quotes a left border, fenced code a background (the fences stay visible
but faint), `[text](url)` shows its text, `[[target|alias]]` its alias, `---` a rule, and YAML
frontmatter is styled as metadata instead of a rule plus a heading. Images stay as source.

**Tasks.** `- [ ]` renders as a checkbox (`role="checkbox"`); clicking toggles `[ ]` ↔ `[x]` with
user event `input.toggle` (never in read-only mode). Completed tasks are muted and struck through.
Obsidian's alternate statuses (`[/]` in progress, `[-]` cancelled, `[>]` deferred) are parsed as
tasks, like `parseTasks` in `@ddl/core`. Enter on a task line (any status) starts `- [ ] `; Enter on
an empty item ends the list.

**Agent badges.** `setAnnotations()` replaces the set of badges. Each badge shows a status dot or
icon (pulsing for `triaging`/`working`), a truncated label and an unread count, and gives the line
a faint status-colored marker. Click, Enter or Space calls `onAnnotationClick`. `idle` and `ignored`
annotations are not rendered.

Badges stay attached while the user edits. Each badge is anchored to the start of its line and drawn
at the end of whichever line holds that anchor. That way, pressing Enter at the end of a task leaves
the badge on the task (not on the new empty task), Enter at its start moves the badge down with the
task, and splitting, indenting, moving or joining lines keep it with the task text (also for the
neighbour a moved line swaps with, and when a replacement at the line start inserts a line break). A
badge is dropped when a single change removes its line's whole content (delete line, vim `dd`, cut,
select + retype) unless that change inserts the exact same line again (moving lines, undoing a move,
an external reorder). `getAnnotations(state)` returns the annotations with their lines mapped.

**Obsidian syntax** as `@lezer/markdown` extensions, so none of it is ever detected inside code:
`[[target]]`, `[[target#heading|alias]]`, `![[embed]]`, `#tags` (not `#123`, not mid-word),
`==highlight==`. Indented code blocks are disabled so an indented task always stays a task
(`@ddl/core` has no notion of indented code either).

**Indentation** uses tabs displayed 4 columns wide, which is Obsidian's default ("Indent using
tabs") and what `@ddl/core` expects. Tab indents list items (anywhere on the line) and otherwise
inserts a tab; Shift-Tab outdents. Escape then Tab moves focus out of the editor.

**Auto-pairing** closes `(`, `[` and `{` (typing the closing bracket steps over it) and never quotes.
Inside HTML blocks and tags, what is typed is inserted literally: no auto-closed tags, no paired
quotes (lang-markdown mounts lang-html, whose input rules would turn `<div>x</div>` into
`<div>x</div></div>`).

**Vim** (`vimMode`) via `@replit/codemirror-vim`, always the first extension so it sees keys before
any keymap. `:w` calls `onSave`. The block cursor uses the accent color. The module loads lazily;
toggling vim before it arrives settles on the latest setting, and a failed load is retried the next
time vim is enabled (`preloadVim()` rejects so hosts can report it).

**Links.** A plain click follows a rendered (not currently edited) link. Mod-click follows any link,
also in source mode. Mod-click and middle-click open wikilinks in a new pane. External URLs are
passed on only for `http(s)`, `mailto` and `tel`; `javascript:`, `data:`, `file:` and other schemes
are never passed to the host. Scheme-less destinations (`[x](Daily/2026-06-19.md#Tasks)`) are note
links, as in Obsidian.

### Keyboard

| Keys | Command |
| --- | --- |
| Mod-b / Mod-i | `toggleBold` / `toggleItalic` (selection or word at the caret) |
| Mod-k | `insertLink` |
| Mod-l, Mod-Enter | `toggleChecklist`: text → `- [ ] text`, list item → task, `[ ]` ↔ `[x]` |
| Mod-s (and vim `:w`) | `saveDocument` → `onSave` (always prevents the browser's save dialog) |
| Alt-Enter | `followLinkAtCursor`, or open the agent thread of the caret's line |
| Enter / Backspace | continue lists and tasks / delete list markup |
| Tab / Shift-Tab | indent / outdent list items |
| Mod-f | search panel (plus CodeMirror's default and history keymaps) |

Mod-e is deliberately unbound so the host can use it (for example to toggle reading view).

## API notes

- `setDocument(doc)` applies external changes as one minimal replacement (common prefix/suffix,
  aligned to line starts for whole-line insertions/deletions), so the selection, scroll position and
  badges survive; a caret at the start of a line that gets lines inserted above it stays on its
  line. External changes are not added to the undo history (local history is mapped through them),
  and `onDocChange` reports them with `userEvent: false`.
  `setDocument(doc, { resetHistory: true })` starts a fresh state with the current config (no
  history, no badges).
- `createState` / `getState` / `setState` support caching one state per open note (instant switching
  with per-note undo). `setState` re-applies the current config and callbacks and clears badges (the
  host re-sends them). States from other editor instances work too; a plain `EditorState` keeps only
  its document and selection.
- `onDocChange` fires once per view update. `userEvent` is true for `input.*` (typing, paste,
  `input.toggle`, formatting), `delete.*`, `move.*`, `undo` and `redo`; vim edits count as input.
- `onWikiLinkClick(target, { newPane, subpath })`: `target` never includes the `#subpath` or the
  alias (same meaning as `WikiLink.target` in `@ddl/core`).
- `scrollToLine(line)` moves the caret to the line and centers it.

Additions to the contract: `EditorCallbacks.onWikiLinkClick` options gained an optional `subpath`.
Additional exports:

- state and tests: `createHeadlessEditorState`, `editorExtensions`;
- annotations: `annotationField`, `setAnnotationsEffect`, `getAnnotations`,
  `HIDDEN_BADGE_STATUSES`;
- commands: `toggleTaskAtLine`, `toggleChecklist`, the formatting and list commands (including
  `continueAlternateTask`), `saveDocument`, `followLinkAtCursor`;
- links: `findLinkAt`;
- live preview: `buildLivePreviewDecorations`, `livePreview`;
- building blocks: `markdownSupport`, `ddlTags`, `splitWikiLink`, `editorTheme`,
  `markdownHighlightStyle`, `editorKeymap`, `minimalChange`.

## Theming

The editor uses only these app-defined variables: `--ddl-bg`, `--ddl-bg-secondary`,
`--ddl-bg-hover`, `--ddl-border`, `--ddl-text`, `--ddl-text-muted`, `--ddl-text-faint`,
`--ddl-accent`, `--ddl-accent-soft`, `--ddl-success`, `--ddl-warning`, `--ddl-danger`,
`--ddl-info`, `--ddl-font-ui`, `--ddl-font-editor`, `--ddl-font-mono`, `--ddl-editor-font-size`
(set per editor from `config.fontSize`) and `--ddl-line-width` (readable line length).

CodeMirror base-theme overrides are in [`src/theme.ts`](src/theme.ts); component styles are in
[`src/styles.css`](src/styles.css). Every class is prefixed `cm-ddl-`: `cm-ddl-editor`,
`cm-ddl-live-preview`, `cm-ddl-readable`, `cm-ddl-h1`…`h6`, `cm-ddl-quote`, `cm-ddl-codeblock`,
`cm-ddl-task-done`, `cm-ddl-checkbox`, `cm-ddl-bullet`, `cm-ddl-hr`, `cm-ddl-link`,
`cm-ddl-wikilink`, `cm-ddl-badge` (+ `cm-ddl-badge-<status>`), `cm-ddl-annotated-<status>`.

## Performance

The keystroke path is O(visible lines + badges):

- Live preview decorations come from one syntax-tree pass over `view.visibleRanges`, using shared
  decoration instances and cached widgets. Widgets implement `eq`/`updateDOM`, so unchanged
  checkboxes and badges are never re-rendered.
- Badges are an ordered array of anchors, mapped with `ChangeSet.mapPos` (O(badges) per change).
  Pure insertions (typing) skip the line-deletion check.
- Obsidian syntax is parsed incrementally by lezer, not with regexes over lines.
- Configuration changes use compartments. The language, theme, keymaps and fields are created once
  and shared by every state.
- `onDocChange` builds the document string (`doc.toString()`, O(document) but only tens of
  microseconds for 2k lines) only when a handler is registered.

Measured on an Apple-silicon laptop (`pnpm --filter @ddl/editor bench`; budgets are p99 and scale
with `BENCH_BUDGET_MULTIPLIER`):

| Benchmark (2k-line note) | mean | p99 | budget |
| --- | --- | --- | --- |
| 500 single-character inserts with 30 badges (state level) | 124 ms (0.25 ms/key) | 163 ms | 500 ms |
| live preview, 60-line viewport | 0.07 ms | 0.11 ms | 2 ms |
| live preview, 150-line viewport | 0.16 ms | 0.27 ms | 4 ms |

In Chromium, on a 2k-line note with badges, a keystroke's synchronous work (transaction, live
preview, DOM update) measured p50 1.7 ms / p95 1.9 ms, and keystroke to the next frame p95 9.3 ms,
with no long tasks. The live-preview builder accounted for about 4 µs per keystroke in a CPU profile.

About 90% of the state-level cost is lezer's incremental markdown parse: stock GFM costs 216 µs
per keystroke, this language 225 µs, and the full editor state with 30 badges 241 µs. While a
fenced-code language chunk is still loading, lezer skips those blocks and re-parses around them on
every change (roughly 10x slower). CodeMirror re-parses once the chunk arrives, so this only lasts
for the first moments after opening a note with code blocks.

## Development

Property tests (`*.property.test.ts`, fast-check via `@fast-check/vitest`) share generators in
[`src/test-arbitraries.ts`](src/test-arbitraries.ts): random Obsidian-flavoured markdown,
selections and CodeMirror-shaped viewports. Reproduce a failure with `FC_SEED=<seed>`, sweep deeper
with `FC_NUM_RUNS=2000`.

```sh
pnpm --filter @ddl/editor typecheck
pnpm --filter @ddl/editor test          # vitest (DOM tests run in happy-dom)
pnpm --filter @ddl/editor bench         # vitest bench, writes bench-results.json
pnpm exec biome check --write packages/editor
```

## Limitations / TODO

- No hanging indent for wrapped list items yet (wrapped lines start at the line's left edge).
- Tables and images are shown as source; callouts (`> [!note]`) render as plain quotes.
- Ordered-list continuation of tasks (`1. [ ] a` + Enter) doesn't add a checkbox, nor does Enter
  on a task with an alternate status inside a blockquote (`> - [/] a`); items after an inserted one
  are not renumbered by the tab-indentation Enter fallback.
- Backspace right after the marker of a top-level item indented with a tab (`\t- |a`) deletes one
  character instead of the list markup.
- With line numbers and readable line length on, the gutter stays at the left edge of the editor.
- The `@codemirror/language-data` descriptions and vim are bundled eagerly; languages load lazily.
