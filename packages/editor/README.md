# @ddl/editor

Framework-agnostic CodeMirror 6 markdown editor for Daily Do List: Obsidian-style live preview,
task checkboxes, vim mode, agent status badges on task lines (and on lines a thread is anchored
to), chips saying what the orchestrator is doing about a line, text the agent wrote drawn as agent
text, link previews, and `![[…]]` embeds (drawings) that float with the text wrapping around them.
The web app wraps it in a React component.

```ts
import { createMarkdownEditor } from "@ddl/editor";
import "@ddl/editor/styles.css";

const editor = createMarkdownEditor(element, {
  doc: markdown,
  config: { vimMode: true },
  callbacks: {
    onDocChange: (doc, { userEvent }) => userEvent && scheduleSave(doc),
    onAnnotationClick: (annotation) => openThread(annotation.threadId),
    onAgentLineClick: (threadId) => openThread(threadId),
    onWikiLinkClick: (target, { newPane, subpath }) => openNote(target, { newPane, subpath }),
    onExternalLinkClick: (url) => window.open(url, "_blank", "noopener"),
    onLinkPreview: ({ link, label, threadId }) => previewFor(link, label, threadId),
    onCursorLine: (line) => sendPresence(line), // throttle in the host
    onSave: () => saveNow(),
  },
});

editor.setAnnotations([
  { id: "t1", line: 4, status: "working", label: "Researching…", unread: 0, threadId: "th1" },
  { id: "anc_1", line: 7, status: "done", label: "Done", unread: 1, threadId: "th2", lineAnchor: true },
]);
```

The contract (`MarkdownEditor`, `EditorConfig`, `EditorCallbacks`, `LineAnnotation`,
`ActivityChip`) lives in [`src/types.ts`](src/types.ts); the building blocks, pure edits and test
helpers are exported from [`src/index.ts`](src/index.ts).

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
Obsidian's alternate statuses (`[/]`, `[-]`, `[>]`) are tasks, like `parseTasks` in `@ddl/core`.
Enter on a task line starts `- [ ] `; Enter on an empty item ends the list.

**Agent badges.** `setAnnotations()` replaces the set of badges: a status dot, a truncated label
and, with unread messages, an accent dot (the count is in the tooltip and accessible name). Only
`waiting_approval` and `waiting_user` are loud (warning tint and border), `failed` is tinted,
`triaging`, `queued` and `working` are neutral pills, `done`/`cancelled` quiet text; `idle` and
`ignored` aren't drawn. The line gets a faint marker, colored only when the task needs the user or
failed. Click, Enter or Space calls `onAnnotationClick`. An annotation with `lineAnchor: true`
(a thread attached to prose or a heading) also gives its line a soft accent band and a 2px bar
(`cm-ddl-anchored`). Motion is CSS-only, paint-only and off under `prefers-reduced-motion`: a new
badge fades in, a new status pops once, the `triaging` dot pulses; badges update their DOM in
place, so typing never replays the entrance.

Badges stay attached while the user edits. Each is anchored to the start of its line and drawn at
the end of whichever line holds that anchor: Enter at the end of a task leaves the badge on the
task, Enter at its start moves it down with the task, and splitting, indenting, moving or joining
lines keep it with the task text. A badge is dropped when a single change removes its line's whole
content (delete line, vim `dd`, cut, select + retype) unless that change inserts the exact same line
again (moving lines, undo, an external reorder). `getAnnotations(state)` returns them with their
lines mapped.

