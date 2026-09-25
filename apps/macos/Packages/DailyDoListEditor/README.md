# DailyDoListEditor

Native markdown editor for the Daily Do List macOS app: an `NSTextView` on an explicit TextKit 1
stack (`NSTextStorage` → `NSLayoutManager` → `NSTextContainer`) that edits plain markdown with
Obsidian-style live preview, clickable task checkboxes, agent status badges, lines the agent
wrote (a sparkle opens their thread), lines a thread is anchored to, link previews, Obsidian's
list and formatting commands, drawings embedded in notes (floats the text wraps around, moved,
resized and edited in place), and vim mode. It depends on `DailyDoListVim` (the vim engine),
`DailyDoListDrawing` (the drawing engine and its canvas) and `DailyDoListUI` (tooltips);
`packages/editor` (the web CodeMirror editor) is its behavioral reference.

```swift
let editor = MarkdownEditorController(configuration: EditorConfiguration(fontSize: 16))
editor.delegate = self                       // MarkdownEditorDelegate (all methods optional)
editor.setText(noteMarkdown, resetUndo: true) // note switch
editor.setBadges([EditorBadge(id: "t1", line: 4, status: "working", label: "Researching…")])

// SwiftUI
MarkdownEditorView(controller: editor)
// AppKit
container.addSubview(editor.view)

// Vim mode: one Vim per app, shared by every editor
let vim = Vim()
let integration = EditorVimIntegration(vim: vim)  // app ex commands, clipboard, vimrc
editor.vim = vim
editor.configure(EditorConfiguration(fontSize: 16, vimMode: true))
```

## Public API

