# DailyDoListEditor

Native markdown editor for the Daily Do List macOS app: an `NSTextView` on an explicit TextKit 1
stack (`NSTextStorage` → `NSLayoutManager` → `NSTextContainer`) that edits plain markdown with
Obsidian-style live preview, clickable task checkboxes, agent status badges and Obsidian's list and
formatting commands. It has no dependencies on the other packages; `packages/editor` (the web
CodeMirror editor) is its behavioral reference.

```swift
let editor = MarkdownEditorController(configuration: EditorConfiguration(fontSize: 16))
editor.delegate = self                       // MarkdownEditorDelegate (all methods optional)
editor.setText(noteMarkdown, resetUndo: true) // note switch
editor.setBadges([EditorBadge(id: "t1", line: 4, status: "working", label: "Researching…")])

// SwiftUI
MarkdownEditorView(controller: editor)
// AppKit
container.addSubview(editor.scrollView)
```

## Public API

| API | Notes |
| --- | --- |
| `MarkdownEditorController(configuration:)` | One editor. `scrollView` is the view to embed; `textView` is the `NSTextView` inside it. |
| `text`, `setText(_:resetUndo:)` | `setText` never notifies the delegate. Without `resetUndo` it applies one minimal replacement (common prefix/suffix, whole lines aligned), so selection, scroll and badge anchors survive; the change is undoable (read-only editors clear undo instead). With `resetUndo` it replaces the document, clears undo and badges, and puts the caret at the start. `\r\n`/`\r` become `\n`. |
| `setBadges(_:)`, `badges` | Badges are anchored to their line and remapped through edits; `badges` returns them with current lines. `idle`/`ignored` are kept but not drawn. |
| `configure(_:)`, `configuration` | Font size (restyles), live preview, readable line length, spellcheck, line numbers, editable. |
| `focus()`, `moveCaretToEnd()`, `scrollToLine(_:)` | `focus()` before the editor is in a window applies once it is (the first note at launch). `moveCaretToEnd` puts the caret after the last line and scrolls to it. `scrollToLine` puts the caret at the line start and centers it (0-based, clamped). |
| `snapshot()`, `restore(_:)` | Text, selection, scroll offset and the note's own `UndoManager` for instant tab switches. `restore` and `setText(_:resetUndo: true)` start a new document: badges are cleared and the caret line is always reported. |
| `delegate` | `editorTextDidChange` (user edits only, including undo), `didClickBadge` (with its current line), `didClickWikiLink(target:newWindow:)`, `didClickLink(url:)`, `cursorDidMoveToLine` (only when the line changes), `editorDidRequestSave`. |

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
YAML frontmatter as small monospaced metadata, links and wikilinks in the accent color (`#7F6DF2`,
lighter in dark mode; markdown links and URLs underlined), blockquotes with accent bars and muted
text, completed tasks struck through and muted (cancelled ones fainter), horizontal rules as a thin
line. Wrapped list items align with their text. Colors are dynamic (light/dark).

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
task. Nothing is revealed while the editor isn't first responder. With live preview off, all syntax
shows dimmed. A caret landing inside hidden syntax (vertical moves, clicks) snaps to its edge;
clicks land next to the visible character clicked.

**Checkboxes.** SF Symbols in the accent color: `square` (open), `checkmark.square.fill` (done),
`square.lefthalf.filled` (`[/]`), `minus.square` (`[-]`, gray), `arrow.right.square` (`[>]`),
plus `arrow.left.square`, `questionmark.square`, `exclamationmark.square`. Clicking toggles
`[ ]` ↔ `[x]` (other statuses → `[x]`) as an undoable edit, never in a read-only editor.

**Badges.** Drawn after the text on the last line fragment of their line: a status dot (triaging
accent, queued gray, working blue, needs-you amber, done green, failed red, cancelled gray), the
label shortened to ~28 characters and, with unread messages, a 6 pt accent dot (the tooltip says
"N unread", `99+` max). Only badges that need the user are loud (`BadgeStyle`):
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

## How it works

