// Ported from `actions` of vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and
// others).

extension Vim {
  func registerActions() {
    func define(_ name: String, _ fn: @escaping ActionFn) { actions[name] = fn }
    define("jumpListWalk") { [unowned self] cm, args, vim throws in
      if vim.visualMode { return }
      let count = args.repeat != 0 ? args.repeat : 1
      let mark = self.globalState.jumpList.move(cm, args.forward ? count : -count)
      cm.setCursor(mark?.find() ?? cm.getCursor())
    }
    define("scroll") { [unowned self] cm, args, vim throws in self.actScroll(cm, args, vim) }
    define("scrollToCursor") { cm, args, _ throws in
      let lineNum = cm.getCursor().line
      let charCoords = cm.charCoords(Pos(lineNum, 0))
      let height = cm.getScrollInfo().clientHeight
      var y = charCoords.top
      switch args.position {
      case "center":
        y = charCoords.bottom - height / 2
      case "bottom":
        let lineLastCharCoords = cm.charCoords(Pos(lineNum, cm.getLine(lineNum).length - 1))
        let lineHeight = lineLastCharCoords.bottom - y
        y = y - height + lineHeight
      default:
        break
      }
      cm.scrollTo(nil, y)
    }
    define("replayMacro") { [unowned self] cm, args, vim throws in
      var registerName = args.selectedCharacter?.string ?? ""
      var count = args.repeat != 0 ? args.repeat : 1
      let macroModeState = self.globalState.macroModeState
      if registerName == "@" {
        registerName = macroModeState.latestRegister ?? ""
      } else {
        macroModeState.latestRegister = registerName
      }
      while count > 0 {
        count -= 1
        try self.executeMacroRegister(cm, vim, macroModeState, registerName)
      }
    }
    define("enterMacroRecordMode") { [unowned self] cm, args, _ throws in
      let registerName = args.selectedCharacter?.string
      if self.globalState.registerController.isValidRegister(registerName), let name = registerName
      {
        self.enterMacroRecordMode(cm, name)
      }
    }
    define("toggleOverwrite") { cm, _, _ throws in
      if !cm.overwrite {
        cm.toggleOverwrite(true)
        cm.setOption("keyMap", "vim-replace")
        cm.signal(.vimModeChange, .modeChange(mode: "replace", subMode: nil))
      } else {
        cm.toggleOverwrite(false)
        cm.setOption("keyMap", "vim-insert")
        cm.signal(.vimModeChange, .modeChange(mode: "insert", subMode: nil))
      }
    }
    define("enterInsertMode") { [unowned self] cm, args, vim throws in
      try self.actEnterInsertMode(cm, args, vim)
    }
    define("toggleVisualMode") { [unowned self] cm, args, vim throws in
      try self.actToggleVisualMode(cm, args, vim)
    }
    define("reselectLastSelection") { [unowned self] cm, _, vim throws in
      let lastSelection = vim.lastSelection
      if vim.visualMode { try self.updateLastSelection(cm, vim) }
      guard let lastSelection else { return }
      // If the marks have been destroyed due to edits, do nothing.
      guard let anchor = lastSelection.anchorMark.find(), let head = lastSelection.headMark.find()
      else { return }
      vim.sel = VimRange(anchor: anchor, head: head)
      vim.visualMode = true
      vim.visualLine = lastSelection.visualLine
      vim.visualBlock = lastSelection.visualBlock
      self.updateCmSelection(cm)
      self.updateMark(cm, vim, "<", cursorMin(anchor, head))
      self.updateMark(cm, vim, ">", cursorMax(anchor, head))
      cm.signal(
        .vimModeChange,
        .modeChange(
          mode: "visual", subMode: vim.visualLine ? "linewise" : vim.visualBlock ? "blockwise" : "")
      )
    }
    define("joinLines") { [unowned self] cm, args, vim throws in
      try self.actJoinLines(cm, args, vim)
    }
    define("newLineAndEnterInsertMode") { [unowned self] cm, args, vim throws in
      vim.insertMode = true
      var insertAt = cm.getCursor()
      if insertAt.line == cm.firstLine() && !args.after {
        // Special case for inserting newline before start of document.
        try cm.replaceRange("\n", Pos(cm.firstLine(), 0))
        cm.setCursor(cm.firstLine(), 0)
      } else {
        insertAt.line = args.after ? insertAt.line : insertAt.line - 1
        insertAt.ch = self.lineLength(cm, insertAt.line)
        cm.setCursor(insertAt)
        cm.execCommand("newlineAndIndent")
      }
      let insertArgs = ActionArgs()
      insertArgs.repeat = args.repeat
      try self.actEnterInsertMode(cm, insertArgs, vim)
    }
    define("paste") { [unowned self] cm, args, vim throws in
      var register = self.globalState.registerController.getRegister(args.registerName)
      if args.registerName == "+", let clipboard = self.clipboard {
        try self.continuePaste(cm, args, vim, VimText(clipboard.readText() ?? ""), register)
      } else {
        var text = register.text
        if args.registerName == nil || args.registerName == "\"", let session = cm.session,
          let source = self.unnamedPasteRegister?(session)
        {
          let other = source.text
          if !other.isEmpty && other != text {
            register = source
            text = other
          }
        }
        try self.continuePaste(cm, args, vim, text, register)
      }
    }
    define("undo") { cm, args, _ throws in
      try cm.operation { () throws in
        for _ in 0..<args.repeat { cm.execCommand("undo") }
        cm.setCursor(self.clipCursorToContent(cm, cm.getCursor(.start)))
      }
    }
    define("redo") { cm, args, _ throws in
      for _ in 0..<args.repeat { cm.execCommand("redo") }
    }
    define("setRegister") { _, args, vim throws in
      vim.inputState.registerName = args.selectedCharacter?.string
    }
    define("insertRegister") { [unowned self] cm, args, _ throws in
      let register = self.globalState.registerController.getRegister(args.selectedCharacter?.string)
      let text = register.text
      if !text.isEmpty { cm.replaceSelection(text) }
    }
    define("oneNormalCommand") { [unowned self] cm, _, vim throws in
      try self.exitInsertMode(cm, keepCursor: true)
      vim.insertModeReturn = true
      let token = HandlerToken()
      cm.on(.vimCommandDone, token) { [unowned self, unowned cm, unowned vim] _ in
        if vim.visualMode { return }
        if vim.insertModeReturn {
          vim.insertModeReturn = false
          if !vim.insertMode { try? self.actEnterInsertMode(cm, ActionArgs(), vim) }
        }
        cm.off(.vimCommandDone, token)
      }
    }
    define("setMark") { [unowned self] cm, args, vim throws in
      if let markName = args.selectedCharacter, !markName.isEmpty {
        self.updateMark(cm, vim, markName.string, cm.getCursor())
      }
    }
    define("replace") { [unowned self] cm, args, vim throws in try self.actReplace(cm, args, vim) }
    define("incrementNumberToken") { [unowned self] cm, args, _ throws in
      try self.actIncrementNumberToken(cm, args)
    }
    define("repeatLastEdit") { [unowned self] cm, args, vim throws in
      guard let lastEditInputState = vim.lastEditInputState else { return }
      var count = args.repeat
      if count != 0 && args.repeatIsExplicit {
        lastEditInputState.repeatOverride = count
      } else {
        count = lastEditInputState.repeatOverride ?? count
      }
      try self.repeatLastEdit(cm, vim, count, repeatForInsert: false)
    }
    define("indent") { cm, args, _ throws in
      cm.indentLine(cm.getCursor().line, args.indentRight)
    }
    define("exitInsertMode") { [unowned self] cm, _, _ throws in try self.exitInsertMode(cm) }
  }

