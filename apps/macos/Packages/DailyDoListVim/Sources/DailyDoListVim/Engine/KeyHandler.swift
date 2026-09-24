// Ported from vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// `handleKey` / `findKey` (the key handler), `doKeyToKey`, `sendKeyToPrompt`, `clearInputState`,
// `maybeInitVimState`, `enterVimMode` / `leaveVimMode`, `commandMatches`, `commandMatch` and
// `lastChar`.

/// The end index of a named key `<(?:[CSMA]-)*\w+>` (modifiers case-insensitive) at `i`.
func namedKeyEnd(_ u: [UInt16], _ i: Int) -> Int? {
  guard i < u.count, u[i] == 0x3C else { return nil }
  var j = i + 1
  while j + 1 < u.count, [0x43, 0x53, 0x4D, 0x41, 0x63, 0x73, 0x6D, 0x61].contains(u[j]),
    u[j + 1] == 0x2D
  { j += 2 }
  let start = j
  while j < u.count, isJSAsciiWordChar(u[j]) { j += 1 }
  guard j > start, j < u.count, u[j] == 0x3E else { return nil }
  return j + 1
}

/// The next key of `keys` at or after `index` (`/<(?:[CSMA]-)*\w+>|./gi` with `exec`): a named
/// key or one code unit; line terminators are skipped.
func nextKeyToken(_ keys: VimText, from index: Int) -> (key: VimText, index: Int)? {
  var i = index
  let u = keys.units
  while i < u.count {
    if let end = namedKeyEnd(u, i) { return (VimText(u[i..<end]), i) }
    if !isJSLineTerminator(u[i]) { return (VimText(unit: u[i]), i) }
    i += 1
  }
  return nil
}

extension Vim {
  // MARK: Editor state

  /// `maybeInitVimState(cm)`.
  @discardableResult
  func maybeInitVimState(_ cm: EditorAdapter) -> VimState {
    if let vim = cm.vim { return vim }
    let vim = VimState()
    cm.vim = vim
    return vim
  }

  /// `enterVimMode(cm)`.
  func enterVimMode(_ cm: EditorAdapter) {
    cm.signal(.vimModeChange, .modeChange(mode: "normal", subMode: nil))
    cm.on(.cursorActivity, onCursorActivityToken) { [unowned self, unowned cm] _ in
      self.onCursorActivity(cm)
    }
    maybeInitVimState(cm)
    cm.inputFieldPaste.append(
      (onCursorActivityToken, { [unowned self, unowned cm] in self.onPaste(cm) }))
  }

  /// `leaveVimMode(cm)`.
  func leaveVimMode(_ cm: EditorAdapter) {
    cm.off(.cursorActivity, onCursorActivityToken)
    cm.inputFieldPaste.removeAll { $0.0 === onCursorActivityToken }
    cm.vim = nil
    highlightTimeout?.cancel()
    // Its action refers to the editor being left, which the host may release.
    lastInsertModeKeyTimer?.cancel()
  }

  /// `getOnPasteFn(cm)`: pasting in normal mode enters insert mode after the cursor.
  private func onPaste(_ cm: EditorAdapter) {
    guard let vim = cm.vim, !vim.insertMode else { return }
    cm.setCursor(cm.getCursor().offsetting(0, 1))
    try? actEnterInsertMode(cm, ActionArgs(), vim)
  }

  /// `clearInputState(cm, reason)`.
  func clearInputState(_ cm: EditorAdapter, _ reason: String? = nil) {
    cm.vim?.inputState = InputState()
    cm.vim?.expectLiteralNext = false
    cm.signal(.vimCommandDone, .commandDone(reason))
  }

  // MARK: The key handler

  /// `Vim.handleKey(cm, key, origin)`: true when the key was handled (or buffered).
  @discardableResult
  func handleKey(_ cm: EditorAdapter, _ key: VimText, _ origin: String?) throws -> Bool {
    guard let command = try findKey(cm, key, origin) else { return false }
    return try command()
  }

