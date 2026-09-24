# Vim behavior vectors

`vectors.jsonl` records what Obsidian's vim engine — `@replit/codemirror-vim` (core `vim.js`),
running in real Chromium — does for thousands of key sequences. It is the behavioral contract for
vim mode on every platform:

- **web:** the same cases are replayed against the real Daily Do List editor (live preview,
  annotations and all), so an editor extension that breaks vim semantics fails CI;
- **macOS / iOS:** `apps/macos/Packages/DailyDoListVim` (the Swift port of `vim.js`) replays every
  case against its in-memory editor.

Regenerate with `pnpm vim:vectors`; `pnpm vim:check` fails when the committed file no longer matches
what the pinned engine does (for example after a dependency upgrade). How the file is produced and
tested is described in [How the vectors are made](#how-the-vectors-are-made).

## Format (version 1)

JSON Lines. Line 1 is the header; every other line is one case. Cases are sorted by `name`
(JavaScript string order, i.e. by UTF-16 code units) so diffs stay reviewable. Changes to the
format must be additive (new optional fields) and documented here (see [Changes](#changes)).

### Header

```json
{
  "format": "ddl-vim-vectors",
  "version": 1,
  "engine": "@replit/codemirror-vim@6.4.0 (@replit/codemirror-vim-core@0.1.0)",
  "viewport": { "rows": 20, "lineHeight": 20, "wrap": false, "textHeight": 18, "charWidth": 9.6015625 },
  "defaults": { "tabSize": 4, "indentUnit": "\t" }
}
```

`defaults` are the editor options every case starts from; they match the Daily Do List editor
(`EditorState.tabSize` and the CodeMirror `indentUnit` string). The engine sees them through the
CodeMirror 5 option names the adapter derives: `tabSize`, `indentWithTabs` (`indentUnit == "\t"`)
and `indentUnit` (`indentUnit.length || 2`). `viewport` describes the fixed, non-wrapping viewport
used for viewport-dependent commands: `rows` lines of `lineHeight` pixels, laid out in a font whose
glyph box is `textHeight` pixels tall (ascent + descent, centered in the line) and whose characters
are `charWidth` pixels wide. A replay host that measures layout itself (page motions, display
lines) should use these numbers.

### Case

```json
{
  "name": "operator/d/w/words/mid-word/count-before-operator",
  "origin": "catalog",
  "doc": "one two three",
  "selection": [[0, 4]],
  "options": { "tabSize": 8, "indentUnit": "  " },
  "vim": { "textwidth": 20 },
  "registers": { "a": { "text": "x", "linewise": false, "blockwise": false } },
  "scrollTop": 0,
  "steps": [
    { "keys": ["2", "d", "w"], "expect": { "doc": "one ", "selection": [[0, 3]], "mode": "normal" } }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `name` | Unique, stable, `/`-separated category path. |
| `origin` | `"catalog"` (hand-authored catalog) or `"upstream:<test name>"` (recorded from the engine's own test suite). |
| `doc` | Initial document. Lines are separated by `\n`. |
| `selection` | Initial selection ranges in document order: `[line, ch]` is a cursor, `[anchorLine, anchorCh, headLine, headCh]` a range. `primary` (index) is present only when there is more than one range. |
| `options` | Optional editor option overrides, same keys as `defaults` (`tabSize`, `indentUnit`). |
| `vim` | Optional vim options applied (as `:set`, i.e. `Vim.setOption(name, value, cm)`) before the first step. |
| `registers` | Optional register contents preset before the first step (`getRegister(name).setText(text, linewise, blockwise)`). |
| `scrollTop` | Optional first visible line (viewport cases only). |
| `steps` | Key sequences applied in order; the state is checked after each. |

Positions are 0-based; `ch` counts **UTF-16 code units** (JavaScript string indices).

The initial selection is applied like any host selection change, so a non-empty range makes vim.js
enter visual mode the way a mouse selection does. The editor has completed a layout pass before
(`view.measure()`, so the viewport is exact), and afterwards the primary cursor is scrolled into
view unless the case sets `scrollTop` (vim keeps the cursor on screen after every command).

### Step

```json
{ "keys": ["d", "i", "w"], "expect": { "doc": "…", "selection": [[0, 0]], "mode": "normal" } }
```

A step may instead carry `"api"` (recorded upstream cases only) — a host call made between key
sequences: `{"op": "setCursor", "args": [line, ch]}`, `{"op": "setSelections", "args": [[…], primary?]}`,
`{"op": "setValue", "args": ["text"]}`, `{"op": "replaceRange", "args": ["text", [l, c], [l, c]?]}`,
`{"op": "setOption", "args": ["name", value]}`, `{"op": "vimSetOption", "args": ["name", value]}`,
`{"op": "map", "args": ["lhs", "rhs", "mode"?]}`, `{"op": "noremap", …}`, `{"op": "unmap", …}`,
`{"op": "mapclear", "args": ["mode"?]}`,
`{"op": "setRegister", "args": ["name", "text", linewise?, blockwise?]}`,
`{"op": "pushText", "args": [registerName, "operator", "text", linewise?, blockwise?]}`,
`{"op": "ex", "args": ["command"]}`. Every step carries an `expect`.

`setOption` is the CodeMirror 5 compatible `cm.setOption`, which the CodeMirror 6 adapter only
implements for `keyMap` and `textwidth` (anything else is a no-op). `vimSetOption` is the global
`Vim.setOption(name, value)`. `pushText` is `Vim.getRegisterController().pushText(…)` (register
name `null` = no register given). `mapclear` is `Vim.mapclear(mode?)` (unlike `:mapclear` it
doesn't touch the `:` register). `ex` is `Vim.handleEx(cm, command)`.

### Expected state

| Field | Meaning |
| --- | --- |
| `doc` | Full document text. |
| `selection` / `primary` | As in the case, read from the editor after the step (`cm.listSelections()`). |
| `mode` | `normal`, `insert`, `replace`, `visual`, `visual-line` or `visual-block`. |
| `registers` | Every **non-empty** register among `"`, `0`–`9`, `a`–`z`, `-`, `.`, `:`, `/`: `{"text", "linewise", "blockwise"}` where `text` is the register's `toString()`. Omitted when all are empty. |
| `prompt` | Present when a command-line/search prompt is still open: `{"prefix": ":", "text": "s/a"}`. `prefix` is the text before the input (`:`, `/`, `?`, or `replace with X (y/n/a/q/l)` for `:s///c`). |
| `message` | The text of the last notification shown during the step (`showConfirm`), e.g. `No match found /foo/m`. For "long" notifications (`:registers`, `:marks`) it is the message itself, without the "Press ENTER or type command to continue" line. |
| `scrollTop` | First visible line after the step: `round(scrollTop / lineHeight)`. Present exactly when the case has `scrollTop`. |

## Keys

Each token is a key in the notation `Vim.handleKey` accepts: a single character — one Unicode
code point (`"a"`, `"$"`, `"é"`, `"😀"`, `"\""`, `" "`) — or a named key: `<Esc>`, `<CR>`,
`<BS>`, `<Del>`, `<Tab>`, `<Space>`, `<Up>`, `<Down>`, `<Left>`, `<Right>`, `<Home>`, `<End>`,
`<PageUp>`, `<PageDown>`, `<Ins>`, `<C-x>` (Ctrl+x), `<S-…>`, `<A-…>`, `<M-…>`, and combinations
(`<C-S-x>`). A literal `<` is `"<"` (it is never ambiguous because named keys are separate tokens).

The space bar produces `<Space>` (that's what the adapter's `vimKeyFromEvent` returns for it), which
normal and visual mode map to `l`. The literal token `" "` is passed to the engine verbatim; vim.js
binds nothing to it outside insert mode, so it is only used for typed text and `f`/`t`/`r` targets.

Every token has a keyboard event a real keypress would carry: its `key` (`KeyboardEvent.key`) is the
character itself, or for named keys `Escape`, `Enter`, `Backspace`, `Delete`, `Tab`, `" "`,
`ArrowUp`, …, `Insert`; `<C-x>` is `key: "x"` with Ctrl. Some rules below look at that `key`.

## How a replay applies a token

Both the Chromium oracle and every replay apply tokens with exactly these rules, so the vectors
test the vim engine and not incidental host behavior:

1. **Prompt open** (after `:`, `/`, `?`, or a `:s///c` confirmation) — the token goes to the prompt
   the way the adapter's dialog handles a keypress in its text field:
   1. the engine's `onKeyDown(event, text, close)` hook is called; if it returns true, stop;
   2. otherwise Enter (`<CR>`, any modifiers) calls the prompt's submit callback with the text, and
      Enter or Escape (`<Esc>`, any modifiers) then closes the prompt;
   3. if the prompt is still open and the event wasn't `preventDefault`ed, the text field's
      default action happens: a token that inserts text in insert mode (rule 2 below; except
      `<CR>`/`<Tab>`) is appended; `<BS>` deletes the last grapheme cluster; nothing else (the caret
      is always at the end — `<Left>`/`<Right>` don't move it);
   4. the key's keyup goes to the prompt that is open now, if any: its `onKeyUp(event, text,
      close)` hook is called. This includes a prompt the key just opened from the editor (the
      browser moves focus into the prompt during keydown, so typing `/` runs the search prompt's
      keyup hook once with empty text).

   An exception thrown by a hook or by the submit callback is swallowed the way a browser treats an
   exception in an event listener: the rest of that listener is skipped (a submitted command that
   throws leaves the prompt open, after vim.js has shown the error as a message) and the default
   action and keyup still happen. `close(value)` with a string replaces the text; `close()` closes
   the prompt. Whether a key closes
   the prompt is up to the engine's hooks (`<Esc>`, `<C-c>`, `<C-[>`, `<BS>` on empty text cancel;
   `<Up>`/`<Down>` walk history; `<C-u>` clears). Dialogs without a text field (the
   "recording @q" status line) are not prompts: keys keep going to the editor.
2. **Otherwise** the token goes to the adapter's key handler, i.e.
   `Vim.multiSelectHandleKey(cm, token, "user")` (for a single selection this is
   `Vim.handleKey(cm, token, "user")`, after dismissing a pending "Press ENTER" notification — a
   `<CR>` then only dismisses it). When the engine does not handle the token (returns a falsy
   value) and the editor is in **replace** mode, the adapter tries first:
   - if the token's `key` is a single UTF-16 code unit other than `"\n"`, it overwrites with that
     `key` (`cm.overWriteSelection`: each empty selection is extended over the next code unit
     unless that is a line break or the end of the document, then replaced). This includes
     modifier combinations: `<C-a>` overwrites with `a`;
   - if the token's `key` is `Backspace` (any modifiers), the cursor moves one character left
     (CM6 `cursorCharLeft`: one grapheme cluster, and from column 0 to the end of the previous
     line); nothing is deleted.

   When the token is still unhandled and the editor is in insert or replace mode, the replay
   performs the host's native edit:
   - a single-character token, `<Space>` or `<S-Space>` replaces every selection with that
     character (`" "` for the space keys);
   - `<CR>` inserts `"\n"`, `<Tab>` inserts `"\t"` (no auto-indent, no list continuation);
   - `<BS>` deletes each non-empty selection, otherwise the grapheme cluster before the cursor
     (joining with the previous line at column 0);
   - `<Del>` deletes each non-empty selection, otherwise the grapheme cluster after the cursor
     (joining with the next line at the end of a line);
   - any other unhandled token is ignored (including arrows, `<Home>`/`<End>` and modified keys).

   Native edits are real document changes (the engine observes them exactly like typing, which is
   what `.` repeat and the `.` register record); in the undo history they are typing
   (`input.type`) or deletion (`delete.backward`/`delete.forward`) changes. In normal/visual mode
   an unhandled token is ignored.
3. **Backspace/Delete are also reported to the engine.** vim.js records insert-mode Backspace and
   Delete for `.` and counted-insert repeat with a plain keydown listener on the editor
   (`onKeyEventTargetKeyDown`, registered while insert mode is active). After a token whose `key` is
   `Backspace` or `Delete` (any modifiers) has been handled as above, that listener is called with
   the token's event — if it was registered before the token and still is afterwards. When the
   engine later replays the recorded key it runs the host's Backspace/Delete command, which is the
   same deletion as the native edit above.
4. After every token the host completes a layout pass (the oracle calls `view.measure()`), so any
   scrolling a key requested has happened before the next key.
5. The expected state is read after all tokens of the step have been applied.

All keys of a case are applied synchronously: engine timers (the insert-mode mapping timeout
`insertModeEscKeysTimeout`, search highlighting) never fire during a case.

Before each case the replay resets the engine's global state (registers, marks, search and command
history, macros, mappings, options), creates a fresh editor with `defaults` + `options`, applies
`selection`, `vim`, `registers` and `scrollTop`, then runs the steps.

## The oracle editor

A plain CodeMirror 6 `EditorView` with exactly these extensions (`harness/oracle-editor.ts`):
`vim()`, `history()` (default configuration), `drawSelection()`,
`EditorState.allowMultipleSelections.of(true)`, `EditorState.tabSize`, `indentUnit`, and a keymap
binding Backspace, Delete, Enter and Tab to the native edits of rule 2 and the arrow keys to CM6's
`cursorCharLeft`/`cursorCharRight`/`cursorLineUp`/`cursorLineDown` (as CodeMirror's default keymap
does). Typed tokens never reach that keymap (rule 2 decides what they do); vim.js uses it when it
replays a recorded Backspace/Delete and when an insert-mode mapping produces `<BS>`, `<Del>`,
`<Left>`, `<Right>`, `<Up>` or `<Down>` (`sendCmKey`). There is no language, so
syntax-dependent engine hooks see nothing (`getTokenTypeAt` is always `""`, no tags, no comment
tokens). The theme gives 20px lines in the oracle font at 16px, no content padding, no wrapping, a
400px (20-row) tall scroller without scrollbars. `CodeMirror.isMac` is `false`.

The oracle font (`scripts/oracle-font.ts`) is generated: a monospace TrueType font covering
printable ASCII with Courier New's metrics (the font the vectors were first recorded with), which
every harness page loads before it runs and whose measured metrics must equal `viewport`'s. The
system `monospace` font would make page motions depend on the machine's font catalog (macOS and
Linux resolve it to different fonts). Other characters fall back to the system's fonts, so
`pnpm vim:vectors` rejects cases that run a pixel-measuring command (page motions, display-line
motions) over text outside printable ASCII.

## Host behavior the engine relies on

vim.js calls back into the editor for a few operations; the vectors pin what CodeMirror 6 does
there, so a port must do the same:

- **`newlineAndIndent`** (`o`, `O`, `r<CR>`): CM6 `insertNewlineAndIndent` without a language — the
  new line gets the current line's indentation (as `indentUnit`/tabs; at document position 0 the
  indentation is 0, because the empty syntax tree "covers" that position), whitespace after the
  cursor is removed, a break inside leading whitespace happens at the line start, and a cursor
  between `()`/`[]`/`{}` "explodes" into two new lines.
- **`indentMore` / `indentLess`** (`>`, `<`, `<C-t>`, `<C-d>`): CM6's commands on every line
  touched by the selection (a non-empty range ending at a line start excludes that line; empty
  lines are indented too). `indentLess` removes one indent unit worth of columns, re-writing the
  remaining indentation with `indentUnit`/tabs.
- **`cursorCharLeft`** (replace-mode Backspace): one grapheme cluster left, crossing to the end of
  the previous line from column 0.
- **`goLineLeft` / `goLineRight`** (`g0`, `g^`, `g$`): CM6 `cursorLineBoundaryBackward` (a "smart
  home": to the end of the indentation unless the cursor is already there, then to the line start)
  and `cursorLineBoundaryForward` followed by one character back unless at a line break.
- **Undo** follows CM6 `history()`. Changes vim.js makes through the adapter's editing methods
  (`replaceRange`, `replaceSelection(s)`, `newlineAndIndent`) carry the user event
  `input.type.compose.start` when they are the first change inside a vim operation and
  `input.type.compose` otherwise — including changes made outside any operation, such as `:s///c`
  replacements confirmed from the prompt. CM6 commands vim.js calls keep their own events
  (`indentMore` → `input.indent`, `indentLess` → `delete.dedent`); `setValue` has none. A change
  joins the previous history event when it is an `input.type.compose` change, or when all of these
  hold: the previous event has changes, the new change's user event is `input.type…` or
  `delete…` (or absent), the two changes touch, and no selection-only transaction happened since
  the previous change (vectors are always within the 500ms group delay). Consequently `cwX<Esc>u`
  undoes only the `X`: entering insert mode moves the selection between the deletion and the
  typing.
- **Search** runs through CM6's `RegExpCursor` (unicode mode) over the document.

## Engine quirks the vectors pin

- The `.` register is `changes.join("")` over vim.js's recorded insert-mode changes: text changes
  contribute their text, replace-mode changes are arrays (`["x"]` → `x`, `[text, offset]` →
  `text,offset`), and every recorded Backspace/Delete key contributes the string
  `[object Object]`.
- Replace mode records only the change after the last cursor move; the adapter moves the selection
  before every overwrite, so `3Rab<Esc>` repeats just `b`.

## Exclusions

Behavior that depends on things the vectors cannot pin down is not recorded: soft-wrap (`gj`/`gk`
with wrapping; without wrapping they are recorded on ASCII lines), folding (`zc`/`zo`/…),
syntax-aware commands that depend on a language mode (`=`, `gc`, the tag objects `it`/`at`), timers,
and the system clipboard (`"+`/`"*`, which are platform integrations tested separately), and
`:set filetype`. Key sequences that make vim.js throw are not recorded either (the catalog checks
that they still throw):

- `i<`/`a<`/`i>`/`a>` outside any `<…>`, where vim.js searches with `/\</`, which CodeMirror's
  unicode-mode regexp cursor rejects;
- `<C-a>`/`<C-x>` counts that make a binary number more than one digit longer (`<C-x>` below
  zero wraps to 64 bits), which vim.js zero-pads with `new Array(-n)`;
- a macro that calls itself, which recurses until the stack overflows (vim.js doesn't stop a
  macro when a motion fails).
Viewport commands (`H`/`M`/`L`, `z` scrolling, `<C-d>`/`<C-u>`/`<C-f>`/`<C-b>`/`<C-e>`/`<C-y>`)
are recorded under `viewport/` against the fixed `viewport` above.

The catalog's coverage check (`catalog/coverage.ts`) lists the default keymap entries and ex
commands excluded for these reasons; every other `defaultKeymap` entry and `defaultExCommandMap`
command is exercised by at least one catalog case.

## How the vectors are made

- `catalog/` — the hand-authored cases (TypeScript, partly generated combinatorially).
- `upstream/` — scenarios recorded from vim.js's own test suite (`vimTests`), see
  `origin: "upstream:<test>"`.
- `harness/` — applies tokens by the rules above and snapshots the state; the same code produces the
  expectations (against the oracle editor) and replays them against the Daily Do List editor.
- `scripts/` — `pnpm vim:vectors` writes `vectors.jsonl`; `pnpm vim:check` regenerates it in memory
  and fails on any difference, runs the upstream suite against plain CodeMirror and against the
  Daily Do List editor, and replays every vector against the Daily Do List editor.

## Changes

Additive clarifications made while building the oracle (format version 1 is unchanged):

- Rule 2 names the adapter's actual entry point (`Vim.multiSelectHandleKey`, which is
  `Vim.handleKey` for one selection) and its replace-mode fallback (overwrite with the event's
  key, Backspace moves left without deleting); the original rule said replace-mode `<BS>` deletes.
- `<Space>`/`<S-Space>` insert a space like `" "`; the space bar produces `<Space>`.
- Rule 3 (Backspace/Delete reach vim.js's recording listener), rule 4 (layout pass per token), the
  synchronous-timers note, the prompt key order, the oracle editor setup, host behavior, quirks.
- The initial layout pass and scrolling the initial cursor into view (cases without `scrollTop`).
- `api` ops `pushText` and `mapclear`; `setSelections` takes an optional primary index.
- Prompt keyup delivery (including the keyup of the key that opens a prompt) and listener-style
  exception handling in rule 1.
- Exclusions list every kind of key sequence that makes vim.js throw.
- The header's `viewport` records the font geometry (`textHeight`, `charWidth`), and the oracle
  lays out in a generated font with those metrics instead of the system `monospace` font (every
  case is unchanged: they are the metrics the system font had where the vectors were recorded).
