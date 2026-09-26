# DailyDoListVim

Vim mode for the native editors, ported from the one the web app uses: `vim.js` from
`@replit/codemirror-vim-core` 0.1.0 and its CodeMirror 6 adapter `@replit/codemirror-vim` 6.4.0
(the engine behind Obsidian's vim keybindings). The goal is that every key sequence does exactly
what it does in the web app, quirks included: same motions, operators, text objects, registers,
marks, macros, `.` repeat, search, ex commands, mappings, undo steps and cursor columns.

Foundation only, no dependencies, Swift 6 language mode with strict concurrency, macOS 14 and
iOS 17. Third-party attribution: `NOTICE.md`.

Exactness is checked against the web app's behavior vectors (`packages/editor/test/vim`,
11,497 cases recorded from the engine in Chromium): **all of them pass**, without exclusions.

## How it is built

```
host editor (NSTextView, …)          VimTextBuffer (reference host, tests)
        │  implements VimEditor: a few primitives (lines, selection, apply, undo, layout, panels)
        ▼
EditorAdapter      the CodeMirror 5 API vim.js calls, with CodeMirror 6 semantics: selection
                   normalization, change batching per operation, bookmarks, search cursor,
                   vertical motion, indentation, newline-and-indent, bracket matching
        ▼
Engine             vim.js: keymap, key handler, dispatcher, motions, operators, actions, text
                   objects, search, registers, marks, macros, options, langmap, ex commands
        ▲
Vim (global state) + VimSession (one per editor): the public API
```

`Regex/` and `Support/` provide JavaScript semantics: UTF-16 strings (`VimText`), JavaScript
regular expressions on top of ICU (`JSRegExp`), full case mapping, `parseInt` and number
formatting. Source files follow vim.js's sections and keep its function names, so a change
upstream can be found and ported.

## Public API