  /// `actions.scroll`: `<C-e>` / `<C-y>`.
  private func actScroll(_ cm: EditorAdapter, _ args: ActionArgs, _ vim: VimState) {
    if vim.visualMode { return }
    let count = Double(args.repeat != 0 ? args.repeat : 1)
    let lineHeight = cm.defaultTextHeight()
    let top = cm.getScrollInfo().top
    let delta = lineHeight * count
    let newPos = args.forward ? top + delta : top - delta
    let cursor = cm.getCursor()
    var cursorCoords = cm.charCoords(cursor)
    if args.forward {
      if newPos > cursorCoords.top {
        let line = (Double(cursor.line) + (newPos - cursorCoords.top) / lineHeight).rounded(.up)
        let moved = Pos(Int(line), cursor.ch)
        cm.setCursor(moved)
        cursorCoords = cm.charCoords(moved)
        cm.scrollTo(nil, cursorCoords.top)
      } else {
        // Cursor stays within bounds. Just reposition the scroll window.
        cm.scrollTo(nil, newPos)
      }
    } else {
      let newBottom = newPos + cm.getScrollInfo().clientHeight
      if newBottom < cursorCoords.bottom {
        let line = (Double(cursor.line) - (cursorCoords.bottom - newBottom) / lineHeight).rounded(
          .down)
        let moved = Pos(Int(line), cursor.ch)
        cm.setCursor(moved)
        cursorCoords = cm.charCoords(moved)
        cm.scrollTo(nil, cursorCoords.bottom - cm.getScrollInfo().clientHeight)
      } else {
        // Cursor stays within bounds. Just reposition the scroll window.
        cm.scrollTo(nil, newPos)
      }
    }
  }