| API | Notes |
| --- | --- |
| `MarkdownEditorController(configuration:)` | One editor. `view` is the view to embed: `scrollView` (with the `NSTextView`, `textView`, inside it) and vim's command line under it. |
| `text`, `setText(_:resetUndo:)` | `setText` never notifies the delegate. Without `resetUndo` it applies one minimal replacement (common prefix/suffix, whole lines aligned), so selection, scroll and badge anchors survive; the change is undoable (read-only editors clear undo instead). With `resetUndo` it replaces the document, clears undo and badges, and puts the caret at the start. `\r\n`/`\r` become `\n`. |
| `setBadges(_:)`, `badges` | Badges are anchored to their line and remapped through edits; `badges` returns them with current lines. `idle`/`ignored` are kept but not drawn. A badge with `highlightsLine` (a thread anchored to a line that isn't a task) also draws the line's band. |
| `applyRemoteChanges(_:)` | Someone else's changes (`EditorTextChange`s: non-overlapping UTF-16 ranges of the current text, applied in order at the same place), e.g. the remote side of a merge. Each is its own storage edit, so the caret, selection, badges and the user's undo history stay; together they're one undoable step. The delegate isn't notified. |
| `configure(_:)`, `configuration` | Font size (restyles), live preview, readable line length, spellcheck, line numbers, editable, vim mode. |
| `vim`, `vimSession`, `vimStatus` | The app's shared `Vim` (vim mode needs it and `configuration.vimMode`), the session attached to this editor, and its mode line. In a read-only editor vim moves, yanks and searches but doesn't edit. |
| `EditorVimIntegration(vim:pasteboard:)`, `applyVimrc(_:)`, `vimrcProblems` | Install once per app on the shared `Vim`: the app's ex commands, `gt`/`gT`, the clipboard registers and the vimrc (see [Vim mode](#vim-mode)). `VimPasteboard` puts the pasteboard behind a protocol for tests. |
| `focus()`, `moveCaretToEnd()`, `scrollToLine(_:)` | `focus()` before the editor is in a window applies once it is (the first note at launch). `moveCaretToEnd` puts the caret after the last line and scrolls to it. `scrollToLine` puts the caret at the line start and centers it (0-based, clamped). |
| `snapshot()`, `restore(_:)` | Text, selection, scroll offset and the note's own `UndoManager` for instant tab switches. `restore` and `setText(_:resetUndo: true)` start a new document: badges are cleared and the caret line is always reported. |
| `delegate` | `editorTextDidChange` (user edits only, including undo), `didClickBadge` (with its current line), `didClickAgentThread` (a sparkle), `didClickWikiLink(target:newWindow:)`, `didClickLink(url:)`, `previewFor(_: EditorLinkPreview)` (a link's tooltip: asked when hovering starts and when the tooltip shows; nil = `fallbackText`), `cursorDidMoveToLine` (only when the line changes), `editorDidRequestSave` (also `:w`), `vimStatusDidChange` (only when it changes; nil when vim mode ends), `perform(_: EditorVimRequest)` (vim's app commands; the default answers `.unavailable`), `drawingFor(target)`, `didEditDrawing`, `didEndEditingDrawing`, `willShowContextMenu` (see [Drawings](#drawings)). |
| `drawingsDidChange()` | The host's drawings loaded or changed: embeds ask again (`drawingFor`), re-lay out the ones whose drawing changed, and a drawing being edited in place takes a version that came from elsewhere. |
| `insertDrawingEmbed(_:)`, `beginEditingDrawing(atLine:)`, `endEditingDrawing(select:)` | Insert Drawing: the embed on a line of its own at the caret's line (returns its line), then edit it in place. Also `isEditingDrawing`, `editingDrawingPath`, `drawingCanvas`, `selectedDrawingLine`, `selectDrawing(atLine:)`. |

Additions to the original contract (all source-compatible):

- `EditorSnapshot.undoManager` (and an `undoManager:` init parameter, default `nil` = fresh history).
- `badges` is computed (current lines) instead of a stored copy of what was set.
- Commands, returning `false` when nothing happened (read-only, not a task line): `toggleTask(atLine:)`,
  `toggleChecklist()`, `toggleBold()`, `toggleItalic()`, `toggleInlineCode()`,
  `toggleStrikethrough()`, `toggleHighlight()`, `insertLink()`.

## Behavior

**Styling.** System font at `fontSize`, 1.5 line height (text vertically centered in each line),
headings 1.6 / 1.4 / 1.25 / 1.1 / 1 / 1 em semibold with a little space above, bold, italic, bold
italic, strikethrough, `==highlight==` and `#tags` on rounded backgrounds, monospaced inline code
on a rounded background, fenced code blocks on a full-width rounded background (fences faint),
YAML frontmatter as small monospaced metadata, links and wikilinks in the accent color (`#1D6FE8`,
`#3B8BFF` in dark mode; markdown links and URLs underlined), blockquotes with accent bars and muted
text, completed tasks struck through and muted (cancelled ones fainter), horizontal rules as a thin
line. Wrapped list items align with their text. Colors are the app's palette (`EditorColors`:
background, text, muted and faint text, accent, agent text, anchor band, status tones), dynamic
light/dark; the caret is the accent and selections an accent tint.

**Agent lines.** A line ending with `%%agent:<threadId>%%` (or `%%agent%%`; the grammar of
`@ddl/core`'s `AGENT_MARKER_RE`, outside code and frontmatter) was written by the agent: its text is
drawn in the agent color (checkboxes, bullets, links, tags and completed tasks keep theirs). With
live preview the marker (and the blanks before it) is hidden like other syntax and a sparkle is
drawn in its slot in the accent color; clicking it calls `didClickAgentThread` (without a thread
the sparkle is only a mark), and its tooltip says "Written by the agent — open thread". The line
the selection touches shows the marker as faint text; so does source mode. A caret landing after a
hidden marker (a click past the end of the line) goes before it, and Enter between the text and the
marker's end starts the next line after the marker, so typing keeps the line the agent's; deleting
the marker makes it the user's.

**Anchored lines.** A drawn badge with `highlightsLine` gives its line a soft accent band
(`anchorBackground`) across the text column, a little wider, with a 2 pt accent bar at its left
edge, drawn behind the text and the selection. It follows the line through edits like the badge.

**Link previews.** Every visible link has a tooltip: `previewFor` gets an `EditorLinkPreview` (an
external URL or a note target, the link's visible text, and the thread named by the agent marker
of the link's line); without an answer the tooltip is the link text, hostname and URL, or the
note's name.

**Tooltips.** Badges, sparkles and links show the app's one tooltip (`DailyDoListUI`'s
`TooltipCenter`, set as `tooltipCenter`): the controller reports the element under the pointer as
a `TooltipRegion` from `mouseMoved`, so the tooltip opens after the shared delay, glides from one
element to the next, and fades when the pointer leaves. Its text is read when it shows (a link's
preview may have loaded by then), and a badge that changes or goes away under it updates or takes
the tooltip with it. Nothing about tooltips runs on the draw or keystroke path.

**Tokenizer** (pure, AppKit-free, UTF-16 offsets): ATX headings 1–6, fenced code (```` ``` ````
/ `~~~`, info string, unterminated fences run to the end), frontmatter (`---` on line 0, closed by
`---`/`...` within 200 lines, like `@ddl/core`), nested blockquotes, lists (`-`, `*`, `+`, `1.`,
`1)`), tasks with any status character, horizontal rules; inline CommonMark emphasis (flanking
rules, rule of three, intraword `_`), multi-backtick code spans, escapes, `[text](url "title")`,
`<autolinks>`, GFM bare URLs (trailing punctuation rules; URLs with `_` stay literal),
`~~strike~~`, `==highlight==`, `[[target]]`, `[[target|alias]]`, `[[target#heading]]`,
`![[embed]]` and `#tags` (not mid-word, not in URLs or code). Indented code and setext headings are
deliberately unsupported (an indented task must stay a task; a line's style never depends on the
next line).

**Live preview** (`livePreview`, default on). Markers are hidden on lines the selection doesn't
touch; the lines it touches show raw syntax. Hidden: heading `#`s and their spaces (and closing
`#`s), emphasis/strike/highlight/code delimiters, link brackets and `(url "title")`, autolink
`<>`, escapes, wikilink brackets (and the target when there is an alias), blockquote `>`s (bars
drawn instead), rules (a line drawn instead). `- [ ]` becomes a checkbox and `-`/`*`/`+` a dot,
revealed only while the selection touches the marker, so the checkbox stays while you type the
task. An agent marker becomes a sparkle and is revealed with its line. Nothing is revealed while
the editor isn't first responder. With live preview off, all syntax shows dimmed. A caret landing inside hidden syntax (vertical moves, clicks) snaps to its edge;
clicks land next to the visible character clicked.

**Checkboxes.** SF Symbols in the accent color: `square` (open), `checkmark.square.fill` (done),
`square.lefthalf.filled` (`[/]`), `minus.square` (`[-]`, gray), `arrow.right.square` (`[>]`),
plus `arrow.left.square`, `questionmark.square`, `exclamationmark.square`. Clicking toggles
`[ ]` ↔ `[x]` (other statuses → `[x]`) as an undoable edit, never in a read-only editor.

**Badges.** Drawn after the text on the last line fragment of their line: a status dot (triaging
accent, queued faint, working info (cyan), needs-you amber, done green, failed red, cancelled faint), the
label shortened to ~28 characters and, with unread messages, a 6 pt accent dot (the tooltip says
"label (N unread)", like the web app's, `99+` max). Only badges that need the user are loud (`BadgeStyle`):
`waiting_approval`/`waiting_user` are warning-tinted pills (14 % fill, warning border, primary
text); `failed` has danger text and dot on a faint danger fill, no border; `triaging`/`queued`/
`working` are neutral pills (subtle fill, hairline border, secondary text); `done`/`cancelled` are
bare tertiary text. Colors follow the app theme in light and dark. Hover highlights every kind;
tooltip; click → `didClickBadge` (the caret doesn't move). They never overlap text: when the column
has no room on its right (narrow window or no readable width), the text column narrows to reserve
it, and a pill that still doesn't fit before the view's edge shortens its label (down to just the
status and unread dots; the tooltip keeps the full label).

**Motion** (paint only, nothing is laid out again; all of it off with Reduce Motion). A badge that
appears after the note was drawn fades in while settling 2 pt upwards (160 ms, ease-out); the
badges of a note being opened, badges set again with the same id and badges moved by typing don't.
A change of status, label or unread dot crossfades from the old look (160 ms). A triaging badge's dot breathes
1 → 0.35 → 1 (1.2 s, ease-in-out) while it's on screen. Checking a task (click, ⌘L, ⌘↩) pops its
checkmark in over the open box: 0.8 → 1 scale with a fade (120 ms). The curves are CSS's
`ease-out`/`ease-in-out`, solved like browsers solve them. Frames come from a display link
(`NSView.displayLink`, up to 60 Hz) that runs only while a transition plays or a pulsing badge is
visible in a visible window; each frame redraws just the moving badges, dots and checkboxes. An
idle editor has no timer at all.
Only badges in the visible rect are laid out and drawn. Remapping: lines inserted/deleted above
shift a badge, edits in its line keep it, Enter at its line start moves it with the text, Enter at
the end keeps it on the task, and an edit removing the line's whole content drops it (unless the
same edit inserts that exact line again, e.g. a whole-document replacement).

**Links.** A plain click follows a rendered link (live preview on, caret not on its line); ⌘-click
follows any link. Wikilinks and scheme-less markdown destinations (`[x](Notes/Plan.md#Goals)`) go to
`didClickWikiLink` with the target only (no alias, no `#subpath`), `newWindow` = ⌘ held; `http(s)`,
`mailto`, `tel`, `www.` and email addresses go to `didClickLink`. Other schemes (`javascript:`,
`file:`, `data:`, …) are never passed on. The pointer becomes a hand over clickable things.

### Drawings

Like the web editor's embed layer (`packages/editor/src/embeds`), with the Obsidian Excalidraw
plugin's syntax ([spec](../../../../docs/specs/drawings.md)):

- **Embeds.** A line that is one embed of a drawing (`![[Plan.excalidraw|360|right-wrap]]`, spaces
  around it allowed; not in a list, quote or heading, not the agent's) is drawn as the drawing
  while live preview is on and the selection isn't on its line; then, and in source mode, its
  syntax shows. The host answers `drawingFor(target)` with `.loading`, `.missing`, `.unreadable`
  or `.ready(EditorDrawing)` (path, scene, content hash); nil keeps embeds as text. Placeholders
  show while loading ("Drawing not found", "Couldn't show this drawing"; an empty drawing says
  "Double-click to draw").
- **Sizes and places** (`EmbedGeometry`, the web's CSS): the width from the modifier (`360`,
  `50%`), else the drawing's own width, else 360, full width with no placement; never wider than
  the column; the height from `WxH` or the drawing's proportions (160 while unknown). Rows
  (`left`, `right`, `center`, full) are on a line of their own the drawing's height (4 pt above and
  below); floats (`left-wrap`, `right-wrap`) sit 3 pt below their line's top with 20 pt between
  them and the text and 10 pt below.
- **Wrapping.** A float's line takes no height; its box (with the margins, to the column's edge)
  is an exclusion path of the text container, so the lines after it wrap around it. Floats are
  laid out top to bottom from their line's position (one that would overlap an earlier float goes
  below it; a row goes below floats above it by growing its line), and only recomputed before a
  draw when something may have moved them: an edit above the last embed line, a reveal, a drawing
  or the column changing. The exclusion paths change only when a float actually moved. While a
  note has floats, layout is contiguous (non-contiguous layout places a line at an estimate
  before the text above it is laid out, and a float's position comes from its line).
- **Select, move, resize, delete** (`MarkdownEditorController+EmbedInteraction`, `EmbedEdits`):
  a click selects a drawing (2 pt accent outline, the caret stays and hides); the pointer hovering
  one outlines it. Dragging past 4 pt shows where it will land (a line between two lines and a box
  on that side) and dropping moves its line there, with the placement from where it was dropped:
  the column's left third floats it left, the right third right, the middle full width (which
  drops the size); next to its own line only the placement changes. The selected drawing has a
  grip ("Drag to move") and the corner that moves ("Drag to resize"; a right float grows to the
  left, a left one to the right, a centered one both ways), which sets the width modifier
  (scaling a given height; at least 48). Delete or Backspace removes the embed's line (the file
  stays), Return edits it, Escape deselects, the arrows put the caret on the line before or after
  it, and typing deselects it and types at the caret. Each edit is one undoable step; the pure
  edits are ported from the web's `edits.ts`/`drop.ts` with their test cases.
- **Editing in place** (`MarkdownEditorController+DrawingEditing`): double-click, or Return while
  selected, puts a `DrawingCanvasView` in editing mode on the box, framed like the preview, at
  least 240 tall, growing with the drawing; its tool bar floats next to it (above, or below when
  there's no room). The canvas is first responder: keys it doesn't handle are swallowed rather
  than passed up to the text view, so vim and typing never act on the note meanwhile. Every
  committed change goes to `didEditDrawing` (the host saves, debounced) and shows in the other
  embeds of the drawing; a new version from the host (merged with a change from elsewhere)
  replaces the canvas's scene, keeping its history. Escape with nothing selected in the drawing
  ends editing and leaves it selected; a click outside it, the focus leaving it, a note switch, a
  read-only editor or source mode end it too (`didEndEditingDrawing`).
- **Insert Drawing** is the host's (it creates the file); `insertDrawingEmbed` puts the embed on
  the caret's line when it's blank (the caret on a new line after it) or above it, keeping the
  caret off the embed so the drawing shows, then `beginEditingDrawing(atLine:)`. The context menu
  asks the host for items (`willShowContextMenu`).
- **Performance.** Nothing on the keystroke path renders or measures a drawing: previews are
  rendered when drawn and cached by content hash, width and theme (`DrawingPreviewCache`); a
  drawing's size is measured once per version; the embed lines are tracked by the highlighter's
  incremental passes.

### Keyboard

| Keys | Action |
| --- | --- |
| Enter | Continue the list/task/quote: `- ` → `- `, `1.` → `2.` (following items renumbered), tasks of any status → `- [ ] `, indentation and `>` kept. On an empty item: outdent a nested item under its parent, otherwise remove the markup (ends the list). Plain lines, code and frontmatter get a plain newline. |
| Backspace | Right at the start of an item's text: remove the whole list/task prefix at once (or the innermost `>`). |
| Tab / ⇧Tab | Indent / outdent list items (a tab after any `>`; outdent removes a tab or up to four spaces). Elsewhere Tab inserts a tab; with text selected it indents the lines. |
| ⌘L, ⌘↩ | Toggle checklist on every selected line: text → `- [ ] text`, list item → task, `[ ]` ↔ `[x]`. |
| ⌘B / ⌘I | Bold / italic around the selection or the word at the caret (removed when present; `***` aware). |
| ⌘K | `[text](|)`, `[|](url)` for a selected URL, `[|]()` when nothing is selected. |
| ⌘S | `editorDidRequestSave`. |
| ⌘F, ⌘G, ⇧⌘G | Find bar (incremental), next, previous. |

These editor shortcuts win over menu items with the same keys while the editor is first responder.
⌘E is deliberately unbound (Obsidian and the web app use it for reading view); call
`toggleInlineCode()` from a host menu item to bind inline code. There is no bracket or quote
auto-pairing, and smart quotes/dashes, text replacement, autocorrect, link detection and inline
predictions are off. Typing coalesces into one undo step per burst; every command is its own step.

## Vim mode

With `configuration.vimMode` and a `vim`, the controller attaches a `VimSession` from
`DailyDoListVim` (the port of the web editor's vim.js). Its `VimEditor` is `TextViewVimHost`: the
engine decides what every key does, and the host supplies the text view's real text, selection,
edits, undo, layout (TextKit line fragments for `gj`, `H`, `zz`, `<C-d>`) and drawing.

**Keys** (`TextViewVimHost+Keys`, `VimKeyEvents`, `VimCtrlKeys`):

- `keyDown` offers every key to vim first, named like the web's `KeyboardEvent`: named keys from
  key codes, `characters` (or `charactersIgnoringModifiers` with ⌃ or ⌘), the modifiers, and
  `code` so mappings keep working on non-Latin layouts.
- While an input method has marked text, keys go to the input method.
- In normal and visual mode no key reaches the text view or the input system, so there's no
  accent popup and key repeat works. ⌘ keys vim doesn't bind go on to AppKit. ⌘ shortcuts handled
  as key equivalents (menus, the editor's own) work in every mode.
- In normal and visual mode, the Ctrl keys vim binds (vim.js's defaults, as in the web's
  `vim-keys.ts`, plus those a vimrc maps) win over menus. So does every Ctrl key while the
  command line is open (`performKeyEquivalent`).
- In insert and replace mode, keys vim leaves alone get the text view's own handling (typing,
  list continuation, Tab, Backspace, ⌃A/⌃E), and vim sees the resulting edits. Esc always
  reaches vim.

**Edits and selection.** Vim's changes go through the text view (`shouldChangeText`,
`replaceCharacters`, `didChangeText`), so styling, badges, live preview and the delegate work as
they do for typing. The text view's own edits (typing, list commands, paste, drag and drop, IME
commits, remote changes) reach vim once per operation, labeled with a CodeMirror user event and
the selection they end with. Vim's own edits aren't reported back. The host keeps a shadow
selection for what `NSTextView` can't show: a visual block's empty ranges, which range is the
main one, and direction. A mouse selection turns into visual mode when the drag ends. After a
visual-block `I` or `A`, typing, Backspace, Delete, Enter and Tab act at every cursor.

**Undo** (`VimUndoRecorder`, `MarkdownEditorController+Vim`). While vim is attached, edits are
grouped by CodeMirror 6's history rules and registered on the note's `UndoManager`, one action per
step:

- `input.type.compose` (every change of a vim command after the first) joins the previous step;
- typing joins adjacent typing within 500 ms until the selection moves;
- anything else starts a new step.

`u`/`<C-r>` and ⌘Z/⇧⌘Z undo the same steps. `vimUndo` returns the change and the selection so
vim's marks and cursor follow. After ⌘Z the cursor goes to the change, instead of reselecting the
removed text (which would start visual mode). Steps outlive vim mode: ⌘Z still undoes them after
vim is turned off.

**Notes.** Replacing the document (`setText(_:resetUndo: true)`, `restore`) gives the editor a
fresh session in normal mode, so no pending command, visual selection or mark crosses notes. A
note's marks belong to its session. Registers, macros, search and ex history, mappings, options
and the jump list live in the shared `Vim`. A replacement that happens during a key (`:e`, `gt`)
waits until the key is done.

**Drawing.** `VimCursorRenderer` draws the block cursor like `@replit/codemirror-vim`:

- the accent at 75 %, with the character under it redrawn in the text color;
- half height while a command is pending, a fifth in replace mode;
- a 1 pt outline while the editor isn't focused;
- on the last character of a forward visual selection, and only on the main range of a visual
  block.

The text view's caret is hidden while the block shows, and visual modes use the native selection.
`VimPanelView` shows the command line or a message under the text: monospaced, with the caret at
the end. ⌘V pastes into it, and a click in the text closes it. `VimSearchHighlighter` marks search
matches in the visible lines with temporary attributes.

**App integration** (`EditorVimIntegration`, a port of `vim-integration.ts`):

- The app's ex commands become `EditorVimRequest`s for the delegate: `:w`, `:wa`, `:q[!]`, `:qa`,
  `:wq`, `:x`, `:wqa`, `:xa`, `:e[dit]`, `:tabe[dit]`, `:tabnew`, `:tabc[lose]`, `:tabn[ext]`,
  `:tabp[revious]`, `:tabN[ext]`, `:bn`, `:bp`, `:bN`, `:bd`, `:obcommand`. An `.unavailable`
  answer shows "`:quit` isn't available here".
- `gt`/`gT` with counts.
- `"+` and `"*` read and write the pasteboard, and `:set clipboard=unnamed|unnamedplus` mirrors
  the unnamed register.
- `applyVimrc`, using `Vimrc` (a port of `vimrc.ts`: comments, `let mapleader`, `exmap`).
  Commands run in a scratch buffer, so their messages never show in a note. A new vimrc first
  clears the mappings, ex aliases and option values the previous one set.

## How it works

| File | Role |
| --- | --- |
| `Tokenizer/` | `MarkdownTokenizer` (block rules per line from a tiny incoming state), `InlineTokenizer` (delimiter/bracket algorithm, linear scans), `LinePrefix` (quotes/lists/tasks, shared with commands), `LinkTargets`. |
| `Styling/MarkdownHighlighter` | Incremental highlighter: owns the line index and each line's entry state (inside a fence or not). An edit re-tokenizes the edited lines, then continues forward only while the state entering the next line changed (toggling a fence restyles until the states re-synchronize); frontmatter is re-evaluated only for edits in its first 200 lines. |
| `Styling/EditorTheme`, `EditorColors`, `StyleSegments`, `BadgeStyle` | Fonts, metrics, cached attribute dictionaries per style; flattening of nested spans; how loud each badge status is. |
| `Layout/GlyphLayoutDelegate` | Live preview and line metrics (below). |
| `Layout/MarkdownLayoutManager`, `DecorationRenderer`, `LivePreviewState` | Backgrounds, bars, rules, checkboxes, bullets, sparkles; what is revealed. |
| `Tokenizer/AgentMarker`, `Controller/MarkdownEditorController+Agent` | The agent marker grammar; sparkles (hit testing, tooltips), anchored-line bands (drawn from `MarkdownTextView.drawBackground(in:)`), link previews, and keeping markers on their line while editing. |
| `View/MarkdownTextView`, `BadgeRenderer`, `LineNumberRulerView` | Thin `NSTextView` subclass forwarding keys/mouse/drawing to the controller; badge layout/drawing/hit-testing; line numbers. |
| `Commands/` | Pure commands returning `TextEdit`s (list editing, tasks, formatting). |
| `Model/` | `LineIndex`, `BadgeStore` (anchors), `TextDiff` (minimal change). |
| `Motion/` | `MotionTimeline`, `CubicBezier` (pure curves of elapsed time), `MotionState` (what moves, with explicit times), `EditorMotion` (clock, Reduce Motion, frames through a `FrameTicker`: the display link; all injectable via `MotionEnvironment`). |
| `Controller/` | `MarkdownEditorController` (composition, public API) and its hooks (drawing, motion frames); `TextSystemBridge` (AppKit delegates). |
| `Vim/` | `TextViewVimHost` (the `VimEditor`: text, selection, edits, keys, layout, one file each), `VimUndoRecorder`, `VimKeyEvents`, `VimCtrlKeys`, `VimCursorRenderer`, `VimPanelView`, `VimSearchHighlighter`, `VimClipboard`, `Vimrc`, `EditorVimIntegration`. |
| `Drawings/`, `Controller/…+Embeds`, `…+EmbedInteraction`, `…+DrawingEditing`, `API/EditorDrawing` | Drawing embeds: `EmbedState` (the host's drawings, sizes, floats, previews, selection), `EmbedGeometry` (sizes and places), `EmbedEdits` (move, resize, remove, insert, drop targets), `EmbedInteraction`/`EmbedHandle` (a press becoming a move or a resize), `DrawingEditSession` (the canvas in place). The tokenizer marks an embed line with one `.embed` marker; the highlighter keeps the embed lines; the layout delegate sizes their line fragments (`embedFragment`). |
| `View/EditorContainerView`, `API/EditorVim` | The embeddable view (scroll view + command line); vim's status and app requests. |

TextKit 1 techniques worth knowing before changing things (each verified experimentally):

- **Hiding syntax** uses the `.null` glyph property from
  `layoutManager(_:shouldGenerateGlyphs:…)` — except for a hidden character at the very start of a
  line, which becomes a zero-advance control glyph: TextKit attaches leading null glyphs to the
  previous line fragment, dropping the paragraph's first-line indent and spacing.
- **Checkbox and bullet slots**: the marker's first character becomes a control glyph with the
  `.whitespace` action, whose width comes from `boundingBoxForControlGlyphAt`; the renderer draws
  into it.
- **Line height**: fixed min/max line heights put glyphs at the bottom of the line box; the delegate
  moves the baseline (`shouldSetLineFragmentRect`) using a per-block value stored in the attributes.
- **Restyle timing**: restyling happens in `textStorage(_:didProcessEditing:)`. Attribute changes
  made in `willProcessEditing` are merged into the edited range, and NSTextView then puts the caret
  at the end of that range instead of after the typed character. Since `didProcessEditing` changes
  aren't reported to the layout manager, `MarkdownLayoutManager` invalidates the restyled lines
  right after it processed the edit, and the controller fixes their attributes (font fallback).
- **Typing attributes** are set from the caret's own line on every selection change. A typed
  character with another paragraph style (a list line's hanging indent) makes the storage re-fix the
  whole paragraph and widens every keystroke's edit.
- Selection changes only regenerate glyphs for lines entering or leaving the revealed set (or whose
  checkbox touch state changed); layout is non-contiguous, so line geometry far from what's laid out
  is an estimate (`scrollToLine` scrolls the range visible first). Not while a note has drawn
  floats: see [Drawings](#drawings).
- **Line fragments** can be resized from `shouldSetLineFragmentRect` (an embed row's height, a
  float's zero height) and TextKit lays the next line after the new rect. Moving a fragment's
  origin there confuses layout, so a row that must clear a float grows instead. Exclusion paths
  keep non-contiguous layout on, but only contiguous layout gives a float's line its real position.

## Performance

2,000-line note with mixed markdown and 30 badges, offscreen, Apple silicon
(`PerformanceTests`; printed as `PERF …`):

| Measurement | Target | Release | Debug |
| --- | --- | --- | --- |
| Initial load + style (+ layout of the visible rect), median | < 60 ms | 20.6 ms | 63 ms |
| Keystroke: `insertText` + restyle + badge remap + layout of the line | avg < 3 ms, p95 < 8 ms | 0.38 / 0.62 ms | 0.49 / 0.70 ms |
| Selection change with live preview (reveal state + glyph invalidation) | < 2 ms | 0.024 ms avg | 0.038 ms avg |
| … plus relayout of the revealed lines, p95 | | 0.13 ms | 0.17 ms |
| Pure tokenizer, whole note | | 2.4 ms | 15 ms |
| Before each draw: badge layouts and sparkles (every tenth line the agent's) | | | 0.05 ms avg |

The same note with six drawings (floats on both sides, rows; `DrawingPerformanceTests`, same
budgets as the keystroke test). A sample is the keystroke, the layout of its line and the pre-draw
pass that checks floats; no exclusion path changes while typing:

| Measurement | Release | Debug |
| --- | --- | --- |
| Keystroke next to a float (avg / p95) | 0.48 / 0.75 ms | 0.74 / 1.06 ms |
| Keystroke above every drawing (floats checked each time) | 0.42 / 0.64 ms | 0.65 / 0.84 ms |
| Load + style + visible layout, median | 18.9 ms | 64 ms |

Motion adds nothing to these paths: typing and selection changes only check that nothing moves.
Assertions use generous debug budgets scaled by `EDITOR_PERF_BUDGET_MULTIPLIER`. Release numbers:
`apps/macos/scripts/test.sh DailyDoListEditor -- -c release -Xswiftc -enable-testing --filter PerformanceTests`.

Vim mode on a 10,000-line note with live preview, keys sent through `keyDown`, every sample counted
(`VimPerformanceTests`, same budgets as the keystroke test; avg / p95):

| Measurement | Release | Debug |
| --- | --- | --- |
| Insert-mode keystroke: vim → NSTextView → restyle → report back to vim | 1.18 / 1.83 ms | 1.86 / 3.75 ms |
| … the same keystroke without vim | 1.18 / 1.90 ms | 1.70 / 2.55 ms |
| Normal-mode motions (`j w k b l h e`) | 0.13 / 0.21 ms | 0.26 / 0.35 ms |
| Normal-mode edits and undo (`x u dd p`) | 0.84 / 1.47 ms | 1.37 / 2.22 ms |

Vertical motion asks TextKit for the line at a height (`vimLine(atY:)`), not a uniform line
height, so `j` stays this fast next to headings and wrapped lines.

## Tests

```sh
apps/macos/scripts/test.sh DailyDoListEditor                        # everything (plain `swift test` fails with the CLT)
apps/macos/scripts/test.sh DailyDoListEditor -- --filter HighlighterTests
apps/macos/scripts/test.sh DailyDoListEditor -- --filter Vim         # vim mode, vectors included
VIM_VECTORS_FILTER=viewport/ VIM_VECTORS_VERBOSE=1 apps/macos/scripts/test.sh DailyDoListEditor -- --filter VimVectorReplayTests
```

Swift Testing, 294 tests (plus parameterized cases): tokenizer tables (unicode offsets, nesting,
unterminated constructs, code spans, URLs with underscores, tags vs headings vs URLs), an
incremental-vs-full equivalence property test (3 seeds × 500 random edits including fence and
frontmatter toggles, comparing line states and every attribute run), command tables ported from
the web editor, editor-level commands and undo, badge remapping, badge styles (and the hierarchy
checked on rendered pixels), live preview glyph properties, minimal-diff `setText`, snapshots with
separate undo histories, checkbox/badge/link hit testing, motion (curves against brute force, the
timeline, and motion driven through the controller with a manual clock and ticker: what starts
it, what each frame redraws, that frames stop, Reduce Motion, hidden windows), fuzzing (random and
pathological lines, random edits with drawing), agent lines (marker grammar, colors, hidden
markers and sparkle slots, sparkle clicks and tooltips, the caret and Enter around markers),
anchored-line bands (also checked on pixels), link previews and the shared tooltip (on virtual
time: the delay, gliding between badge, sparkle and link, fading out, a note switch), remote
changes (caret, badges and undo), performance, and offscreen PNG renders written to
`.build/editor-snapshots/` for manual review (ignored by git): the sample note (light, dark, source
mode with line numbers), badges in every status (light, dark), narrow-window badges, agent lines
with an anchored line (light, dark, source mode), tooltips over a badge and the sparkle (light,
dark), and a frame in the middle of every kind of motion.

Drawings have 54 of these tests, driving an editor in an offscreen window with real `NSEvent`s
and a delegate that serves synthetic drawings (`Support/DrawingTestSupport.swift`):

- **Embeds** (`DrawingEmbedTests`): which lines are embeds, the embed lines through edits, sizes
  and placements, the syntax on the caret's line and in source mode, hosts without drawings,
  loading, missing and unreadable drawings.
- **Wrapping**: glyph rects stay out of a float's box on both sides, typing next to a float
  never overlaps it and never recomputes it, a line added above moves it, stacked floats, rows
  below floats.
- **Edits** (`EmbedEditTests`): the web's `embeds.test.ts` cases for move, resize, remove, insert
  and drop targets.
- **Interaction** (`DrawingInteractionTests`): click, Escape, clicking text, Delete and its undo,
  arrows, typing, dragging to another line and side (the drop target while dragging), full width,
  resizing from the corner (the box follows), handles' tooltips, read-only, inserting, the
  context menu.
- **Editing in place** (`DrawingEditingTests`): Return and double-click, drawing (changes reported,
  the note untouched), Escape twice, a click outside, vim not taking keys, the box growing,
  versions from the host, the embed's line going away, switching notes.
- **Snapshots** (`drawings-{light,dark}.png`, `drawings-selected.png`,
  `drawings-editing-{light,dark}.png`), with pixel checks inside the boxes.
- **Performance** (`DrawingPerformanceTests`): the numbers below.

Vim mode has 65 of these tests (`Tests/DailyDoListEditorTests/Vim/`), all driving the editor with
real `NSEvent`s through `keyDown`:

- **Vectors** (`VimVectorReplayTests`): every case of `packages/editor/test/vim/vectors.jsonl`,
  replayed through the real controller with `DailyDoListVimTestSupport`, with live preview both
  off and on: 11,491/11,491 each, in all 18 categories, with no exclusions. The oracle recorded
  them in a monospaced, unwrapped editor, so the replay gives the controller those metrics
  (internal `EditorTheme.Uniform`), and viewport cases (`H`, `zz`, `<C-d>`) compare exactly.
  An exclusion needs a reason in that file.
- **Keys**: `NSEvent` to vim key mapping.
- **Typing and undo**: `.`, list continuation, undo grouping, ⌘Z against `u`, IME, visual block
  and several cursors.
- **Interface**: the block cursor (geometry, and pixels with and without focus, rendered to
  `vim-block-cursor-{light,dark}.png`), the command line (key routing, ⌘V, Esc, clicks), search
  highlights, the status.
- **Lifecycle**: mouse selections, paste, badges through `dd`/`u`, switching notes, and turning
  vim on and off.
- **Integration**: ex commands, `gt`, the clipboard on a private pasteboard, the vimrc, and the
  integration being released.
- **Layout and performance**: headings and wrapped lines, and the numbers above.

## Saving and merging (the app)

The editor never saves: the app's `NotesStore` does, with the same algorithm as the web app's
`NotesController` (described in `packages/editor/README.md`).

- **Per note** it knows the server text and version it last saw, and whether there are unsaved
  edits (a counter bumped by every `editorTextDidChange`, against the last one the daemon
  acknowledged). `setText` and `applyRemoteChanges` never report a change, so only the user's own
  edits count. The editor's text is read only when a save or a merge happens.
- **Saving:** 300 ms after the last edit (sooner on ⌘S, `:w`, switching notes, the window
  losing focus) it writes the text with `baseVersion` = the version it last saw, one write in
  flight per note. A note without unsaved edits never writes.
- **Someone else's change:** without unsaved edits, the active note gets `setText` (one minimal
  change) and an inactive note drops its snapshot. With unsaved edits, `TextMerge` merges them
  (base = the server text the edits started from), the editor gets only the other side's changes
  through `applyRemoteChanges`, and the result is saved on top of the new version; a 409 merges the
  same way. Like `mergeText`, `TextMerge` splits a replaced block into the lines edited and the
  lines added next to them before merging, so an agent line added under a task survives an edit of
  that task. When both changed the same lines, the user's version of those lines wins and the other
  version is saved as `<name> (conflict).md`.
- **Unsaved text** captured from the editor (when a save starts, or merged into a note that isn't
  shown) exists only while there are unsaved edits. A note shown without a snapshot (a remote
  change dropped it) shows that text, else the server's, never an older copy.

**The guarantee:** an editor without unsaved typing never writes text the vault didn't have, and a
merge never brings back a line deleted elsewhere unless the user typed it. `TextMergeTests`
(properties over a seeded generator, and the vectors shared with `@ddl/core`), `RemoteDeleteTests`
and `RemoteDeleteModelTests` (seeded interleavings of typing, tab switches, focus loss, agent lines,
an API client deleting lines and events in any order) pin it. One difference from the web editor:
remote changes are an undoable step here, so ⌘Z (or `u`) right after one takes it back, like any
edit, and saves the result.

## Integration notes

- Embed `view` (or `MarkdownEditorView`) and keep one controller per editor pane; switch
  notes with `snapshot()`/`restore(_:)`, then `setBadges` for the new note. If the note changed on
  disk while it was in the background, call `setText(_:)` after `restore` (minimal, undoable diff).
- Don't replace `textView.delegate`, the text storage's delegate or the layout manager's delegate:
  the editor relies on them (text changes, per-note undo, styling, live preview).
- The host owns saving: debounce `editorTextDidChange`; `editorDidRequestSave` is ⌘S.
- Menus: editor shortcuts take precedence while it's focused; the standard Edit menu's Undo/Redo
  use the note's undo manager through the text view.
- Vim: create one `Vim` and one `EditorVimIntegration` per app and keep both (the integration's
  commands stop when it's released); set `vim` on every controller and apply the vimrc before
  turning `vimMode` on, so new sessions start with its mappings.

## Known limitations

- Checkboxes and badges are drawn, not accessibility elements (the text itself is accessible).
- No setext headings, indented code, tables or images (shown as source); callouts render as plain
  quotes; fences inside blockquotes or list items aren't code.
- Badges that go away disappear without a fade.
- A revealed list line keeps the wrap indent of its rendered form (slightly off while editing it).
- `[[#Heading]]` links (same note, no target) aren't reported; the delegate has no subpath.
- Drawings:
  - The drawing and its handles are drawn, not accessibility elements.
  - Two floats on the same side stack below each other (CSS would put the second beside the
    first when there's room).
  - Undoing the removal of an embed selects its line, so its syntax shows until the caret moves.
  - Moving the caret down with ↓ skips a float's line (it has no height); ← from the next line
    reaches it and shows its syntax.
  - Image embeds (`![[photo.png]]`) still show as syntax.
- Enter doesn't continue plain indented continuation lines of list items; loose lists continue tight.
- With line numbers and readable line length, the gutter stays at the left edge.
- Vim mode:
  - ⌘Z after a vim operator puts the cursor at the change; the web app reselects the text, which
    starts visual mode.
  - The block cursor doesn't blink.
  - The command line takes no input methods or dead keys.
  - With several cursors, arrow keys collapse them.
  - Marks don't survive switching notes (as in the web app).
  - As in vim.js, a mapping can't start with a key vim binds by itself (`,` or Space as the
    leader): that key's own command runs first.