  /// `findKey(cm, key, origin)`: nil when the key isn't handled, else the function to run.
  func findKey(_ cm: EditorAdapter, _ key: VimText, _ origin: String?) throws -> (
    () throws -> Bool
  )? {
    let vim = maybeInitVimState(cm)

    func handleMacroRecording() -> Bool {
      let macroModeState = globalState.macroModeState
      if macroModeState.isRecording {
        if key == "q" {
          exitMacroRecordMode()
          clearInputState(cm)
          return true
        }
        if origin != "mapping" { logKey(macroModeState, key) }
      }
      return false
    }

    func handleEsc() throws -> Bool {
      guard key == "<Esc>" else { return false }
      if vim.visualMode {
        try exitVisualMode(cm)
      } else if vim.insertMode {
        try exitInsertMode(cm)
      } else {
        return false
      }
      clearInputState(cm)
      return true
    }

    enum Outcome {
      case none
      case buffered
      case command(VimCommand)
    }

    func handleKeyInsertMode() throws -> Outcome {
      if try handleEsc() { return .buffered }
      vim.inputState.keyBuffer.append(key)
      let keys = vim.inputState.keyBuffer.joined()
      let keysAreChars = key.length == 1
      let match = matchCommand(keys, vim.inputState, .insert)
      var changeQueue = vim.inputState.changeQueue
      switch match {
      case .none:
        clearInputState(cm)
        return .none
      case .partial(let expectLiteralNext):
        if expectLiteralNext { vim.expectLiteralNext = true }
        lastInsertModeKeyTimer?.cancel()
        lastInsertModeKeyTimer = nil
        if keysAreChars {
          let delay = (option("insertModeEscKeysTimeout")?.numberValue ?? 0) / 1000
          lastInsertModeKeyTimer = scheduler.schedule(after: delay) {
            [unowned self, unowned cm, unowned vim] in
            if vim.insertMode && !vim.inputState.keyBuffer.isEmpty { self.clearInputState(cm) }
          }
          let selections = cm.listSelections()
          if changeQueue == nil || changeQueue!.removed.count != selections.count {
            changeQueue = ChangeQueue()
            vim.inputState.changeQueue = changeQueue
          }
          changeQueue!.inserted += key
          for (i, sel) in selections.enumerated() {
            let from = cursorMin(sel.anchor, sel.head)
            let to = cursorMax(sel.anchor, sel.head)
            let text = cm.getRange(from, cm.overwrite ? to.offsetting(0, 1) : to)
            if i < changeQueue!.removed.count {
              changeQueue!.removed[i] += text
            } else {
              changeQueue!.removed.append(text)
            }
          }
        }
        return keysAreChars ? .none : .buffered
      case .clear, .full:
        break
      }
      if case .full = match { vim.inputState.keyBuffer = [] }
      vim.expectLiteralNext = false
      lastInsertModeKeyTimer?.cancel()
      lastInsertModeKeyTimer = nil
      var command: VimCommand?
      if case .full(let c) = match { command = c }
      if command != nil, let changeQueue {
        for (i, sel) in cm.listSelections().enumerated() {
          let here = sel.head
          try cm.replaceRange(
            i < changeQueue.removed.count ? changeQueue.removed[i] : VimText(),
            here.offsetting(0, -changeQueue.inserted.length), here)
        }
        if !globalState.macroModeState.lastInsertModeChanges.changes.isEmpty {
          globalState.macroModeState.lastInsertModeChanges.changes.removeLast()
        }
      }
      if command == nil { clearInputState(cm) }
      return command.map { .command($0) } ?? .none
    }

    func handleKeyNonInsertMode() throws -> Outcome {
      if try handleMacroRecording() || handleEsc() { return .buffered }
      vim.inputState.keyBuffer.append(key)
      let keys = vim.inputState.keyBuffer.joined()
      if isRepeatDigits(keys) { return .buffered }
      guard let (digits, rest) = splitLeadingDigits(keys) else {
        clearInputState(cm)
        return .none
      }
      let context: KeyContext = vim.visualMode ? .visual : .normal
      var mainKey = rest.isEmpty ? digits : rest
      if let shortcut = vim.inputState.operatorShortcut, shortcut.slice(-1) == mainKey {
        // multikey operators act linewise by repeating only the last character
        mainKey = shortcut
      }
      let match = matchCommand(mainKey, vim.inputState, context)
      switch match {
      case .none:
        clearInputState(cm)
        return .none
      case .partial(let expectLiteralNext):
        if expectLiteralNext { vim.expectLiteralNext = true }
        return .buffered
      case .clear:
        clearInputState(cm)
        return .buffered
      case .full(let command):
        vim.expectLiteralNext = false
        vim.inputState.keyBuffer = []
        if !digits.isEmpty && digits != "0" { vim.inputState.pushRepeatDigit(digits.string) }
        return .command(command)
      }
    }

    let outcome = vim.insertMode ? try handleKeyInsertMode() : try handleKeyNonInsertMode()
    switch outcome {
    case .none:
      let swallow = !vim.insertMode && (key.length == 1 || (isMac && isAltKey(key)))
      return swallow ? { true } : nil
    case .buffered:
      return { true }
    case .command(let command):
      return { [unowned self] () throws -> Bool in
        try cm.operation { () throws -> Bool in
          cm.curOp?.isVimOp = true
          do throws {
            if command.type == .keyToKey {
              try self.doKeyToKey(cm, command.toKeys ?? VimText(), command)
            } else {
              try self.processCommand(cm, vim, command)
            }
          } catch {
            // Clear the vim state in case it's in a bad state.
            cm.vim = nil
            self.maybeInitVimState(cm)
            throw error
          }
          return true
        }
      }
    }
  }