  /// `actions.enterInsertMode`.
  func actEnterInsertMode(_ cm: EditorAdapter, _ args: ActionArgs, _ vim: VimState) throws {
    if cm.getOption("readOnly")?.isTruthy ?? false { return }
    vim.insertMode = true
    vim.insertModeRepeat = args.repeat != 0 ? args.repeat : 1
    let insertAt = args.insertAt
    let sel = vim.sel
    var head = args.head ?? cm.getCursor(.head)
    var height = cm.listSelections().count
    switch insertAt {
    case "eol":
      head = Pos(head.line, lineLength(cm, head.line))
    case "bol":
      head = Pos(head.line, 0)
    case "charAfter":
      head = updateSelectionForSurrogateCharacters(cm, head, head.offsetting(0, 1)).end
    case "firstNonBlank":
      let first = Pos(head.line, findFirstNonWhiteSpaceCharacter(cm.getLine(head.line)))
      head = updateSelectionForSurrogateCharacters(cm, head, first).end
    case "startOfSelectedArea":
      if !vim.visualMode { return }
      if !vim.visualBlock {
        head = sel.head.line < sel.anchor.line ? sel.head : Pos(sel.anchor.line, 0)
      } else {
        head = Pos(min(sel.head.line, sel.anchor.line), min(sel.head.ch, sel.anchor.ch))
        height = abs(sel.head.line - sel.anchor.line) + 1
      }
    case "endOfSelectedArea":
      if !vim.visualMode { return }
      if !vim.visualBlock {
        head =
          sel.head.line >= sel.anchor.line ? sel.head.offsetting(0, 1) : Pos(sel.anchor.line, 0)
      } else {
        head = Pos(min(sel.head.line, sel.anchor.line), chAdd(max(sel.head.ch, sel.anchor.ch), 1))
        height = abs(sel.head.line - sel.anchor.line) + 1
      }
    case "inplace":
      if vim.visualMode { return }
    case "lastEdit":
      head = getLastEditPos(cm) ?? head
    default:
      break
    }
    if args.replace {
      // Handle Replace-mode as a special case of insert mode.
      cm.toggleOverwrite(true)
      cm.setOption("keyMap", "vim-replace")
      cm.signal(.vimModeChange, .modeChange(mode: "replace", subMode: nil))
    } else {
      cm.toggleOverwrite(false)
      cm.setOption("keyMap", "vim-insert")
      cm.signal(.vimModeChange, .modeChange(mode: "insert", subMode: nil))
    }
    if !globalState.macroModeState.isPlaying {
      // Only record if not replaying.
      cm.on(.change, onChangeToken) { [unowned self, unowned cm] payload in
        if case .change(let change) = payload { self.onChange(cm, change) }
      }
      vim.insertEnd?.clear()
      vim.insertEnd = cm.setBookmark(head, insertLeft: true)
      cm.onInputFieldKeydown(onKeyEventTargetKeyDownToken) { [unowned self] event in
        self.onKeyEventTargetKeyDown(event)
      }
    }
    if vim.visualMode { try exitVisualMode(cm) }
    selectForInsert(cm, head, height)
  }

