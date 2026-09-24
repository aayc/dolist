// Ported from vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// `exitInsertMode`, `onChange`, `onCursorActivity`, `handleExternalSelection`,
// `onKeyEventTargetKeyDown`, `repeatLastEdit`, `repeatInsertModeChanges`, the macro functions
// (`MacroModeState` methods, `executeMacroRegister`, `logKey`, `logInsertModeChange`,
// `logSearchQuery`) and `multiSelectHandleKey`.

extension Vim {
  // MARK: Insert mode

  /// `exitInsertMode(cm, keepCursor)`.
  func exitInsertMode(_ cm: EditorAdapter, keepCursor: Bool = false) throws {
    guard let vim = cm.vim else { return }
    let macroModeState = globalState.macroModeState
    let insertModeChangeRegister = globalState.registerController.getRegister(".")
    let isPlaying = macroModeState.isPlaying
    let lastChange = macroModeState.lastInsertModeChanges
    if !isPlaying {
      cm.off(.change, onChangeToken)
      vim.insertEnd?.clear()
      vim.insertEnd = nil
      cm.offInputFieldKeydown(onKeyEventTargetKeyDownToken)
    }
    if !isPlaying, let insertModeRepeat = vim.insertModeRepeat, insertModeRepeat > 1 {
      // Perform insert mode repeat for commands like 3,a and 3,o.
      try repeatLastEdit(cm, vim, insertModeRepeat - 1, repeatForInsert: true)
      guard let last = vim.lastEditInputState else {
        throw JSException.typeError("Cannot set properties of undefined (setting 'repeatOverride')")
      }
      last.repeatOverride = insertModeRepeat
    }
    vim.insertModeRepeat = nil
    vim.insertMode = false
    if !keepCursor { cm.setCursor(cm.getCursor().line, cm.getCursor().ch - 1) }
    cm.setOption("keyMap", "vim")
    cm.toggleOverwrite(false)  // exit replace mode if we were in it.
    // update the ". register before exiting insert mode
    insertModeChangeRegister.setText(VimText.join(lastChange.changes.map(\.joinedText)))
    cm.signal(.vimModeChange, .modeChange(mode: "normal", subMode: nil))
    if macroModeState.isRecording { logInsertModeChange(macroModeState) }
  }

  /// `onChange(cm, changeObj)`: records what is typed in insert mode.
  func onChange(_ cm: EditorAdapter, _ first: ChangeObj) {
    let macroModeState = globalState.macroModeState
    let lastChange = macroModeState.lastInsertModeChanges
    guard !macroModeState.isPlaying else { return }
    let vim = cm.vim
    var changeObj: ChangeObj? = first
    while let change = changeObj {
      lastChange.expectCursorActivityForChange = true
      if let ignoreCount = lastChange.ignoreCount, ignoreCount > 1 {
        lastChange.ignoreCount = ignoreCount - 1
      } else {
        // Every change the adapter reports has an undefined origin.
        let selectionCount = cm.listSelections().count
        if selectionCount > 1 { lastChange.ignoreCount = selectionCount }
        var text = change.text.joined("\n")
        if lastChange.maybeReset {
          lastChange.changes = []
          lastChange.maybeReset = false
        }
        if !text.isEmpty {
          if cm.overwrite && !text.contains(unit: 0x0A) {
            lastChange.changes.append(.textAt(text, nil))
          } else {
            if text.length > 1 {
              let insertEnd = vim?.insertEnd?.find()
              let cursor = cm.getCursor()
              if let insertEnd, insertEnd.line == cursor.line {
                let offset = insertEnd.ch - cursor.ch
                if offset > 0 && offset < text.length {
                  lastChange.changes.append(.textAt(text, offset))
                  text = VimText()
                }
              }
            }
            if !text.isEmpty { lastChange.changes.append(.text(text)) }
          }
        }
      }
      changeObj = change.next
    }
  }

