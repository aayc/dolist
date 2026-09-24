# Third-party code in DailyDoListVim

This package is a Swift port of the vim mode the web app uses — `vim.js` from
[`@replit/codemirror-vim-core`](https://github.com/replit/codemirror-vim) 0.1.0 and its CodeMirror 6
adapter [`@replit/codemirror-vim`](https://github.com/replit/codemirror-vim) 6.4.0 — together with
the pieces of [CodeMirror 6](https://codemirror.net) whose behavior vim relies on. Each ported file
names its source in a header comment. This list is merged into the repository's
`THIRD_PARTY_NOTICES.md`, which has the full license text.

All of these projects are MIT licensed, Copyright (C) 2018-2021 by Marijn Haverbeke and others
(`@marijn/find-cluster-break`: Copyright (C) 2024 by Marijn Haverbeke).

| File in this package (`Sources/DailyDoListVim/`) | Ported from | What |
| --- | --- | --- |
| `Engine/*.swift` (except `VimOptionValue.swift`) | `vim.js` (`@replit/codemirror-vim-core` 0.1.0) | The vim engine: keymap, key handler, dispatcher, motions, operators, actions, text objects, search, registers, marks, macros, options, langmap, ex commands |
| `Engine/VimSession.swift` | `vimPlugin` in `@replit/codemirror-vim` 6.4.0 | Key presses and editor updates reaching the engine |
| `Engine/Prompt.swift`, `Editor/VimPanel.swift` | `showPrompt`/`showConfirm` (vim.js) and the adapter's dialogs | Prompts and notifications |
| `Editor/VimKeyNotation.swift` | `vimKeyFromEvent` (vim.js) | Key presses to vim key names |
| `Editor/VimPosition.swift` | `Pos` (adapter), `offsetCursor` (vim.js) | Positions |
| `Adapter/EditorAdapter*.swift`, `Adapter/Marker.swift` | class `CodeMirror` and its helpers in `@replit/codemirror-vim` 6.4.0 | The CodeMirror 5 API vim.js calls, on top of `VimEditor` |
| `Adapter/ChangeSet.swift`, `Adapter/EditorSelection.swift` | `@codemirror/state` 6.7.6 | Change sets, selections |
| `Adapter/SearchCursor.swift` | `@codemirror/search` 6.7.2 (`RegExpCursor`) and the adapter's `getSearchCursor` | Regex search over the document |
| `Adapter/EditorAdapter+Layout.swift` | `@codemirror/view` 6.43.13 (`moveVertically`, `posAtCoords`) and the adapter's `findPosV` | Vertical motion |
| `Adapter/EditorAdapter+Commands.swift` | `@codemirror/commands` 6.11.1 (`insertNewlineAndIndent`, `indentMore`/`indentLess`, cursor commands) and `@codemirror/language` 6.12.4 (`matchBrackets`) | Editor commands vim.js runs |
| `Adapter/ClusterBreak.swift` | `@marijn/find-cluster-break` 1.0.4 | Grapheme cluster boundaries |
| `Buffer/UndoHistory.swift` | `@codemirror/commands` 6.11.1 (`history`) | Undo grouping |
| `Buffer/VimTextBuffer.swift` | `@codemirror/state`, `@codemirror/view` (scrolling) | The reference editor |
| `Support/StringStream.swift` | `@codemirror/language` 6.12.4 (`StringStream`) | The ex command tokenizer |
| `Support/JSCharacters.swift` | vim.js and `CodeMirror.isWordChar` of the adapter | Character classes |

The tests in `Tests/DailyDoListVimTests/Upstream/` are ported from vim.js's own test suite
(`test/vim_test.js` of `@replit/codemirror-vim-core` 0.1.0, same license).

The JavaScript semantics layer (`Regex/`, `Support/VimText.swift`, `JSCase.swift`,
`JSNumber.swift`) implements ECMAScript behavior from the specification and is not derived from
any of the projects above.