| Type | Role |
| --- | --- |
| `Vim` | Global state shared by the editors of an app: registers, marks' jump list, search and command history, macros, mappings, options, ex commands. `map`/`noremap`/`unmap`/`mapclear`, `setOption`/`getOption`/`defineOption`, `setLangmap`, `defineEx`, `defineRegister`, `register(_:)`, `resetGlobalState()`, `isMac`, `clipboard`, `onError`. For hosts: `defineAction`/`mapAction` (app keys like `gt`, arguments in `VimActionArguments`), `installRegister` (replace a register, e.g. `+` on the pasteboard), and the hooks `didMapclear` (re-map app keys), `didPushText` and `unnamedPasteRegister` (`set clipboard=unnamed`). |
| `VimSession` | Vim attached to one editor (`vim.attach(to:)`): `handleKey(_:nativeEdit:)`, `vimKey(for:)`, `handleEx(_:)`, `mode`, `pendingKeys`, `pendingRegister`, `isRecordingMacro`, `recordingRegister`, `activePrompt`, `panel`, `isAttached`, `notify(_:)` (a message in the command line); callbacks `onModeChange` (vim-mode-change), `onKeypress` (vim-keypress), `onCommandDone` (vim-command-done), `onError`; host reports `editorDidChange(_:)`, `editorSelectionDidChange()`, `willPaste()`; `detach()`. Marks of a detached session no longer resolve. |
| `VimEditor` | The protocol a host implements (see below). Offsets are UTF-16 code units, a line break counts one. |
| `VimTextBuffer` | In-memory `VimEditor` that behaves like the web app's CodeMirror 6 editor (history grouping and the vectors' fixed viewport included). Test double, vector replay host, reference implementation. `performNativeEdit(for:)` does what a text view does with a key vim leaves to it. |
| `VimPanel` | A prompt (`:`, `/`, `?`, `:s///c`), a message or the "recording @q" status. `handleKey` emulates the prompt's text field; `keyDown`/`setValue`/`keyUp` serve a host's own field. |
| `VimKeyNotation`, `VimKeyInput` | Key presses (key + modifier flags) to vim key names: `VimKeyNotation.vimKey(for:isMac:)` is vim.js's `vimKeyFromEvent`, pure and platform neutral; `VimSession.vimKey(for:)` adds 'langmap'. |
| `VimScheduler`, `MainQueueVimScheduler`, `ManualVimScheduler` | vim's timers (search highlight after 50 ms, the insert-mode mapping timeout); tests advance a manual clock. |
| `VimClipboard`, `VimRegister` | The `+` register's backing store; custom registers for `defineRegister`. |
| `VimTransaction`, `VimChange`, `VimSelection`, `VimPosition`, `VimRange`, `VimViewport`, `VimRect`, `VimPoint`, `VimSearchHighlight`, `VimOptionValue`, `JSException`, `VimText` | Values crossing the API. `VimTransaction.selectionIsExplicit` says whether vim set the selection (CodeMirror's history records only those selection-only transactions). |
| `VimChangeSet` | CodeMirror's `ChangeSet` for hosts that keep their own history: `changedRanges`, `composed(with:)`, `inverted(original:)`, `mapPosition`/`mapSelection`, and `VimTransaction(changeSet:selection:userEvent:scrollIntoView:)` to report an edit made of several steps (an IME composition). |

```swift
let vim = Vim()                              // once per app
let buffer = VimTextBuffer("one two three")
let session = buffer.attach(to: vim)         // keep both alive while in use
for key in ["d", "w", "."] { session.handleKey(key) }
// buffer.text == "three"
```

Keys use vim notation: one character (`"a"`, `"é"`, `"<"`) or a named key (`"<Esc>"`, `"<CR>"`,
`"<BS>"`, `"<C-d>"`, `"<S-Tab>"`, `"<A-x>"`, `"<Space>"`). Everything runs on the main actor.

## Integrating with an NSTextView

The Mac editor does all of this: `TextViewVimHost` and its extensions in
`Packages/DailyDoListEditor/Sources/DailyDoListEditor/Vim/` (see that package's README for the
design). The steps below are what any text view host needs. `NSTextStorage` is UTF-16, so vim's
offsets are `NSRange` locations as they are.

1. **One `Vim` per app.** In the web app the engine's state is global to the page: registers,
   the jump list, history and mappings are shared by all editors. Set `vim.isMac = true` (Option
   combinations type characters), `vim.clipboard` (an `NSPasteboard` wrapper) and `vim.onError`.
   User mappings and options (`:map`, `:set`) can be replayed from settings at launch. The Mac
   editor's `EditorVimIntegration` does all of this, plus the app's ex commands and the vimrc.

2. **Implement `VimEditor`** on the object that owns the text view:
   - *Text*: `vimLineCount`, `vimLine`, `vimLineStart`, `vimLineNumber(at:)`, `vimLength`. Keep a
     line-start index updated from `textStorage(_:didProcessEditing:range:changeInLength:)`; vim
     asks for lines around the cursor on every key, never for the whole document.
   - *Selection*: `vimSelection` from `selectedRanges` (several ranges while vim edits a visual
     block; keep the main one first or track its index).
   - *Editing*: `vimApply(_:)` applies `changes` (offsets in the document before the
     transaction; apply the last first) as one edit (`shouldChangeText(inRanges:)`,
     `replaceCharacters`, `didChangeText`), then sets the selection and scrolls if
     `scrollIntoView`. Don't report these edits back through `editorDidChange`.
   - *Undo*: `vimUndo()`/`vimRedo()` undo one step and return what was applied (changes and the
     selection afterwards), so marks and `.` can follow. To group steps like the web app, use the
     transaction's `userEvent`: vim labels every change after the first of a command
     `input.type.compose` (always joins the previous step); the first is
     `input.type.compose.start`; the host's own typing is `input.type` and joins adjacent typing
     until the selection moves. `VimTextBuffer` implements CodeMirror 6's exact rules
     (`Buffer/UndoHistory.swift`) and is a model to follow.
   - *Configuration*: `vimTabSize` and `vimIndentUnit` ("\t" or spaces) must match the note's
     settings (they drive `>>`, `<<`, `o`, `<C-t>` and visual columns); `vimIsReadOnly`.
   - *Layout*: `vimLineHeight`, `vimTextHeight` (ascent + descent), `vimViewport` (scroll offset
     and visible size of the scroll view, content height), `vimScroll`, `vimScrollIntoView`,
     `vimCoords(at:side:)` (the glyph box of a position, from the layout manager) and
     `vimOffset(at:)` (the character boundary nearest to a point). They serve `H`/`M`/`L`,
     `gj`/`gk`, page and half-page scrolling and `z` commands. With lines of different heights
     (headings, wrapped lines), also answer `vimLine(atY:)` and `vimLineTop(_:)` from the layout.
     The defaults assume `vimLineHeight` per line, and then vertical motion scans many lines of a
     long note. Vertical motion works on these coordinates, so `gj`/`gk` follow the host's wrapped
     lines.
   - *Interface*: `vimShowPanel` (a command-line area under the editor showing `panel.text` and,
     for prompts, `panel.value`; re-render on `panel.onUpdate`), `vimShowSearchHighlight`
     (temporary attributes for `highlight.matches(from:to:)` over the visible range), `vimFocus`,
     `vimSave` (`:w`), and optionally `vimPerformKey` for keys vim replays through the editor's
     bindings (recorded Backspace/Delete, arrow keys in insert-mode mappings).

3. **Attach**: `session = vim.attach(to: host)` when vim mode is turned on, `session.detach()`
   when it is turned off. The session doesn't retain the host (the host usually owns the session).

4. **Route keys** from `keyDown(with:)`:
   ```swift
   override func keyDown(with event: NSEvent) {
     guard let session, !hasMarkedText(), let input = VimKeyInput(event),  // your NSEvent mapping
       let key = session.vimKey(for: input)
     else { return super.keyDown(with: event) }
     let handled = session.handleKey(key, nativeEdit: {
       super.keyDown(with: event)  // insert mode: the text view types or deletes as usual
       return true
     })
     if !handled { super.keyDown(with: event) }
   }
   ```
   Build `VimKeyInput.key` from the key code for named keys ("Escape", "Enter", "Backspace",
   "Delete", "Tab", "ArrowUp", …, "F1"), else from `charactersIgnoringModifiers` when Control or
   Command is held and from `characters` otherwise; pass the modifier flags and, for non-Latin
   layouts, `code` ("KeyQ"). `handleKey` routes the key to the open prompt when there is one,
   applies replace mode's overwrite and calls `nativeEdit` only for keys vim leaves to the editor
   in insert mode, then lets vim record Backspace/Delete for `.`.

5. **Report the host's own edits and selections**: typing, paste, drag and drop and
   autocorrect reach vim through `session.editorDidChange(_:)` (the changes in pre-edit offsets
   and the selection afterwards); mouse selections through `session.editorSelectionDidChange()`
   (vim enters or leaves visual mode to match); `session.willPaste()` before a paste (in normal
   mode vim moves right and enters insert mode first).

6. **Prompts**: either keep routing keys through `session.handleKey` (the package emulates the
   web app's input field: the caret stays at the end) and draw `panel.value`, or show your own
   field and call `panel.keyDown(key)` (returns true when the field must not handle the key),
   `panel.setValue(field.stringValue)` after edits, and `panel.keyUp(key)`.

7. **Status**: show `session.mode` ("-- INSERT --", block cursor in normal, visual and replace
   mode), `session.pendingKeys` ("2d"), `pendingRegister` (`"a`), `isRecordingMacro` and
   `recordingRegister` (`recording @q`).

8. **Switching documents**: vim's per-editor state (marks, visual mode, a pending command,
   insert-mode recording) belongs to the session. Detach and attach a new session when the
   editor shows another note. The web app starts every note fresh the same way, and marks of the
   detached session stop resolving. Do it after the current key, not while `handleKey` runs.

## What is ported

All of vim.js 0.1.0: every entry of `defaultKeymap` (motions, operators, actions, text objects,
search, marks, jumps, macros, registers, visual, visual line and visual block mode, replace mode,
insert-mode commands, `<C-a>`/`<C-x>`, `gq`/`gw`, scrolling), every command of
`defaultExCommandMap` with its parser and ranges (`:s` with every flag and `c` confirmation,
`:g`/`:v`, `:sort` with its options and patterns, `:normal`, `:registers`, `:marks`, `:delmarks`,
`:set`/`:setlocal`/`:setglobal` in all their forms, the map and mapclear families, `:delete`,
`:yank`, `:put`, `:join`, `:undo`, `:redo`, `:write`, `:startinsert`, `:nohlsearch`),
key-to-key and key-to-ex mappings with `noremap`, 'langmap', insert-mode change recording for `.`,
multiple-selection editing (visual block insert and friends), and the adapter's CodeMirror 6
behavior (search in unicode mode, undo grouping, bookmarks, `newlineAndIndent` without a language,
`indentMore`/`indentLess`, smart home for `g^`, grapheme-cluster Backspace).

Not ported, or deliberately different:

- **Language-dependent behavior**: the web editor has no language for plain notes, so `=`
  (`indentAuto`), `gc` (comments), the tag objects `it`/`at`, `%` skipping brackets in strings or
  comments and `:set filetype` do what they do there: nothing, or plain bracket matching.
- **Folding** (`zc`, `zo`, `za`, `zR`, `zM`): notes have no folds.
- **Soft wrapping** in `VimTextBuffer`: it doesn't wrap, like the vectors' oracle. A host that
  wraps (the Mac editor) gets display-line `gj`/`gk` from its own `vimCoords`.
- **Right-to-left text**: `cursorCharLeft`/`Right` move in logical order.
- **Web-only plumbing**: the `<C-c>` copy interception (on the Mac `<C-c>` isn't copy), the async
  clipboard read of `"+p` (the Mac clipboard is read synchronously), the DOM status bar and block
  cursor (the host draws them from `mode` and `pendingKeys`), `showMatchesOnScrollbar`.
- **Timers** run through `VimScheduler` instead of `setTimeout`.

CodeMirror 6 artifacts the web app shows are kept, for example: `L`/`M` go to the first line when
the empty last line of the document is at the bottom of the screen (CodeMirror's precise
`posAtCoords` treats that line as outside the viewport); vertical motion measures the glyph box,
not the line box, and skips to the next line when it lands in the line spacing.

## JavaScript semantics

- **Columns are UTF-16 code units**, like JavaScript string indices: an emoji is two columns and
  vim can put the cursor between its halves (`I` on a line starting with an emoji does). Word
  characters are tested one code unit at a time with `CodeMirror.isWordChar`
  (`[\w\p{Alphabetic}\p{Number}_]`), so surrogate halves are punctuation.
- **Case mapping** is JavaScript's full mapping (`~` on `ß` gives `SS`, Final_Sigma for `Σ`).
- **Numbers**: `parseInt` rounds like V8 (`<C-a>` on 99999999999999999999 gives
  100000000000000000000), `toString(radix)` and `Math.round` match too.
- **Regular expressions** are parsed with ECMAScript 2025 syntax (Annex B without the `u` flag,
  V8's error messages) and compiled to ICU patterns with JavaScript's meaning: ASCII `\w`/`\d`/`\b`,
  JavaScript `\s` and line terminators, `^`/`$` per the `m` flag, literals that can't turn into ICU
  syntax, named groups, `(?i:)` modifiers, and emulation of unbounded look-behind at the start of
  a pattern. vim's searches run in unicode mode (CodeMirror's search cursor), where ICU and
  JavaScript agree. Known differences, none of which vim's own patterns hit in practice:
  - without the `u` flag, ICU still reads a surrogate pair as one character (`.` consumes both
    halves); affects `:sort /pattern/` on lines with emoji;
  - case-insensitive matching uses ICU's simple case folding: `ſ` and `K` (Kelvin) match `s` and
    `k` even without `u`, and `ẞ` matches `ß` (JavaScript canonicalizes differently);
  - a capture inside a repeated group keeps its value from an earlier iteration, and a
    backreference to a group that didn't participate fails instead of matching empty;
  - an unbounded look-behind that isn't at the start of the pattern (`a(?<=b.*)c`) is rejected,
    and captures inside a look-behind match left to right.

## Tests

```sh
apps/macos/scripts/test.sh DailyDoListVim                          # everything
apps/macos/scripts/test.sh DailyDoListVim -- --filter VectorReplayTests
VIM_VECTORS_FILTER=viewport/ VIM_VECTORS_VERBOSE=1 apps/macos/scripts/test.sh DailyDoListVim -- --filter VectorReplayTests
```

- **Vectors** (`VectorReplayTests`): replays `packages/editor/test/vim/vectors.jsonl` against
  `VimTextBuffer` following its README exactly (prompt routing, native edits, replace-mode
  fallback, Backspace/Delete recording, a layout pass per key, the header's font geometry),
  prints the pass count per category and the first differences in detail. Skipped when the file
  is missing. Current result: 11,497/11,497 (edit, ex, insert, jumplist, keys, macro, map, mark,
  motion, operator, register, repeat, search, textobject, undo, upstream, viewport, visual), no
  exclusions.
- **Shared replay** (`DailyDoListVimTestSupport`, a library product for tests): the one replay
  implementation, for any `VimVectorHost` (a `VimEditor` that can also perform a native edit,
  finish a layout pass and scroll). It has the vectors parser, `VimVectorReplayer`,
  `runAll(_:filter:exclusions:makeHost:)` with a report per category, and
  `VimTextBuffer.vectorHost(_:)`. `VectorReplayTests` runs it on `VimTextBuffer`, and
  `DailyDoListEditor` runs it on the real Mac editor. It uses `package` access to a few session
  internals (`Support/ReplaySupport.swift`).
- **Upstream** (`Upstream/`): vim.js's own `vim_test.js` is recorded in the vectors (the 647
  `upstream/` cases above). Ported here are only the 27 of its tests a vector can't express: the
  "recording @q" status, the search highlight, 'langmap' translating typed keys, an arrow key in
  insert mode, defined options and ex commands, the mode and keypress callbacks, `:write`,
  `handleKey`'s result and an edit inside a vim operation (each file's header says which).
  Left out: tests that need a language mode, soft wrapping, CodeMirror 5 metrics or the upstream
  page's DOM (listed at the top of `UpstreamVimTests.swift`).
- **Behavior** (`UnicodeBehaviorTests`, `EditorBehaviorTests`): Unicode columns, undo grouping,
  multiple selections, replace mode, marks through edits, multiline search, ex ranges and their
  error messages, with expected states recorded from the vectors' Chromium oracle.
- **Units**: the regex layer (`RegexTranslationTests`, `VimRegexTests`), JavaScript semantics,
  key notation, change sets, selections, bookmarks, the search cursor, the reference buffer's
  layout and history, ex parsing, and the public API including a third-party `VimEditor`
  (`HostAPITests`).
- **Performance** (`PerformanceTests`): `handleKey` on a 10,000-line note, p99 over 500 presses,
  budget 1 ms in the unoptimized test build (`PERF_BUDGET_MULTIPLIER` scales it).

| Key (10k lines) | p99, debug test build | p99, release build |
| --- | --- | --- |
| `j` | 0.15 ms | 0.019 ms |
| `w` | 0.15 ms | 0.017 ms |
| `x` | 0.16 ms | 0.019 ms |
| `dd` | 0.29 ms | 0.035 ms |
| `p` | 0.19 ms | 0.020 ms |

Release numbers: `apps/macos/scripts/test.sh DailyDoListVim -- -c release -Xswiftc -enable-testing
--filter PerformanceTests` on an Apple silicon Mac.