  /// `actions.toggleVisualMode`: `v`, `V`, `<C-v>`.
  private func actToggleVisualMode(_ cm: EditorAdapter, _ args: ActionArgs, _ vim: VimState) throws
  {
    let count = args.repeat
    let anchor = cm.getCursor()
    let linewise = args.linewise ?? false
    if !vim.visualMode {
      // Entering visual mode
      vim.visualMode = true
      vim.visualLine = linewise
      vim.visualBlock = args.blockwise
      let head = clipCursorToContent(cm, Pos(anchor.line, anchor.ch + count - 1))
      let newPosition = updateSelectionForSurrogateCharacters(cm, anchor, head)
      vim.sel = VimRange(anchor: newPosition.start, head: newPosition.end)
      cm.signal(
        .vimModeChange,
        .modeChange(
          mode: "visual", subMode: vim.visualLine ? "linewise" : vim.visualBlock ? "blockwise" : "")
      )
      updateCmSelection(cm)
      updateMark(cm, vim, "<", cursorMin(anchor, head))
      updateMark(cm, vim, ">", cursorMax(anchor, head))
    } else if vim.visualLine != linewise || vim.visualBlock != args.blockwise {
      // Toggling between modes
      vim.visualLine = linewise
      vim.visualBlock = args.blockwise
      cm.signal(
        .vimModeChange,
        .modeChange(
          mode: "visual", subMode: vim.visualLine ? "linewise" : vim.visualBlock ? "blockwise" : "")
      )
      updateCmSelection(cm)
    } else {
      try exitVisualMode(cm)
    }
  }

  /// `actions.joinLines`: `J`, `gJ`.
  private func actJoinLines(_ cm: EditorAdapter, _ args: ActionArgs, _ vim: VimState) throws {
    var curStart: Pos
    var curEnd: Pos
    if vim.visualMode {
      curStart = cm.getCursor(.anchor)
      curEnd = cm.getCursor(.head)
      if cursorIsBefore(curEnd, curStart) { swap(&curStart, &curEnd) }
      curEnd.ch = lineLength(cm, curEnd.line) - 1
    } else {
      // Repeat is the number of lines to join. Minimum 2 lines.
      let count = max(args.repeat, 2)
      curStart = cm.getCursor()
      curEnd = clipCursorToContent(cm, Pos(curStart.line + count - 1, Pos.endOfLine))
    }
    var finalCh = 0
    var i = curStart.line
    while i < curEnd.line {
      finalCh = lineLength(cm, curStart.line)
      var text = VimText()
      var nextStartCh = 0
      if !args.keepSpaces {
        let nextLine = cm.getLine(curStart.line + 1)
        nextStartCh = nextLine.firstNonWhitespace()
        if nextStartCh == -1 {
          nextStartCh = nextLine.length
        } else {
          text = " "
        }
      }
      try cm.replaceRange(text, Pos(curStart.line, finalCh), Pos(curStart.line + 1, nextStartCh))
      i += 1
    }
    let curFinalPos = clipCursorToContent(cm, Pos(curStart.line, finalCh))
    if vim.visualMode { try exitVisualMode(cm, moveHead: false) }
    cm.setCursor(curFinalPos)
  }

