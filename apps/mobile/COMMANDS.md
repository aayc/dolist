# Phone commands and quick open

`PhoneCommand` is the phone's command catalog. The menu, searchable command palette and native
hardware keyboard shortcuts all use this catalog and `PhoneCommandController.canRun`. It adapts
applicable Mac commands without exposing local daemon, Finder or Vim commands. Host administration
opens the existing Host Settings screen; agent actions retain the existing journal and authority
checks.

## Composition

Apply the container once around the selected workspace's navigation/tab content:

```swift
content.phoneCommands(
  workspace: workspace,
  isCurrent: { model.workspace === workspace && !anotherModalIsPresented },
  chooseConnection: { showConnections = true },
  showHostSettings: { showHostSettings = true },
  insertDrawing: { showDrawingInsertion = true },
  visibleThread: { currentlyPresentedThreadID }
)
```

Place `PhoneCommandMenu()` in the relevant navigation toolbars. Views inside the container can
read `@Environment(\.phoneCommands)` to call `run(.quickOpen)`, `run(.palette)` or `run(.search)`.
The container owns only its palette, reviewed path forms, capture/history/recovery and routine
creation presentations. The `isCurrent` closure must read live state and reject a retired/replaced
workspace or an unrelated modal that currently owns keyboard input. It should not reject the
container's own presentation. `insertDrawing` is optional; omitting it removes that command from
available actions. `visibleThread` enables Stop only for a currently visible, active thread.

The controller rechecks authority after sheet dismissal, and a reviewed structural form captures
the connection generation. Commands never silently submit a stale path form after reconnecting.
New-note and drawing forms call the workspace's offline-capable APIs; rename/trash/folder creation
require a verified online connection. Trash goes through the existing soft-delete flow.

Source, line numbers, readable width and font commands alter the current editor configuration.
The note toolbar must derive its source state from `session.editor.configuration.livePreview`
rather than a second independent `@State` value. These commands do not change the host's defaults.
Formatting uses the note editor's retained selection after the palette relinquishes text focus.

## Navigation and keyboard

The Notes tab merges known host paths with downloaded repository metadata, using the same pure
`QuickOpenRanking` as macOS. With an empty query it shows recent and open paths first. A path is
clearly marked Downloaded or Requires connection. Contents search combines local downloaded
results with host results when online; dirty local content takes precedence over stale host hits.
It describes offline coverage and debounces requests. Query, mode and connection changes fence
late results.

| Key | Action |
| --- | --- |
| Command-P | Command palette |
| Command-O | Quick open |
| Command-Shift-F | Contents search |
| Command-N | New note |
| Command-S / Command-W | Save / close current note |
| Command-Shift-T | Reopen closed note |
| Control-Tab / Control-Shift-Tab | Next / previous note tab |
| Command-1 through Command-9 | Select note tab |
| Command-[ / Command-] | Back / forward |
| Command-Shift-D | Today's daily note |
| Command-Shift-P / Command-Shift-N | Previous / next daily note |
| Command-Shift-K | Capture task |
| Command-comma | Phone settings |
| Command-B / Command-I / Command-E | Bold / italic / code |
| Command-K / Command-Shift-L | Link / checklist |

In the palette, Up/Down or Control-P/Control-N moves the highlighted row, Return opens it,
Shift-Return opens a note in a new tab, Command-Return reviews a new note using the query, and
Escape dismisses. Arrow keys and Return defer to an active input-method composition. UIKit's
normal undo/redo remain available to the focused editor. The menu and command palette also expose
commands without a default shortcut.

## Verification

Shared ranking tests cover filename/path matching, recents and cyclic selection. Native tests
cover downloaded search, stale connection/form rejection, retained editor selection and UIKit
input-method handling. Actual global shortcut registration and navigation must also be exercised
in the composed app with a hardware keyboard or Simulator keyboard input; directly invoking a
key-command handler does not establish that the hosting responder chain is wired correctly.