  /// `onCursorActivity(cm)`.
  func onCursorActivity(_ cm: EditorAdapter) {
    guard let vim = cm.vim else { return }
    if vim.insertMode {
      // Tracking cursor activity in insert mode (for macro support).
      let macroModeState = globalState.macroModeState
      if macroModeState.isPlaying { return }
      let lastChange = macroModeState.lastInsertModeChanges
      if lastChange.expectCursorActivityForChange {
        lastChange.expectCursorActivityForChange = false
      } else {
        // Cursor moved outside the context of an edit. Reset the change.
        lastChange.maybeReset = true
        vim.insertEnd?.clear()
        vim.insertEnd = cm.setBookmark(cm.getCursor(), insertLeft: true)
      }
    } else if !(cm.curOp?.isVimOp ?? false) {
      try? handleExternalSelection(cm, vim)
    }
  }

  /// `handleExternalSelection(cm, vim)`: follows a selection made outside vim (the mouse).
  func handleExternalSelection(_ cm: EditorAdapter, _ vim: VimState) throws {
    var anchor = cm.getCursor(.anchor)
    var head = cm.getCursor(.head)
    // Enter or exit visual mode to match mouse selection.
    if vim.visualMode && !cm.somethingSelected() {
      try exitVisualMode(cm, moveHead: false)
    } else if !vim.visualMode && !vim.insertMode && cm.somethingSelected() {
      vim.visualMode = true
      vim.visualLine = false
      cm.signal(.vimModeChange, .modeChange(mode: "visual", subMode: nil))
    }
    if vim.visualMode {
      // Bind CodeMirror selection model to vim selection model. Mouse selections are considered
      // visual characterwise.
      let headOffset = !cursorIsBefore(head, anchor) ? -1 : 0
      let anchorOffset = cursorIsBefore(head, anchor) ? -1 : 0
      head = head.offsetting(0, headOffset)
      anchor = anchor.offsetting(0, anchorOffset)
      vim.sel = VimRange(anchor: anchor, head: head)
      updateMark(cm, vim, "<", cursorMin(head, anchor))
      updateMark(cm, vim, ">", cursorMax(head, anchor))
    } else if !vim.insertMode {
      // Reset lastHPos if selection was modified by something outside of vim mode e.g. by mouse.
      vim.lastHPos = cm.getCursor().ch
    }
  }

  /// `onKeyEventTargetKeyDown(e)`: records insert-mode Backspace/Delete for `.`.
  func onKeyEventTargetKeyDown(_ e: DOMKeyEvent) {
    let lastChange = globalState.macroModeState.lastInsertModeChanges
    let keyName = e.key
    if keyName.isEmpty { return }
    if keyName.contains("Delete") || keyName.contains("Backspace") {
      if lastChange.maybeReset {
        lastChange.changes = []
        lastChange.maybeReset = false
      }
      lastChange.changes.append(
        .key(
          InsertModeKey(
            keyName: keyName, key: e.key, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
            shiftKey: e.shiftKey)))
    }
  }

  /// `repeatLastEdit(cm, vim, repeat, repeatForInsert)`: `.`, and the count of `3i…`.
  func repeatLastEdit(_ cm: EditorAdapter, _ vim: VimState, _ count: Int, repeatForInsert: Bool)
    throws
  {
    let macroModeState = globalState.macroModeState
    macroModeState.isPlaying = true
    let lastAction = vim.lastEditActionCommand
    let cachedInputState = vim.inputState
    func repeatCommand() throws {
      if let lastAction {
        try processAction(cm, vim, lastAction)
      } else {
        try evalInput(cm, vim)
      }
    }
    func repeatInsert(_ count: Int) throws {
      if !macroModeState.lastInsertModeChanges.changes.isEmpty {
        // For some reason, repeat cw in desktop VIM does not repeat insert mode changes. Will
        // conform to that behavior.
        let n = vim.lastEditActionCommand == nil ? 1 : count
        try repeatInsertModeChanges(cm, macroModeState.lastInsertModeChanges.changes, n)
      }
    }
    if let last = vim.lastEditInputState { vim.inputState = last }
    if let lastAction, lastAction.interlaceInsertRepeat {
      // o and O repeat have to be interlaced with insert repeats so that the insertions appear on
      // separate lines instead of the last line.
      for _ in 0..<max(0, count) {
        try repeatCommand()
        try repeatInsert(1)
      }
    } else {
      if !repeatForInsert {
        // Hack to get the cursor to end up at the right place. If I is repeated in insert mode
        // repeat, cursor will be 1 insert change set left of where it should be.
        try repeatCommand()
      }
      try repeatInsert(count)
    }
    vim.inputState = cachedInputState
    if vim.insertMode && !repeatForInsert {
      // Don't exit insert mode twice. If repeatForInsert is set, then we were called by an
      // exitInsertMode call lower on the stack.
      try exitInsertMode(cm)
    }
    macroModeState.isPlaying = false
  }