  /// `actions.continuePaste`.
  func continuePaste(
    _ cm: EditorAdapter, _ args: ActionArgs, _ vim: VimState, _ textIn: VimText,
    _ register: VimRegister
  ) throws {
    var cur = cm.getCursor()
    var text = textIn
    if text.isEmpty { return }
    if args.matchIndent {
      let tabSize = cm.tabSize
      // length that considers tabs and tabSize
      func whitespaceLength(_ str: VimText) -> Int {
        let tabs = str.split(unit: 0x09).count - 1
        let spaces = str.split(unit: 0x20).count - 1
        return tabs * tabSize + spaces
      }
      let currentLine = cm.getLine(cm.getCursor().line)
      let indent = whitespaceLength(currentLine.slice(0, currentLine.leadingWhitespaceCount()))
      // chomp last newline b/c don't want it to match /^\s*/gm
      let chompedText = text.hasSuffix("\n") ? text.slice(0, -1) : text
      let wasChomped = text != chompedText
      let firstIndent = whitespaceLength(text.slice(0, text.leadingWhitespaceCount()))
      text = replaceLeadingWhitespaceOfLines(chompedText) { wspace in
        let newIndent = indent + (whitespaceLength(wspace) - firstIndent)
        if newIndent < 0 {
          return VimText()
        } else if cm.indentWithTabs {
          return VimText("\t").repeating(newIndent / tabSize)
        } else {
          return VimText(" ").repeating(newIndent)
        }
      }
      if wasChomped { text += "\n" }
    }
    if args.repeat > 1 { text = text.repeating(args.repeat) }
    let linewise = args.linewise ?? register.linewise
    let blockwise = register.blockwise
    var textLines: [VimText]? = blockwise ? text.split(unit: 0x0A) : nil
    if textLines != nil {
      if linewise { textLines!.removeLast() }
      for i in textLines!.indices where textLines![i].isEmpty { textLines![i] = " " }
      cur.ch += args.after ? 1 : 0
      cur.ch = min(lineLength(cm, cur.line), cur.ch)
    } else if linewise {
      if vim.visualMode {
        text =
          vim.visualLine ? text.slice(0, -1) : VimText("\n") + text.slice(0, text.length - 1) + "\n"
      } else if args.after {
        // Move the newline at the end to the start instead, and paste just before the newline
        // character of the line we are on right now.
        text = VimText("\n") + text.slice(0, text.length - 1)
        cur.ch = lineLength(cm, cur.line)
      } else {
        cur.ch = 0
      }
    } else {
      cur.ch += args.after ? 1 : 0
    }
    var curPosFinal: Pos
    if vim.visualMode {
      // save the pasted text for reselection if the need arises
      vim.lastPastedText = text
      var lastSelectionCurEnd: Pos?
      let selectedArea = getSelectedAreaRange(cm, vim)
      let selectionStart = selectedArea.0
      var selectionEnd = selectedArea.1
      let selectedText = cm.getSelection()
      let selections = cm.listSelections()
      let emptyStrings = Array(repeating: VimText(), count: selections.count)
      // save the curEnd marker before it get cleared due to cm.replaceRange.
      if let last = vim.lastSelection { lastSelectionCurEnd = last.headMark.find() }
      // push the previously selected text to unnamed register
      globalState.registerController.unnamedRegister.setText(selectedText)
      if blockwise {
        // first delete the selected text
        cm.replaceSelections(emptyStrings)
        // Set new selections as per the block length of the yanked text
        selectionEnd = Pos(selectionStart.line + text.length - 1, selectionStart.ch)
        cm.setCursor(selectionStart)
        selectBlock(cm, &selectionEnd)
        // vim.js passes the text itself (a string is indexed by character).
        cm.replaceSelections(text.units.map { VimText(unit: $0) })
        curPosFinal = selectionStart
      } else if vim.visualBlock {
        cm.replaceSelections(emptyStrings)
        cm.setCursor(selectionStart)
        try cm.replaceRange(text, selectionStart, selectionStart)
        curPosFinal = selectionStart
      } else {
        try cm.replaceRange(text, selectionStart, selectionEnd)
        curPosFinal = try cm.posFromIndexChecked(cm.indexFromPos(selectionStart) + text.length - 1)
      }
      // restore the curEnd marker
      if let end = lastSelectionCurEnd { vim.lastSelection?.headMark = cm.setBookmark(end) }
      if linewise { curPosFinal.ch = 0 }
    } else {
      if blockwise, let lines = textLines {
        cm.setCursor(cur)
        for i in lines.indices {
          let line = cur.line + i
          if line > cm.lastLine() { try cm.replaceRange("\n", Pos(line, 0)) }
          let lastCh = lineLength(cm, line)
          if lastCh < cur.ch { try extendLineToColumn(cm, line, cur.ch) }
        }
        cm.setCursor(cur)
        var corner = Pos(cur.line + lines.count - 1, cur.ch)
        selectBlock(cm, &corner)
        cm.replaceSelections(lines)
        curPosFinal = cur
      } else {
        try cm.replaceRange(text, cur)
        // Now fine tune the cursor to where we want it.
        if linewise {
          let line = args.after ? cur.line + 1 : cur.line
          curPosFinal = Pos(line, findFirstNonWhiteSpaceCharacter(cm.getLine(line)))
        } else {
          curPosFinal = cur
          if !text.contains(unit: 0x0A) { curPosFinal.ch += text.length - (args.after ? 1 : 0) }
        }
      }
    }
    if vim.visualMode { try exitVisualMode(cm, moveHead: false) }
    cm.setCursor(curPosFinal)
  }

