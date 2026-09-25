# @ddl/editor

Framework-agnostic CodeMirror 6 markdown editor for Daily Do List: Obsidian-style live preview,
task checkboxes, vim mode, agent status badges on task lines (and on lines a thread is anchored
to), chips saying what the orchestrator is doing about a line, text the agent wrote drawn as agent
text, and link previews. The web app wraps it in a React component; the desktop/mobile shells
reuse the web app unchanged.

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
`ActivityChip`) lives in [`src/types.ts`](src/types.ts).

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

**Agent badges.** `setAnnotations()` replaces the set of badges. Each badge shows a status dot, a
truncated label and, when its thread has unread messages, a small accent dot (the count is in the
tooltip and the accessible name). Its weight follows what the user has to do: `waiting_approval` and
`waiting_user` are the only loud badges (warning tint and border), `failed` is tinted, `triaging`,
`queued` and `working` are neutral pills, and `done`/`cancelled` are quiet text with the same hit
target. The line gets a faint marker, colored only when the task needs the user or failed. Click,
Enter or Space calls `onAnnotationClick`. `idle` and `ignored` annotations are not rendered.

Motion is CSS-only, paint-only (opacity, transform, color) and off under `prefers-reduced-motion`.
A badge that appears after the note's first `setAnnotations()` fades in with a 2px rise (160 ms), a
new status pops it once (150 ms; a new label or unread count doesn't) and crossfades its colors
(120 ms), the `triaging` dot pulses (1.2 s), and checking a task scales its checkmark in (120 ms;
unchecking doesn't animate). Badges update their DOM in place (`eq`/`updateDOM`), so typing and
status changes never replay the entrance, and a note shown again doesn't animate the badges it
already had.

**Hover and tooltips.** Clickable widgets (badges, the ✦, checkboxes, rendered links, fold markers)
show a pointer, a hover and a pressed state, and a hit target at least 24px tall that never reaches
into text a click should put the caret in. They name themselves with `data-tooltip` rather than
`title`, for the host's tooltip layer (the web app's `src/lib/tooltips.ts`): a badge's tooltip is
its full label and unread count ("Researching… · 2 unread"), the ✦'s "Written by the agent — open
thread".
Checkboxes have no tooltip: they are part of the list, and one per hover would get in the way.

A thread can also be attached to a line that isn't a task (a question written as prose, a heading):
an annotation with `lineAnchor: true` draws the same badge and highlights the line with a soft
accent band (`--ddl-anchor-bg`) and a 2px accent bar at its left edge (`cm-ddl-anchored`; the bar
takes the warning or danger color while the thread needs the user or failed).

Badges stay attached while the user edits. Each badge is anchored to the start of its line and drawn
at the end of whichever line holds that anchor. That way, pressing Enter at the end of a task leaves
the badge on the task (not on the new empty task), Enter at its start moves the badge down with the
task, and splitting, indenting, moving or joining lines keep it with the task text (also for the
neighbour a moved line swaps with, and when a replacement at the line start inserts a line break). A
badge is dropped when a single change removes its line's whole content (delete line, vim `dd`, cut,
select + retype) unless that change inserts the exact same line again (moving lines, undoing a move,
an external reorder). `getAnnotations(state)` returns the annotations with their lines mapped.

**Activity chips.** `setActivityChips()` replaces the chips that say what the orchestrator is doing
about a line (`ActivityChip`: `id`, `line`, `label`, `tooltip`, `tone`, and `pulse`, `fading`,
`kind`). The host decides the wording and when a chip fades or goes (the web app's README has the
shared table). A chip is drawn after the line's last character, after its badge when it has one
(widget side 2), with the badge's look and tones: an empty label is a quiet dot, `pulse` pulses the
dot, `fading` fades the chip out (600 ms), `kind` becomes `data-kind`. Click, Enter or Space calls
`onActivityChipClick`; the tooltip is `data-tooltip` and the accessible name. Like badges, a chip is
anchored to its line's start and mapped through every edit; unlike badges it remembers the line's
text when it was set and is dropped as soon as an edit leaves the line unrecognizable
(`isSameLineEdited` in `@ddl/core`: a prefix while typing, or Dice similarity ≥ 0.5), or when the
line is deleted or joined away. A rewrite in place that still reads as the line keeps it. Updates
reuse the chip's DOM, so a dot turning into a label doesn't replay its entrance; with
`prefers-reduced-motion` nothing pulses or fades. `getActivityChips(state)` returns the chips with
their lines mapped.