  /// `/<A-.>/.test(key)`.
  private func isAltKey(_ key: VimText) -> Bool {
    let u = key.units
    guard u.count >= 5 else { return false }
    for i in 0...(u.count - 5)
    where u[i] == 0x3C && u[i + 1] == 0x41 && u[i + 2] == 0x2D && !isJSLineTerminator(u[i + 3])
      && u[i + 4] == 0x3E
    {
      return true
    }
    return false
  }

  /// `/^[1-9]\d*$/.test(keys)`.
  private func isRepeatDigits(_ keys: VimText) -> Bool {
    guard let first = keys.code(at: 0), first >= 0x31 && first <= 0x39 else { return false }
    return keys.units.allSatisfy(isASCIIDigit)
  }

  /// `/^(\d*)(.*)$/.exec(keys)`: nil when the rest contains a line terminator.
  private func splitLeadingDigits(_ keys: VimText) -> (VimText, VimText)? {
    var i = 0
    while i < keys.length && isASCIIDigit(keys[i]) { i += 1 }
    let rest = keys.slice(i)
    if rest.units.contains(where: isJSLineTerminator) { return nil }
    return (keys.slice(0, i), rest)
  }

  // MARK: Matching

  enum CommandMatch {
    case none
    case partial(expectLiteralNext: Bool)
    case clear
    case full(VimCommand)
  }

  /// `commandDispatcher.matchCommand(keys, keyMap, inputState, context)`.
  func matchCommand(_ keys: VimText, _ inputState: InputState, _ context: KeyContext)
    -> CommandMatch
  {
    let (partial, full) = commandMatches(keys, context, inputState)
    guard let bestMatch = full.first else {
      if !partial.isEmpty {
        return .partial(
          expectLiteralNext: partial.count == 1 && partial[0].keys.slice(-11) == "<character>")
      }
      return .none
    }
    if bestMatch.keys.slice(-11) == "<character>" || bestMatch.keys.slice(-10) == "<register>" {
      let character = lastChar(keys)
      if character.isEmpty || character.length > 1 { return .clear }
      inputState.selectedCharacter = character
    }
    return .full(bestMatch)
  }

  /// `commandMatches(keys, keyMap, context, inputState)`.
  private func commandMatches(_ keys: VimText, _ contextIn: KeyContext, _ inputState: InputState)
    -> ([VimCommand], [VimCommand])
  {
    var context = contextIn
    if inputState.operator != nil { context = .operatorPending }
    var partial: [VimCommand] = []
    var full: [VimCommand] = []
    // If the current expansion comes from a noremap, search only the default keys.
    let startIndex = noremap ? max(0, keymap.count - defaultKeymapLength) : 0
    for command in keymap[startIndex...] {
      if context == .insert && command.context != .insert { continue }
      if let c = command.context, c != context { continue }
      if inputState.operator != nil && command.type == .action { continue }
      switch commandMatch(keys, command.keys) {
      case .partial: partial.append(command)
      case .full: full.append(command)
      case nil: continue
      }
    }
    return (partial, full)
  }

  private enum KeyMatch {
    case partial, full
  }

  /// `commandMatch(pressed, mapped)`.
  private func commandMatch(_ pressed: VimText, _ mapped: VimText) -> KeyMatch? {
    let isLastCharacter = mapped.slice(-11) == "<character>"
    let isLastRegister = mapped.slice(-10) == "<register>"
    if isLastCharacter || isLastRegister {
      let prefixLen = mapped.length - (isLastCharacter ? 11 : 10)
      let pressedPrefix = pressed.slice(0, prefixLen)
      let mappedPrefix = mapped.slice(0, prefixLen)
      if pressedPrefix == mappedPrefix && pressed.length > prefixLen { return .full }
      return mappedPrefix.indexOf(pressedPrefix) == 0 ? .partial : nil
    }
    if pressed == mapped { return .full }
    return mapped.indexOf(pressed) == 0 ? .partial : nil
  }