  /// `text.replace(/^\s*/gm, fn)`: every (possibly empty) run of whitespace at a line start; a
  /// run can span line breaks, swallowing blank lines.
  private func replaceLeadingWhitespaceOfLines(_ text: VimText, _ fn: (VimText) -> VimText)
    -> VimText
  {
    let u = text.units
    var out: [UInt16] = []
    var last = 0
    var i = 0
    while i <= u.count {
      // A match starts at the first line start at or after i.
      var start = i
      while start <= u.count && !(start == 0 || isJSLineTerminator(u[start - 1])) { start += 1 }
      if start > u.count { break }
      var end = start
      while end < u.count && isJSWhitespace(u[end]) { end += 1 }
      out.append(contentsOf: u[last..<start])
      out.append(contentsOf: fn(VimText(u[start..<end])).units)
      last = end
      i = end == start ? end + 1 : end
    }
    out.append(contentsOf: u[min(last, u.count)...])
    return VimText(units: out)
  }

  /// `actions.replace`: `r<character>`.
  private func actReplace(_ cm: EditorAdapter, _ args: ActionArgs, _ vim: VimState) throws {
    let replaceWith = args.selectedCharacter ?? VimText()
    var curStart = cm.getCursor()
    var curEnd: Pos
    let selections = cm.listSelections()
    if vim.visualMode {
      curStart = cm.getCursor(.start)
      curEnd = cm.getCursor(.end)
    } else {
      let line = cm.getLine(curStart.line)
      var replaceTo = curStart.ch + args.repeat
      if replaceTo > line.length { replaceTo = line.length }
      curEnd = Pos(curStart.line, replaceTo)
    }
    let newPositions = updateSelectionForSurrogateCharacters(cm, curStart, curEnd)
    curStart = newPositions.start
    curEnd = newPositions.end
    if replaceWith == "\n" {
      if !vim.visualMode { try cm.replaceRange("", curStart, curEnd) }
      // special case, where vim help says to replace by just one line-break
      cm.execCommand("newlineAndIndent")
      return
    }
    /// `str.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, replaceWith).replace(/[^\n]/g, replaceWith)`:
    /// the second pass also replaces each code unit the first one inserted.
    func replaceCharacters(_ text: VimText) -> VimText {
      var pairsReplaced: [UInt16] = []
      var i = 0
      let u = text.units
      while i < u.count {
        if isHighSurrogate(u[i]), i + 1 < u.count, isLowSurrogate(u[i + 1]) {
          pairsReplaced.append(contentsOf: replaceWith.units)
          i += 2
        } else {
          pairsReplaced.append(u[i])
          i += 1
        }
      }
      return VimText(units: pairsReplaced.flatMap { $0 == 0x0A ? [0x0A] : replaceWith.units })
    }
    if vim.visualBlock {
      // Tabs are split in visual block before replacing
      let spaces = VimText(" ").repeating(cm.tabSize)
      // Surrogate pairs first, then tabs as spaces, then every character (three passes).
      var pairsReplaced: [UInt16] = []
      let selected = cm.getSelection()
      var i = 0
      while i < selected.length {
        if isHighSurrogate(selected[i]), i + 1 < selected.length, isLowSurrogate(selected[i + 1]) {
          pairsReplaced.append(contentsOf: replaceWith.units)
          i += 2
        } else {
          pairsReplaced.append(selected[i])
          i += 1
        }
      }
      let tabsReplaced = pairsReplaced.flatMap { $0 == 0x09 ? spaces.units : [$0] }
      let replaced = VimText(
        units: tabsReplaced.flatMap { $0 == 0x0A ? [0x0A] : replaceWith.units })
      cm.replaceSelections(replaced.split(unit: 0x0A))
    } else {
      try cm.replaceRange(replaceCharacters(cm.getRange(curStart, curEnd)), curStart, curEnd)
    }
    if vim.visualMode {
      curStart =
        cursorIsBefore(selections[0].anchor, selections[0].head)
        ? selections[0].anchor : selections[0].head
      cm.setCursor(curStart)
      try exitVisualMode(cm, moveHead: false)
    } else {
      cm.setCursor(curEnd.offsetting(0, -1))
    }
  }