**Activity chips.** `setActivityChips()` replaces the chips (`ActivityChip`: `id`, `line`, `label`,
`tooltip`, `tone`, `pulse`, `fading`, `kind`); the host decides the wording and when a chip fades
(the web app's README has the shared rules). A chip is drawn after the line's badge with the
badge's look: an empty label is a quiet dot, `fading` fades it out (600 ms). Click, Enter or Space
calls `onActivityChipClick`. Like badges, chips are anchored to their line's start and mapped
through every edit; unlike badges, a chip is dropped as soon as an edit leaves the line
unrecognizable (`isSameLineEdited` in `@ddl/core`: a prefix while typing, or Dice similarity ≥ 0.5)
or deletes it. `getActivityChips(state)` returns them with their lines mapped.

**Agent text.** A line the agent wrote ends with an Obsidian comment naming its thread,
`%%agent:thr_1%%` (see `markdown/agent-text.ts` in `@ddl/core`), and is drawn in the agent text
color (`cm-ddl-agent-line`) in both modes. The live preview hides the marker behind a ✦: clicking
it calls `onAgentLineClick(threadId)`. The marker is revealed faintly while the selection is on
the line and always in source mode. Text typed at or after the marker goes in front of it, so it
stays last; the user deletes the marker to make the line theirs. Alt-Enter on an agent line
without a badge opens its thread.

**Hover and tooltips.** Clickable widgets (badges, the ✦, checkboxes, links, fold markers) show a
pointer, hover and pressed states, and a hit target at least 24px tall that never covers text a
click should put the caret in. They name themselves with `data-tooltip` (never `title`) for the
host's tooltip layer; checkboxes have none.

**Link previews.** Resting on a link for 300 ms shows a card (`LinkPopover`) with what
`onLinkPreview({ link, label, threadId })` returns (`threadId`: the thread named by the line's agent
marker, so the host can describe a URL with the sources that thread cites). Without an answer,
web links show their label, host and URL, and note links nothing. The editor never fetches a link.

**Obsidian syntax** as `@lezer/markdown` extensions, so none of it is ever detected inside code:
`[[target]]`, `[[target#heading|alias]]`, `![[embed]]`, `#tags` (not `#123`, not mid-word),
`==highlight==`. Indented code blocks are disabled so an indented task always stays a task
(`@ddl/core` has no notion of indented code either).

**Indentation** uses tabs displayed 4 columns wide (Obsidian's default, and what `@ddl/core`
expects). Tab indents list items (anywhere on the line) and otherwise inserts a tab; Shift-Tab
outdents. Escape then Tab moves focus out of the editor.

**Auto-pairing** closes `(`, `[` and `{` (typing the closing bracket steps over it) and never
quotes. Inside HTML blocks and tags, text is inserted literally (lang-html's input rules would turn
`<div>x</div>` into `<div>x</div></div>`).

**Links.** A plain click follows a rendered link; Mod-click follows any link, also in source mode.
Mod-click and middle-click open wikilinks in a new pane. External URLs are passed on only for
`http(s)`, `mailto` and `tel`; other schemes never reach the host. Scheme-less destinations
(`[x](Daily/2026-06-19.md#Tasks)`) are note links, as in Obsidian.

### Keyboard

| Keys | Command |
| --- | --- |
| Mod-b / Mod-i | `toggleBold` / `toggleItalic` (selection or word at the caret) |
| Mod-k | `insertLink` |
| Mod-l, Mod-Enter | `toggleChecklist`: text → `- [ ] text`, list item → task, `[ ]` ↔ `[x]` |
| Mod-s (and vim `:w`) | `saveDocument` → `onSave` (always prevents the browser's save dialog) |
| Alt-Enter | `followLinkAtCursor`, or open the agent thread of the caret's line (its badge's, else the one that wrote it) |
| Enter / Backspace | continue lists and tasks / delete list markup |
| Tab / Shift-Tab | indent / outdent list items |
| Mod-f | search panel (plus CodeMirror's default and history keymaps) |

Mod-e is deliberately unbound so the host can use it (for example to toggle reading view).

## Embeds

The embed layer ([`src/embeds/`](src/embeds)) draws `![[…]]` embeds alone on their line in the
live preview. It owns the box (placement, size, selection, moving, resizing, deleting); a renderer
the host registers owns what's inside. Drawings are the first renderer
(`apps/web/src/features/drawings`); images plug in the same way:

```ts
const images: EmbedRenderer = {
  kind: "image", // the box gets `cm-ddl-embed-image`
  matches: (target) => /\.(png|jpe?g|gif|webp|svg)$/i.test(target),
  mount(host) {
    const img = document.createElement("img");
    img.src = urlFor(host.spec.target);
    img.onload = () => host.setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
    host.dom.append(img);
    return {
      update: () => true, // new size or placement, same target: the box follows, keep the img
      activate: () => (openLightbox(host.spec.target), true), // double-click or Enter
      destroy: () => img.remove(),
    };
  },
};
createMarkdownEditor(parent, { doc, callbacks: { embedRenderers: [images] } });
```

**Modifiers** are the Obsidian Excalidraw plugin's (`parseDrawingEmbed` in `@ddl/core`): an alias,
a size (`360`, `360x240`, `x240`, `50%`) and a placement (`left`, `right`, `center`, `left-wrap`,
`right-wrap`); none is full width.

- `left-wrap` / `right-wrap` float inside the embed's line with CSS floats, and the lines after it
  wrap around the box, as in Obsidian's live preview (the float's line takes no height; `.cm-content`
  is a flow root). `left`, `right`, `center` and full width sit on their line as an inline block.
- Width: the modifier, else 100% for full width, else the content's natural width, else 360 px;
  never wider than the column. Height: a given height, else the natural aspect ratio (reserved
  before the content arrives), else a 160 px placeholder.
- The syntax shows while the selection is on the embed's line, and always in source mode.

**Using it** (all ordinary, undoable edits):

| Action | Result | User event |
| --- | --- | --- |
| Click | selects it (`is-selected`, handles) without moving the caret; the box takes the keyboard | |
| Drag (the box or its grip) | an indicator shows where it lands: between the two lines nearest its top edge, left in the column's left third, right in its right third, full width between; dropping moves its line and sets `left-wrap`/`right-wrap`/full width (full width drops the size) | `move.embed`, or `input.embed` for a side change on the same line |
| Drag a corner | resizes live; dropping sets the width (a given height scales with it). A right float grows from its left corner, a left one from its right corner, a centered one from both | `input.embed` |
| Delete, Backspace | removes the embed's line (the file stays, so undo brings it back) | `delete.embed` |
| Enter, double-click | `content.activate()` (drawings: edit in place) | |
| Escape / arrows | deselects / puts the caret on the line before or after | |
| Escape while dragging | cancels the drag | |

Typing while an embed is selected deselects it and types at the caret. Hosts can select an embed
(`host.select()`, `selectEmbed(view, from)`), insert one on its own line at the caret's line
(`editor.insertEmbed(text)`: on the line when it's blank, else above it) and activate one
(`editor.activateEmbed(from)`).

**The contract** ([`src/embeds/types.ts`](src/embeds/types.ts)): `EmbedRenderer` (`kind`,
`matches(target)`, `mount(host) → EmbedContent`), `EmbedHost` (`dom`, `view`, `spec`, `embed()`,
`setNaturalSize(size)`, `select()`) and `EmbedContent` (`update?(spec)`, returning false to be
remounted; `activate?()`; `destroy()`). `mount` runs when the embed's line is drawn and `destroy`
when it isn't anymore (scrolled away, its syntax revealed, the note switched): keep both cheap and
cache by content, as drawings do. The pure edits behind the gestures (`moveEmbed`, `resizeEmbed`,
`removeEmbed`, `insertEmbed`, `dropTarget`, …) are exported.

**Performance.** Embeds come from the live preview's one pass over the visible ranges (O(line) per
embed); the widget compares by embed text, selection and read-only state, so typing elsewhere
reuses the box. Size changes call `requestMeasure` (CodeMirror doesn't watch widget styles).

## Vim mode

`config.vimMode` turns on vim keybindings: vim.js (`@replit/codemirror-vim`) plus the app
integration in [`src/vim-integration.ts`](src/vim-integration.ts), one lazy chunk (~42 kB gz).
`vimMode(true)` yields nothing until the chunk arrives, then every editor that asked for vim
reconfigures; toggling during the load settles on the latest setting. Hosts call `preloadVim()` at
startup when the setting is on (it rejects if the chunk can't load; enabling vim again retries).
Vim is always the first extension, so it sees keys before any keymap. vim.js keeps mappings,
registers, options and ex commands in module-level state shared by every editor; the integration
is installed once and acts on the editor a command came from.

**Ex commands and keys** call host callbacks; without one, the vim panel says "`:cmd` isn't
available here".

| Command | Callback | Web app |
| --- | --- | --- |
| `:w[rite]` | `onSave` | save the note now (like Mod-s) |
| `:wa[ll]` | `onSaveAll` | save every open note |
| `:q[uit]`, `:q!`, `:tabc[lose]`, `:bd[elete]` | `onClose({ all: false })` | close the note's tab |
| `:qa[ll]` | `onClose({ all: true })` | close every tab |
| `:wq`, `:x[it]` | `onSave`, then `onClose` | save and close the tab |
| `:wqa[ll]`, `:xa[ll]` | `onSaveAll`, then `onClose({ all: true })` | save all and close every tab |
| `:e[dit] name`, `:tabe[dit] name`, `:tabnew name` | `onOpenNote(target, { newTab })` | open like a wiki link (created if missing) |
| `:e`, `:tabe`, `:tabnew` without a name | `onOpenNote(null, { newTab })` | open the quick switcher |
| `:tabn[ext]`, `:bn[ext]` | `onSwitchTab({ delta: 1 })`; `:tabn 3` → `{ index: 2 }` | next tab (wraps) |
| `:tabp[revious]`, `:tabN[ext]`, `:bp[revious]`, `:bN[ext]` | `onSwitchTab({ delta: -1 })`; `:tabp 2` → `{ delta: -2 }` | previous tab (wraps) |
| `gt` / `gT` (normal mode) | `onSwitchTab`: `gt` next, `3gt` tab 3, `gT`/`2gT` back | |
| `:obcommand id` | `onRunCommand(id)` (false: "No command id") | run a command-palette command, e.g. `daily:today` |

Notes save continuously, so `:q!` doesn't discard edits and `:w` only skips the save debounce.
vim.js's own ex commands keep working (`:s`, `:g`, `:v`, `:sort`, `:normal`, `:d`, `:marks`,
`:registers`, `:noh`, `:set`, the `:map` family…). `:obcommand` uses Obsidian's name, so vimrc
lines like `exmap today obcommand daily:today` carry over.

**Status.** `onVimStatus({ mode, pending, recording })` reports the mode (`normal`, `insert`,
`replace`, `visual`, `visual-line`, `visual-block`), the keys of the command being typed (showcmd)
and the register a macro records into, at most once per keystroke and only when a field changed
(`null` when vim turns off).

**Clipboard registers.** `"+` and `"*` are the system clipboard (one register, as in Vim on macOS
and Windows); `:set clipboard=unnamed` (or `unnamedplus`) mirrors the unnamed register. Browsers
read the clipboard asynchronously and only with permission while vim pastes synchronously, so the
registers read from a cache, refreshed when the editor gains focus or the window becomes visible
(once read permission was granted), from copy, cut and paste events, and when the user types `"+`,
`"*` or insert-mode `<C-r>` (which may show the permission prompt). Writes always go through.
Like any Clipboard API, it needs a secure context.

**vimrc.** `config.vimrc` (`AppSettings.editor.vimrc`, Settings → Editor) is applied to every vim
editor: one ex command per line (optional leading `:`), `"` comments, `let mapleader = " "`, and
Obsidian's `exmap name command`. The mapping commands work (`map`, `nmap`, `imap`, `vmap`, `omap`,
their `noremap` forms, `unmap`), and `set` for vim.js's options and `clipboard`. Each change first
undoes the previous vimrc (mappings cleared, aliases removed, options restored). Rejected lines go
to `onVimrcApplied([{ line, message }])` (0-based). On first run the daemon imports an Obsidian
vault's `.obsidian.vimrc`.

**Keys shared with the app.** `vimClaimsKey(event)` tells a host whether a keydown belongs to vim:
true in normal, visual and operator-pending mode for the Ctrl keys vim binds (by default or
through a vimrc mapping). The web app uses it only where "Mod" is Ctrl (Windows and Linux), so vim
wins for its keys there; insert mode and ⌘ shortcuts on macOS are unaffected. Escape goes to vim
unless an overlay is open. Mappings made interactively with `:map` aren't claimed.

**With the rest of the editor.** Insert-mode Enter continues lists and Tab indents list items;
live preview, checkboxes and Alt-Enter work in every mode. Vim edits are ordinary transactions, so
badges behave as for any edit (`dd` drops the task's badge; after `u` the host re-resolves it). `/`
and `?` use vim.js's search, highlighted until `:noh`; Mod-f still opens CodeMirror's search panel.

**Testing.** vim.js is the reference; `test/vim` pins it with generated vectors (the contract the
Swift port replays), vim.js's own test suite and a replay against this editor. The rules are in
`AGENTS.md` ("Vim mode") and the details in [`test/vim/README.md`](test/vim/README.md).

```sh
pnpm vim:vectors    # regenerate test/vim/vectors.jsonl (~10 s, Chromium)
pnpm vim:check      # CI gate (~25 s): vectors up to date, coverage, both suites, replay
pnpm --filter @ddl/editor vim:upstream -- --web     # just vim.js's suite (--plain / --web)
pnpm --filter @ddl/editor vim:replay -- --filter 'motion/'   # replay a subset
```

## API notes

- `setDocument(doc)` applies external changes as one change per run of changed lines
  (`documentChanges`: a line diff, each run trimmed to its common prefix/suffix and aligned to line
  starts), so the selection, scroll position, badges and the undo history of edits on other lines
  survive. That is what lets the host put a three-way merge of the agent's edits into a note the
  user is typing in. A caret at the start of a line that gets lines inserted above it stays on its
  line. External changes are not added to the undo history, and `onDocChange` reports them with
  `userEvent: false`. `withDocument(state, doc)` does the same to a state that isn't shown;
  `setDocument(doc, { resetHistory: true })` starts fresh (no history, no badges).
- `createState` / `getState` / `setState` cache one state per open note (instant switching with
  per-note undo). `setState` re-applies the current config and callbacks and clears badges (the
  host re-sends them; that first set doesn't animate in).
- `onDocChange` fires once per view update. `userEvent` is true for `input.*` (typing, paste,
  `input.toggle`, formatting), `delete.*`, `move.*`, `undo` and `redo`; vim edits count as input.
- `onWikiLinkClick(target, { newPane, subpath })`: `target` never includes the `#subpath` or the
  alias (same meaning as `WikiLink.target` in `@ddl/core`).
- `scrollToLine(line)` moves the caret to the line and centers it.

## Saving and merging

The editor never saves: the host does. The web app's `NotesController`
(`apps/web/src/state/notes-controller.ts`) is the model, and the Mac app's `NotesStore` follows the
same algorithm.

- **What it knows per note:** the server text and version it last saw, and whether there are
  unsaved edits (a counter bumped by every edit `onDocChange` reports with a user event, against
  the last one the server acknowledged). The editor's text is read only when a save or a merge
  happens, never per keystroke.
- **Saving:** 300 ms after the last edit (sooner on Mod-s, `:w`, switching notes or the window
  losing focus) it writes the editor's text with `baseVersion` = the version it last saw, one write
  in flight per note. A note without unsaved edits never writes, however often it's flushed.
- **Someone else's change** (`vault.changed` from another editor, the agent, another app): without
  unsaved edits the editor takes the new text (`setDocument`). With unsaved edits, `mergeText`
  from `@ddl/core` merges them three ways (base = the server text the edits started from, local =
  the editor's text, remote = the new text), the editor gets only the other side's changes, and
  the result is saved on top of the new version. A save that meets a newer version (409) merges
  the same way.
- **Line by line:** a diff reports a line edited next to lines added (a task, and the agent's line
  under it) as one replaced block. `mergeText` splits such blocks first, pairing each old line with
  the new line that is most likely it edited (Dice similarity ≥ 0.5, or one extends the other), so
  the added lines survive an edit of that line on the other side, and the same edit made on both
  sides is taken once.
- **Conflicts** (both sides changed the same lines): the user's version of those lines wins, and
  the other version is saved next to the note as `<name> (conflict).md`.
- **Unsaved text** captured from the editor (when a save starts, or merged into a note that isn't
  shown) exists only while there are unsaved edits. A note shown without a cached editor state
  shows that text, else the server's.

**The guarantee:** an editor without unsaved typing never writes text the vault didn't have, and a
merge never brings back a line deleted elsewhere unless the user typed it. A line the user added
between lines deleted elsewhere is kept, and the deleted ones stay deleted; so are lines only the
other side removed from a block both changed. Property tests pin it:
`packages/core/src/merge.property.test.ts` and
`apps/web/src/state/notes-controller.deletes.property.test.ts` (two editors, the agent and an API
client deleting lines, with requests and events in any order), and on the Mac `TextMergeTests` and
`RemoteDeleteModelTests`.

## Theming

The editor uses only these app-defined variables: `--ddl-bg`, `--ddl-bg-secondary`,
`--ddl-bg-elevated`, `--ddl-bg-hover`, `--ddl-border`, `--ddl-text`, `--ddl-text-muted`,
`--ddl-text-faint`, `--ddl-accent`, `--ddl-accent-strong`, `--ddl-accent-soft`,
`--ddl-agent-text`, `--ddl-anchor-bg`, `--ddl-success`, `--ddl-warning`, `--ddl-danger`,
`--ddl-info`, `--ddl-shadow-small`, `--ddl-font-ui`, `--ddl-font-editor`, `--ddl-font-mono`,
`--ddl-editor-font-size` (set per editor from `config.fontSize`) and `--ddl-line-width` (readable
line length). Headings take their line's color, so a heading the agent wrote is agent text.
CodeMirror base-theme overrides are in [`src/theme.ts`](src/theme.ts) and component styles in
[`src/styles.css`](src/styles.css); every class is prefixed `cm-ddl-`.

## Performance

The keystroke path is O(visible lines + badges):

- Live preview decorations come from one syntax-tree pass over `view.visibleRanges`, with shared
  decoration instances and cached widgets (`eq`/`updateDOM`, so unchanged checkboxes and badges
  never re-render).
- Agent lines are found by a string check for `%%agent` per visible line; the input filter that
  keeps markers last looks at the edited line only.
- Badges are an ordered array of anchors mapped with `ChangeSet.mapPos` (O(badges) per change);
  pure insertions skip the line-deletion check.
- Configuration changes use compartments; the language, theme, keymaps and fields are created once.
- `onDocChange` builds the document string only when a handler is registered.

Measured on an Apple-silicon laptop (`pnpm --filter @ddl/editor bench`), p99 against budget, 2k-line
note: 500 single-character inserts with 30 badges 147 ms (500 ms); live preview, 60/150-line
viewport, 0.16/0.35 ms (2/4 ms); agent lines, 150-line viewport, 0.04 ms (1 ms). About 90% of the
state-level cost is lezer's incremental markdown parse (stock GFM costs 216 µs per keystroke, this
language 225 µs). While a fenced-code language chunk is still loading, lezer skips those blocks and
re-parses around them on every change (roughly 10x slower) until the chunk arrives.

## Development

Property tests (`*.property.test.ts`, fast-check) share generators in
[`src/test-arbitraries.ts`](src/test-arbitraries.ts). Reproduce a failure with `FC_SEED=<seed>`,
sweep deeper with `FC_NUM_RUNS=2000`.

```sh
pnpm --filter @ddl/editor test          # vitest (DOM tests run in happy-dom)
pnpm --filter @ddl/editor bench         # vitest bench, writes bench-results.json
```

## Limitations / TODO

- No hanging indent for wrapped list items yet (wrapped lines start at the line's left edge).
- Tables and images are shown as source; callouts (`> [!note]`) render as plain quotes.
- Embeds are drawn only alone on their line; an embed among other text (or in a list item or a
  quote) stays wikilink syntax. With `left-wrap`/`right-wrap`, a float taller than CodeMirror's
  rendering margin (1 000 px) above the viewport can stop wrapping the lines at its bottom while
  its own line is out of the rendered range.
- Ordered-list continuation of tasks (`1. [ ] a` + Enter) doesn't add a checkbox, nor does Enter
  on a task with an alternate status inside a blockquote (`> - [/] a`); items after an inserted one
  are not renumbered by the tab-indentation Enter fallback.
- Backspace right after the marker of a top-level item indented with a tab (`\t- |a`) deletes one
  character instead of the list markup.
- With line numbers and readable line length on, the gutter stays at the left edge of the editor.
- The `@codemirror/language-data` descriptions are bundled eagerly; languages load lazily.
- Vim: no `ignorecase`/`smartcase` options (search is always smart-case; `set` reports them as
  unknown), no `:m`/`:t`/`:copy`, no splits and no `:abbreviate`. vim.js throws on a few rare
  sequences: `di<` outside angle brackets, `<C-a>`/`<C-x>` counts that lengthen a binary number,
  and recursive macros (a failing motion doesn't stop a macro, so it recurses until the stack
  overflows). CodeMirror logs the error and the editor keeps working. The catalog pins them as
  "verified to throw".