  /// `repeatInsertModeChanges(cm, changes, repeat)`.
  func repeatInsertModeChanges(_ cm: EditorAdapter, _ changes: [InsertModeChange], _ repeatIn: Int)
    throws
  {
    var count = repeatIn
    let head = cm.getCursor(.head)
    let visualBlock = globalState.macroModeState.lastInsertModeChanges.visualBlock
    if visualBlock != 0 {
      // Set up block selection again for repeating the changes.
      if visualBlock + 1 <= 0 {
        throw JSException.rangeError("A selection needs at least one range")
      }
      selectForInsert(cm, head, visualBlock + 1)
      count = cm.listSelections().count
      cm.setCursor(head)
    }
    for i in 0..<max(0, count) {
      if visualBlock != 0 { cm.setCursor(head.offsetting(i, 0)) }
      for change in changes {
        switch change {
        case .key(let key):
          sendCmKey(cm, key.keyName)
        case .text(let text):
          cm.replaceSelection(text)
        case .textAt(let text, let offset):
          let start = cm.getCursor()
          let end = start.offsetting(0, text.length - (offset ?? 0))
          try cm.replaceRange(text, start, (offset ?? 0) != 0 ? start : end)
          cm.setCursor(end)
        }
      }
    }
    if visualBlock != 0 { cm.setCursor(head.offsetting(0, 1)) }
  }

  // MARK: Macros

  /// `MacroModeState.enterMacroRecordMode(cm, registerName)`.
  func enterMacroRecordMode(_ cm: EditorAdapter, _ registerName: String) {
    let macroModeState = globalState.macroModeState
    let register = globalState.registerController.getRegister(registerName)
    register.clear()
    macroModeState.latestRegister = registerName
    macroModeState.onRecordingDone = cm.openStatusDialog("recording @" + registerName)
    macroModeState.isRecording = true
  }

  /// `MacroModeState.exitMacroRecordMode()`.
  func exitMacroRecordMode() {
    let macroModeState = globalState.macroModeState
    macroModeState.onRecordingDone?()
    macroModeState.onRecordingDone = nil
    macroModeState.isRecording = false
  }

  /// `executeMacroRegister(cm, vim, macroModeState, registerName)`: `@q`.
  func executeMacroRegister(
    _ cm: EditorAdapter, _ vim: VimState, _ macroModeState: MacroModeState, _ registerName: String
  ) throws {
    let register = globalState.registerController.getRegister(registerName)
    if registerName == ":" {
      // Read-only register containing last Ex command.
      if let command = register.keyBuffer.first, !command.isEmpty {
        try exProcessCommand(cm, command)
      }
      macroModeState.isPlaying = false
      return
    }
    let keyBuffer = register.keyBuffer
    var imc = 0
    macroModeState.isPlaying = true
    macroModeState.replaySearchQueries = register.searchQueries
    for text in keyBuffer {
      var index = 0
      while let (key, at) = nextKeyToken(text, from: index) {
        index = at + key.length
        try handleKey(cm, key, "macro")
        if vim.insertMode {
          guard imc < register.insertModeChanges.count else {
            throw JSException.typeError("Cannot read properties of undefined (reading 'changes')")
          }
          let changes = register.insertModeChanges[imc].changes
          imc += 1
          globalState.macroModeState.lastInsertModeChanges.changes = changes
          try repeatInsertModeChanges(cm, changes, 1)
          try exitInsertMode(cm)
        }
      }
    }
    macroModeState.isPlaying = false
  }