| File | Role |
| --- | --- |
| `Tokenizer/` | `MarkdownTokenizer` (block rules per line from a tiny incoming state), `InlineTokenizer` (delimiter/bracket algorithm, linear scans), `LinePrefix` (quotes/lists/tasks, shared with commands), `LinkTargets`. |
| `Styling/MarkdownHighlighter` | Incremental highlighter: owns the line index and each line's entry state (inside a fence or not). An edit re-tokenizes the edited lines, then continues forward only while the state entering the next line changed (toggling a fence restyles until the states re-synchronize); frontmatter is re-evaluated only for edits in its first 200 lines. |
| `Styling/EditorTheme`, `EditorColors`, `StyleSegments`, `BadgeStyle` | Fonts, metrics, cached attribute dictionaries per style; flattening of nested spans; how loud each badge status is. |
| `Layout/GlyphLayoutDelegate` | Live preview and line metrics (below). |
| `Layout/MarkdownLayoutManager`, `DecorationRenderer`, `LivePreviewState` | Backgrounds, bars, rules, checkboxes, bullets; what is revealed. |
| `View/MarkdownTextView`, `BadgeRenderer`, `LineNumberRulerView` | Thin `NSTextView` subclass forwarding keys/mouse/drawing to the controller; badge layout/drawing/hit-testing; line numbers. |
| `Commands/` | Pure commands returning `TextEdit`s (list editing, tasks, formatting). |
| `Model/` | `LineIndex`, `BadgeStore` (anchors), `TextDiff` (minimal change). |
| `Motion/` | `MotionTimeline`, `CubicBezier` (pure curves of elapsed time), `MotionState` (what moves, with explicit times), `EditorMotion` (clock, Reduce Motion, frames through a `FrameTicker`: the display link; all injectable via `MotionEnvironment`). |
| `Controller/` | `MarkdownEditorController` (composition, public API) and its hooks (drawing, motion frames); `TextSystemBridge` (AppKit delegates). |

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
  is an estimate (`scrollToLine` scrolls the range visible first).

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

Motion adds nothing to these paths: typing and selection changes only check that nothing moves.
Assertions use generous debug budgets scaled by `EDITOR_PERF_BUDGET_MULTIPLIER`. Release numbers:
`apps/macos/scripts/test.sh DailyDoListEditor -- -c release -Xswiftc -enable-testing --filter PerformanceTests`.

## Tests

```sh
apps/macos/scripts/test.sh DailyDoListEditor                        # everything (plain `swift test` fails with the CLT)
apps/macos/scripts/test.sh DailyDoListEditor -- --filter HighlighterTests
```

Swift Testing, 157 tests (206 parameterized cases): tokenizer tables (unicode offsets, nesting,
unterminated constructs, code spans, URLs with underscores, tags vs headings vs URLs), an
incremental-vs-full equivalence property test (3 seeds × 500 random edits including fence and
frontmatter toggles, comparing line states and every attribute run), command tables ported from
the web editor, editor-level commands and undo, badge remapping, badge styles (and the hierarchy
checked on rendered pixels), live preview glyph properties, minimal-diff `setText`, snapshots with
separate undo histories, checkbox/badge/link hit testing, motion (curves against brute force, the
timeline, and motion driven through the controller with a manual clock and ticker: what starts
it, what each frame redraws, that frames stop, Reduce Motion, hidden windows), fuzzing (random and
pathological lines, random edits with drawing), performance, and offscreen PNG renders written to
`.build/editor-snapshots/` for manual review (ignored by git): the sample note (light, dark, source
mode with line numbers), badges in every status (light, dark), narrow-window badges, and a frame
in the middle of every kind of motion.

## Integration notes

- Embed `scrollView` (or `MarkdownEditorView`) and keep one controller per editor pane; switch
  notes with `snapshot()`/`restore(_:)`, then `setBadges` for the new note. If the note changed on
  disk while it was in the background, call `setText(_:)` after `restore` (minimal, undoable diff).
- Don't replace `textView.delegate`, the text storage's delegate or the layout manager's delegate:
  the editor relies on them (text changes, per-note undo, styling, live preview).
- The host owns saving: debounce `editorTextDidChange`; `editorDidRequestSave` is ⌘S.
- Menus: editor shortcuts take precedence while it's focused; the standard Edit menu's Undo/Redo
  use the note's undo manager through the text view.

## Known limitations

- Checkboxes and badges are drawn, not accessibility elements (the text itself is accessible).
- No setext headings, indented code, tables or images (shown as source); callouts render as plain
  quotes; fences inside blockquotes or list items aren't code.
- Badges that go away disappear without a fade.
- A revealed list line keeps the wrap indent of its rendered form (slightly off while editing it).
- `[[#Heading]]` links (same note, no target) aren't reported; the delegate has no subpath.
- Enter doesn't continue plain indented continuation lines of list items; loose lists continue tight.
- With line numbers and readable line length, the gutter stays at the left edge.