**Agent text.** A line the agent wrote ends with an Obsidian comment naming its thread,
`%%agent:thr_1%%` (`%%agent%%` without one; see `markdown/agent-text.ts` in `@ddl/core`). Such lines
are drawn in the agent text color (`--ddl-agent-text`, class `cm-ddl-agent-line`) in both modes;
links, tags, checkboxes and bullets keep their own colors. The live preview hides the marker behind
a ✦ in the accent color: clicking it calls `onAgentLineClick(threadId)` (tooltip "Written by the
agent — open thread"; a marker without a thread gives a ✦ that isn't clickable). Like block syntax, the
marker is revealed (faint, `cm-ddl-agent-marker`) while the selection is on the line; source mode
always shows it faint. Text typed at or after the marker (e.g. after clicking the end of the line,
which puts the caret after the hidden marker) goes in front of it, so the marker stays last; the
user deletes the marker to make the line theirs. Alt-Enter on an agent line without a badge opens
its thread too.

**Link previews.** Resting the mouse on a link for 300 ms shows a card (`LinkPopover`, in the
document's body) with what `onLinkPreview({ link, label, threadId })` returns. `threadId` is the
thread named by the agent marker of the link's line, so a host can describe a URL with the sources
that thread cites. Without a host answer, web links show their label (or host, for numbered
citations and bare URLs), host and full URL, and note links show nothing. The editor never fetches
a link. Editing, moving the caret, scrolling or pressing a key hides the card. `LinkPopover`,
`renderLinkPreview` and `webLinkPreview` are exported so hosts can show the same card elsewhere.

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

**Vim** (`vimMode`): Obsidian-style vim keybindings with ex commands mapped to app actions, a mode
indicator, clipboard registers and a vimrc. See [Vim mode](#vim-mode).

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
| Alt-Enter | `followLinkAtCursor`, or open the agent thread of the caret's line (its badge's, else the one that wrote it) |
| Enter / Backspace | continue lists and tasks / delete list markup |
| Tab / Shift-Tab | indent / outdent list items |
| Mod-f | search panel (plus CodeMirror's default and history keymaps) |

Mod-e is deliberately unbound so the host can use it (for example to toggle reading view).

## Vim mode

`config.vimMode` turns on vim keybindings: vim.js (`@replit/codemirror-vim`) plus the app
integration in [`src/vim-integration.ts`](src/vim-integration.ts). They load together as one lazy
chunk (~42 kB gz). `vimMode(true)` yields nothing until the chunk arrives, then every editor that
asked for vim reconfigures. Toggling vim during the load settles on the latest setting. Hosts call
`preloadVim()` at startup when the setting is on. It rejects if the chunk can't load, and enabling
vim again retries. Vim is always the first extension, so it sees keys before any keymap.

vim.js keeps mappings, registers, options and ex commands in module-level state shared by every
editor. The integration is installed once and acts on the editor a command came from.

**Ex commands and keys** call host callbacks. When the host doesn't provide a callback, the vim
panel says "`:cmd` isn't available here".

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
vim.js's own ex commands keep working: `:s`, `:g`, `:v`, `:sort`, `:normal`, `:d`, `:y`, `:j`,
`:marks`, `:registers`, `:noh`, `:set`, the `:map` family and so on. `:obcommand` uses Obsidian's
name, so vimrc lines like `exmap today obcommand daily:today` carry over.

**Status.** `onVimStatus({ mode, pending, recording })` reports:

- `mode`: `normal`, `insert`, `replace`, `visual`, `visual-line` or `visual-block`;
- `pending`: the keys of the command being typed (vim's showcmd, e.g. `2d` or `"a`);
- `recording`: the register a macro is being recorded into.

It fires at most once per keystroke and only when a field changed, so typing in insert mode
triggers nothing. It reports `null` when vim turns off. The web app's status bar shows
`recording @q`, the pending keys and `NORMAL` / `INSERT` / `REPLACE` / `VISUAL` / `V-LINE` /
`V-BLOCK`.

**Clipboard registers.** `"+` and `"*` are the system clipboard (one register, as in Vim on macOS
and Windows). `:set clipboard=unnamed` (or `unnamedplus`) mirrors the unnamed register: yanks and
deletes also go to the system clipboard, and `p` pastes text copied in another app. Browsers read
the clipboard asynchronously and only with permission, but vim pastes synchronously, so the
registers read from a cache. It refreshes:

- in the background, when the editor gains focus or the window becomes visible, and only once
  clipboard-read permission was granted;
- from copy, cut and paste events, which need no permission;
- explicitly, when the user types `"+`, `"*` or insert-mode `<C-r>`; this read may show the
  browser's permission prompt.

Writes always go through. Without read permission, the registers hold what the app last wrote
or saw pasted. Like any Clipboard API, this needs a secure context (`https:` or `localhost`).

**vimrc.** `config.vimrc` is a vimrc applied to every vim editor (`AppSettings.editor.vimrc`,
edited in Settings → Editor when vim mode is on). It accepts:

- one ex command per line, with an optional leading `:`;
- `"` comments and blank lines;
- `let mapleader = " "` (or `"\<Space>"`, `","`…), which applies to `<leader>` in later lines;
- Obsidian's `exmap name command`, which defines `:name` as an alias.

The mapping commands work (`map`, `nmap`, `imap`, `vmap`, `omap`, their `noremap` forms and
`unmap`), and so do `set` for vim.js's options (`textwidth`, `pcre`, `insertModeEscKeysTimeout`,
`langmap`) and `clipboard`. Each change first undoes the previous vimrc: every mapping is cleared
(`gt`/`gT` come back), the previous vimrc's ex aliases are removed and the options it set are
restored. Lines vim.js rejects are reported to `onVimrcApplied([{ line, message }])`, 0-based,
and the web app lists them under the setting. `set ignorecase`/`smartcase` are reported as
unknown options: `/` search in vim.js is always smart-case. On first run, the daemon imports
`.obsidian.vimrc` from an Obsidian vault (the Vimrc Support plugin's default location).

**Keys shared with the app.** `vimClaimsKey(event)` tells a host whether a keydown inside a vim
editor belongs to vim. It returns true in normal, visual and operator-pending mode for the Ctrl
keys vim binds: by default (`<C-o>`, `<C-d>`, `<C-u>`, `<C-r>`, `<C-v>`, `<C-a>`, …) or through
a vimrc mapping. The web app's global hotkeys use it only where "Mod" is Ctrl (Windows and
Linux), so there vim wins for its keys, and app shortcuts vim doesn't bind keep working. Insert
mode and every ⌘ shortcut on macOS are unaffected. Escape goes to vim unless an overlay (palette,
switcher, modal) is open. Mappings made interactively with `:map` aren't claimed; put them in
the vimrc.

**With the rest of the editor.** Insert-mode Enter continues lists and tasks and Tab indents list
items. Live preview, clickable checkboxes and Alt-Enter (follow the link, or open the line's agent
thread) work in every mode. Vim edits are ordinary transactions, so badges behave as for any other
edit: they follow their task through edits, `dd` drops the task's badge like any line deletion,
and a dropped badge never comes back by itself. After `u`, the host shows it again when it
re-resolves the agent's tasks; the web app does that ~150 ms after an edit. `/` and `?` use
vim.js's search, and its matches are highlighted like the search panel's until `:noh`. Mod-f
still opens CodeMirror's search panel. The block cursor uses the accent color and turns into an
outline when the editor loses focus. The vim panel (`:` prompt, messages) uses the app's colors
in light and dark themes.

### How vim is tested

vim.js is the reference implementation, and the tests pin it from three sides (details in
[`test/vim/README.md`](test/vim/README.md)):

- **Vectors.** [`test/vim/vectors.jsonl`](test/vim/vectors.jsonl) holds ~11 500 cases: a
  generated catalog of every default key binding and ex command over a set of documents, with
  counts, plus vim.js's own tests recorded as steps. Each case is a document, a selection, keys and
  the expected document, selections, mode and registers after every step. The file is produced by
  running vim.js on a plain CodeMirror 6 "oracle" editor in Chromium, and it is the contract the
  Swift port replays. The catalog must cover every entry of vim.js's `defaultKeymap` and
  `defaultExCommandMap` (exclusions are listed with reasons).
- **vim.js's test suite** runs in Chromium against plain CodeMirror 6 (upstream's setup, all must
  pass) and against this editor (vim + live preview). Only the documented expected failures in
  [`test/vim/upstream/expected-failures.ts`](test/vim/upstream/expected-failures.ts) may fail:
  tests that depend on the JavaScript/XML language upstream loads.
- **Replay.** Every vector is replayed against this editor. The skip list, with reasons, is in
  the same file.

Integration code has unit tests (`src/vim*.test.ts`), the web app has real-keyboard Playwright
tests (`apps/web/e2e/vim.spec.ts`), and the perf suite budgets vim-mode typing like normal typing.

```sh
pnpm vim:vectors    # regenerate test/vim/vectors.jsonl (~10 s, Chromium)
pnpm vim:check      # CI gate (~25 s): vectors up to date, coverage, both suites, replay
pnpm --filter @ddl/editor vim:upstream -- --web     # just vim.js's suite (--plain / --web)
pnpm --filter @ddl/editor vim:replay -- --filter 'motion/'   # replay a subset
```

After a vim.js upgrade or a catalog change, run `pnpm vim:vectors` and review the diff. The file
is sorted by case name and byte-for-byte deterministic. `pnpm vim:check` prints a per-case diff
when the committed file is stale.

## API notes

- `setDocument(doc)` applies external changes as one change per run of changed lines
  (`documentChanges`: a line diff, each run trimmed to its common prefix/suffix and aligned to line
  starts for whole-line insertions/deletions), so the selection, scroll position, badges and the
  undo history of edits on other lines survive. That is what lets the host put a three-way merge
  of the agent's edits into a note the user is typing in. A caret at the start of a line that gets
  lines inserted above it stays on its line. External changes are not added to the undo history
  (local history is mapped through them), and `onDocChange` reports them with `userEvent: false`.
  `withDocument(state, doc)` applies an external change the same way to a state that isn't shown
  (e.g. a cached note).
  `setDocument(doc, { resetHistory: true })` starts a fresh state with the current config (no
  history, no badges).
- `createState` / `getState` / `setState` support caching one state per open note (instant switching
  with per-note undo). `setState` re-applies the current config and callbacks and clears badges (the
  host re-sends them; that first set doesn't animate in). States from other editor instances work
  too; a plain `EditorState` keeps only its document and selection.
- `onDocChange` fires once per view update. `userEvent` is true for `input.*` (typing, paste,
  `input.toggle`, formatting), `delete.*`, `move.*`, `undo` and `redo`; vim edits count as input.
- `onWikiLinkClick(target, { newPane, subpath })`: `target` never includes the `#subpath` or the
  alias (same meaning as `WikiLink.target` in `@ddl/core`).
- `scrollToLine(line)` moves the caret to the line and centers it.

Additions to the contract: `EditorCallbacks.onWikiLinkClick` options gained an optional `subpath`;
`LineAnnotation.lineAnchor`, `EditorCallbacks.onAgentLineClick` and `onLinkPreview` (with the
`LinkPreview` and `LinkPreviewRequest` types) are new. Additional exports:

- state and tests: `createHeadlessEditorState`, `editorExtensions`, `externalChange`,
  `withDocument`;
- annotations: `annotationField`, `setAnnotationsEffect`, `getAnnotations`,
  `HIDDEN_BADGE_STATUSES`;
- agent lines: `agentLines`, `buildAgentLineDecorations`, `AGENT_SPARKLE_TITLE`;
- commands: `toggleTaskAtLine`, `toggleChecklist`, the formatting and list commands (including
  `continueAlternateTask`), `saveDocument`, `followLinkAtCursor`;
- links: `findLinkAt`, `linkAt` (with the link's visible text);
- link previews: `linkPreviews`, `linkPreviewAt`, `LinkPopover`, `renderLinkPreview`,
  `webLinkPreview`, `hostnameOf`;
- live preview: `buildLivePreviewDecorations`, `livePreview`, `livePreviewEnabled`;
- building blocks: `markdownSupport`, `ddlTags`, `splitWikiLink`, `editorTheme`,
  `markdownHighlightStyle`, `editorKeymap`, `minimalChange`, `documentChanges`.

## Theming

The editor uses only these app-defined variables: `--ddl-bg`, `--ddl-bg-secondary`,
`--ddl-bg-elevated`, `--ddl-bg-hover`, `--ddl-border`, `--ddl-text`, `--ddl-text-muted`,
`--ddl-text-faint`, `--ddl-accent`, `--ddl-accent-strong`, `--ddl-accent-soft`,
`--ddl-agent-text`, `--ddl-anchor-bg`, `--ddl-success`, `--ddl-warning`, `--ddl-danger`,
`--ddl-info`, `--ddl-shadow-small`, `--ddl-font-ui`, `--ddl-font-editor`, `--ddl-font-mono`,
`--ddl-editor-font-size` (set per editor from `config.fontSize`) and `--ddl-line-width` (readable
line length). Headings take their line's color, so a heading the agent wrote is agent text.

CodeMirror base-theme overrides are in [`src/theme.ts`](src/theme.ts); component styles are in
[`src/styles.css`](src/styles.css). Every class is prefixed `cm-ddl-`: `cm-ddl-editor`,
`cm-ddl-live-preview`, `cm-ddl-readable`, `cm-ddl-h1`…`h6`, `cm-ddl-quote`, `cm-ddl-codeblock`,
`cm-ddl-task-done`, `cm-ddl-checkbox`, `cm-ddl-bullet`, `cm-ddl-hr`, `cm-ddl-link`,
`cm-ddl-wikilink`, `cm-ddl-badge` (+ `cm-ddl-badge-<status>`, `cm-ddl-badge-tone-<tone>` with tones
`needs-you`, `failed`, `working` and `quiet`, and `cm-ddl-badge-enter` while it animates in),
`cm-ddl-annotated-<status>`, `cm-ddl-anchored`, `cm-ddl-agent-line`, `cm-ddl-agent-marker`,
`cm-ddl-agent-sparkle`, `cm-ddl-link-popover` and `cm-ddl-link-preview-*`.

## Performance

The keystroke path is O(visible lines + badges):

- Live preview decorations come from one syntax-tree pass over `view.visibleRanges`, using shared
  decoration instances and cached widgets. Widgets implement `eq`/`updateDOM`, so unchanged
  checkboxes and badges are never re-rendered.
- Agent lines are found by scanning the visible lines for `%%agent` (a string check per line, the
  regex only on hits); the input filter that keeps markers last looks at the edited line only.
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
| 500 single-character inserts with 30 badges (state level) | 132 ms (0.26 ms/key) | 147 ms | 500 ms |
| live preview, 60-line viewport | 0.07 ms | 0.16 ms | 2 ms |
| live preview, 150-line viewport | 0.17 ms | 0.35 ms | 4 ms |
| agent lines, 150-line viewport, every 4th line the agent's | 0.02 ms | 0.04 ms | 1 ms |

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
- The `@codemirror/language-data` descriptions are bundled eagerly; languages load lazily.
- Vim: no `ignorecase`/`smartcase` options (search is always smart-case), no `:m`/`:t`/`:copy`,
  no splits and no `:abbreviate`. vim.js throws on a few rare sequences: `di<` outside angle
  brackets, `<C-a>`/`<C-x>` counts that lengthen a binary number, and recursive macros (a
  failing motion doesn't stop a macro, so it recurses until the stack overflows). CodeMirror
  logs the error and the editor keeps working. The catalog pins them as "verified to throw".