  /// `logKey(macroModeState, key)`.
  func logKey(_ macroModeState: MacroModeState, _ key: VimText) {
    if macroModeState.isPlaying { return }
    globalState.registerController.getRegister(macroModeState.latestRegister).pushText(key)
  }

  /// `logInsertModeChange(macroModeState)`.
  func logInsertModeChange(_ macroModeState: MacroModeState) {
    if macroModeState.isPlaying { return }
    globalState.registerController.getRegister(macroModeState.latestRegister).pushInsertModeChanges(
      macroModeState.lastInsertModeChanges)
  }

  /// `logSearchQuery(macroModeState, query)`.
  func logSearchQuery(_ macroModeState: MacroModeState, _ query: VimText) {
    if macroModeState.isPlaying { return }
    globalState.registerController.getRegister(macroModeState.latestRegister).pushSearchQuery(query)
  }

  // MARK: Multiple selections

  /// `multiSelectHandleKey(cm, key, origin)`: the entry point for keys.
  func multiSelectHandleKey(_ cm: EditorAdapter, _ key: VimText, _ origin: String?) throws -> Bool {
    var isHandled = false
    let vim = maybeInitVimState(cm)
    let visualBlock = vim.visualBlock || vim.wasInVisualBlock
    if let close = cm.closeVimNotification {
      cm.closeVimNotification = nil
      close()
      if key == "<CR>" {
        clearInputState(cm)
        return true
      }
    }
    let wasMultiselect = cm.isInMultiSelectMode()
    if vim.wasInVisualBlock && !wasMultiselect {
      vim.wasInVisualBlock = false
    } else if wasMultiselect && vim.visualBlock {
      vim.wasInVisualBlock = true
    }
    if key == "<Esc>" && !vim.insertMode && !vim.visualMode && wasMultiselect
      && vim.status == "<Esc>"
    {
      // allow editor to exit multiselect
      clearInputState(cm)
    } else if visualBlock || !wasMultiselect {
      isHandled = try handleKey(cm, key, origin)
    } else {
      let old = vim.clone()
      var changeQueueList = vim.inputState.changeQueueList ?? []
      try cm.operation { () throws in
        cm.curOp?.isVimOp = true
        var index = 0
        try cm.forEachSelection { () throws in
          cm.vim?.inputState.changeQueue =
            index < changeQueueList.count ? changeQueueList[index] : nil
          var head = cm.getCursor(.head)
          var anchor = cm.getCursor(.anchor)
          let headOffset = !cursorIsBefore(head, anchor) ? -1 : 0
          let anchorOffset = cursorIsBefore(head, anchor) ? -1 : 0
          head = head.offsetting(0, headOffset)
          anchor = anchor.offsetting(0, anchorOffset)
          cm.vim?.sel.head = head
          cm.vim?.sel.anchor = anchor
          isHandled = try self.handleKey(cm, key, origin)
          if cm.virtualSelection != nil {
            let queue = cm.vim?.inputState.changeQueue
            if index < changeQueueList.count {
              changeQueueList[index] = queue
            } else {
              changeQueueList.append(queue)
            }
            cm.vim = old.clone()
          }
          index += 1
        }
        if let op = cm.curOp, op.cursorActivity, !isHandled { op.cursorActivity = false }
        cm.vim = vim
        vim.inputState.changeQueueList = changeQueueList
        vim.inputState.changeQueue = nil
      }
    }
    // some commands may bring visualMode and selection out of sync
    if isHandled && !vim.visualMode && !vim.insertMode && vim.visualMode != cm.somethingSelected() {
      try handleExternalSelection(cm, vim)
    }
    return isHandled
  }
}