  /// `lastChar(keys)`: the character a `<character>` or `<register>` command received.
  func lastChar(_ keys: VimText) -> VimText {
    // /^.*(<[^>]+>)$/: a named key at the very end, after no line terminator.
    var selected = keys.slice(-1)
    let u = keys.units
    if u.last == 0x3E, !u.contains(where: isJSLineTerminator), let open = u.lastIndex(of: 0x3C),
      open < u.count - 2,
      !u[(open + 1)..<(u.count - 1)].contains(0x3E)
    {
      selected = VimText(u[open...])
    }
    if selected.length > 1 {
      switch selected.string {
      case "<CR>", "<S-CR>": selected = "\n"
      case "<Space>", "<S-Space>": selected = " "
      default: selected = VimText()
      }
    }
    return selected
  }

  // MARK: Key to key

  /// `doKeyToKey(cm, keys, fromKey)`: feeds `keys` to vim as if typed.
  func doKeyToKey(_ cm: EditorAdapter, _ keys: VimText, _ fromKey: KeyToKeySource?) throws {
    let noremapBefore = noremap
    // prevent infinite recursion.
    if let fromKey {
      if keyToKeyStack.contains(where: { $0 === fromKey }) { return }
      keyToKeyStack.append(fromKey)
      noremap = fromKey.noremapForKeyToKey
    }
    defer {
      if !keyToKeyStack.isEmpty { keyToKeyStack.removeLast() }
      noremap = keyToKeyStack.isEmpty ? false : noremapBefore
      if keyToKeyStack.isEmpty, let promptOptions = virtualPrompt {
        virtualPrompt = nil
        showPrompt(cm, promptOptions)
      }
    }
    let vim = maybeInitVimState(cm)
    var index = 0
    while let (token, at) = nextKeyToken(keys, from: index) {
      var key = token
      index = at + token.length
      let wasInsert = vim.insertMode
      if virtualPrompt != nil {
        try sendKeyToPrompt(key)
        continue
      }
      let result = try handleKey(cm, key, "mapping")
      if !result && wasInsert && vim.insertMode {
        if key.code(at: 0) == 0x3C {
          var lowerKey = key.toLowerCase().slice(1, -1)
          lowerKey = lowerKey.split(unit: 0x2D).last ?? VimText()
          if lowerKey == "lt" {
            key = "<"
          } else if lowerKey == "space" {
            key = " "
          } else if lowerKey == "cr" {
            key = "\n"
          } else if let cmKey = VimKeyNotation.vimToCmKeyMap[lowerKey.string] {
            sendCmKey(cm, cmKey)
            continue
          } else {
            key = key.charAt(0)
            index = at + 1
          }
        }
        cm.replaceSelection(key)
      }
    }
  }

  /// `sendKeyToPrompt(key)`: a key of a mapping typed into a prompt it opened.
  func sendKeyToPrompt(_ keyIn: VimText) throws {
    guard let prompt = virtualPrompt else { return }
    var key = keyIn
    let close: (VimText?) -> Void = { [unowned self] value in
      guard self.virtualPrompt != nil else { return }
      if let value { self.virtualPrompt?.value = value } else { self.virtualPrompt = nil }
    }
    if key.code(at: 0) == 0x3C {
      var lowerKey = key.toLowerCase().slice(1, -1)
      lowerKey = lowerKey.split(unit: 0x2D).last ?? VimText()
      if lowerKey == "lt" {
        key = "<"
      } else if lowerKey == "space" {
        key = " "
      } else if lowerKey == "cr" {
        key = "\n"
      } else if let cmKey = VimKeyNotation.vimToCmKeyMap[lowerKey.string] {
        let event = DOMKeyEvent(key: cmKey)
        _ = prompt.onKeyDown?(event, prompt.value, close)
        if let current = virtualPrompt {
          _ = current.onKeyUp?(event, current.value, close)
        }
        return
      }
    }
    if key == "\n" {
      virtualPrompt = nil
      try prompt.onClose?(prompt.value)
    } else {
      prompt.value += key
    }
  }

  /// `sendCmKey(cm, key)`: a special key (Backspace, arrows) in insert mode, through the editor's
  /// key bindings.
  func sendCmKey(_ cm: EditorAdapter, _ key: String) {
    cm.runInsertModeKey(key)
  }
}