  /// `actions.incrementNumberToken`: `<C-a>`, `<C-x>`.
  private func actIncrementNumberToken(_ cm: EditorAdapter, _ args: ActionArgs) throws {
    let cur = cm.getCursor()
    let lineStr = cm.getLine(cur.line)
    var found: NumberToken?
    var start = 0
    var end = 0
    var searchFrom = 0
    while let token = nextNumberToken(lineStr, from: searchFrom) {
      found = token
      start = token.index
      end = start + token.length
      if cur.ch < end { break }
      searchFrom = end
      found = nil
    }
    if !args.backtrack && end <= cur.ch { return }
    guard let match = found else { return }
    let baseStr = match.base
    let digits = match.digits
    let increment = args.increase ? 1.0 : -1.0
    let radix: Int
    switch baseStr.toLowerCase().string {
    case "0b": radix = 2
    case "0": radix = 8
    case "0x": radix = 16
    default: radix = 10
    }
    let number =
      JSNumber.parseInt(match.sign + digits, radix: radix) + increment * Double(args.repeat)
    var numberStr = JSNumber.toString(number, radix: radix)
    var zeroPadding = VimText()
    if !baseStr.isEmpty {
      let count = digits.length - numberStr.length + 1 + match.sign.length
      if count < 0 { throw JSException.rangeError("Invalid array length") }
      zeroPadding = VimText("0").repeating(count - 1)
    }
    if numberStr.charAt(0) == "-" {
      numberStr = VimText("-") + baseStr + zeroPadding + numberStr.substr(1)
    } else {
      numberStr = baseStr + zeroPadding + numberStr
    }
    try cm.replaceRange(numberStr, Pos(cur.line, start), Pos(cur.line, end))
    cm.setCursor(Pos(cur.line, start + numberStr.length - 1))
  }

  private struct NumberToken {
    var index: Int
    var length: Int
    var sign: VimText
    var base: VimText
    var digits: VimText
  }

  /// The next match of `/(-?)(?:(0x)([\da-f]+)|(0b|0|)(\d+))/gi` at or after `from`.
  private func nextNumberToken(_ s: VimText, from: Int) -> NumberToken? {
    let u = s.units
    func isHex(_ c: UInt16) -> Bool {
      isASCIIDigit(c) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46)
    }
    func digitRun(_ i: Int, _ test: (UInt16) -> Bool) -> Int {
      var j = i
      while j < u.count && test(u[j]) { j += 1 }
      return j
    }
    func match(at p: Int, signed: Bool) -> NumberToken? {
      let q = signed ? p + 1 : p
      // (0x)([\da-f]+)
      if q + 1 < u.count, u[q] == 0x30, u[q + 1] == 0x78 || u[q + 1] == 0x58 {
        let end = digitRun(q + 2, isHex)
        if end > q + 2 {
          return NumberToken(
            index: p, length: end - p, sign: signed ? "-" : "", base: VimText(u[q..<(q + 2)]),
            digits: VimText(u[(q + 2)..<end]))
        }
      }
      // (0b|0|)(\d+)
      for prefix in [2, 1, 0] {
        if prefix == 2 {
          guard q + 1 < u.count, u[q] == 0x30, u[q + 1] == 0x62 || u[q + 1] == 0x42 else {
            continue
          }
        } else if prefix == 1 {
          guard q < u.count, u[q] == 0x30 else { continue }
        }
        let end = digitRun(q + prefix, isASCIIDigit)
        if end > q + prefix {
          return NumberToken(
            index: p, length: end - p, sign: signed ? "-" : "", base: VimText(u[q..<(q + prefix)]),
            digits: VimText(u[(q + prefix)..<end]))
        }
      }
      return nil
    }
    var p = from
    while p < u.count {
      if u[p] == 0x2D, let token = match(at: p, signed: true) { return token }
      if let token = match(at: p, signed: false) { return token }
      p += 1
    }
    return nil
  }
}
