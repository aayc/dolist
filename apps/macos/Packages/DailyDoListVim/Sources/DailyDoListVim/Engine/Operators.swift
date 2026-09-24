// Ported from `operators` of vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke
// and others). An operator acts on the selection `evalInput` made; it returns where the cursor
// goes (nil: leave it).

extension Vim {
  func registerOperators() {
    operators["change"] = { [unowned self] cm, args, ranges, _, _ throws in
      try self.opChange(cm, args, ranges)
      return nil
    }
    operators["delete"] = { [unowned self] cm, args, ranges, _, _ throws in
      try self.opDelete(cm, args, ranges)
    }
    operators["indent"] = { [unowned self] cm, args, ranges, _, _ throws in
      try self.opIndent(cm, args, ranges)
    }
    operators["indentAuto"] = { [unowned self] cm, _, ranges, _, _ throws in
      cm.execCommand("indentAuto")
      return Pos(ranges[0].anchor.line, self.findFirstNonWhiteSpaceCharacter(cm.getLine(ranges[0].anchor.line)))
    }
    operators["hardWrap"] = { cm, args, ranges, oldAnchor, _ throws in
      let from = ranges[0].anchor.line
      var to = ranges[0].head.line
      if args.linewise { to -= 1 }
      var endRow = try cm.hardWrap(from: from, to: to)
      if endRow > from && args.linewise { endRow -= 1 }
      return args.keepCursor ? oldAnchor : Pos(endRow, 0)
    }
    operators["toggleComment"] = { cm, _, _, _, newHead throws in
      cm.execCommand("toggleLineComment")
      return newHead
    }
    operators["changeCase"] = { [unowned self] cm, args, ranges, oldAnchor, newHead throws in
      let selections = cm.getSelections()
      var swapped: [VimText] = []
      for toSwap in selections {
        var text = VimText()
        if args.toLower == true {
          text = toSwap.toLowerCase()
        } else if args.toLower == false {
          text = toSwap.toUpperCase()
        } else {
          for u in toSwap.units {
            let character = VimText(unit: u)
            text += isUppercaseLetter(u) ? character.toLowerCase() : character.toUpperCase()
          }
        }
        swapped.append(text)
      }
      cm.replaceSelections(swapped)
      return self.caseOperatorResult(cm, args, ranges, oldAnchor, newHead)
    }
    operators["yank"] = { [unowned self] cm, args, ranges, oldAnchor, _ throws in
      let vim = cm.vim!
      let text = cm.getSelection()
      let endPos = vim.visualMode ? cursorMin(vim.sel.anchor, vim.sel.head, ranges[0].head, ranges[0].anchor) : oldAnchor
      self.globalState.registerController.pushText(args.registerName, "yank", text, linewise: args.linewise, blockwise: vim.visualBlock)
      let lineCount = abs(cm.getCursor(.end).line - cm.getCursor(.start).line)
      self.showConfirm(
        cm, String(lineCount == 0 ? 1 : lineCount) + " lines yanked" + (args.registerName.flatMap { $0.isEmpty ? nil : " into \"" + $0 } ?? ""),
        long: false, duration: 1.5)
      return endPos
    }
    operators["rot13"] = { [unowned self] cm, args, ranges, oldAnchor, newHead throws in
      let selections = cm.getSelections()
      let swapped = selections.map { selection in
        VimText(units: selection.units.map { code in
          if code >= 65 && code <= 90 { return 65 + ((code - 65 + 13) % 26) }
          if code >= 97 && code <= 122 { return 97 + ((code - 97 + 13) % 26) }
          return code
        })
      }
      cm.replaceSelections(swapped)
      return self.caseOperatorResult(cm, args, ranges, oldAnchor, newHead)
    }
  }

  /// Where `changeCase` and `rot13` leave the cursor.
  private func caseOperatorResult(_ cm: EditorAdapter, _ args: OperatorArgs, _ ranges: [VimRange], _ oldAnchor: Pos, _ newHead: Pos?) -> Pos? {
    if args.shouldMoveCursor {
      return newHead
    } else if !(cm.vim?.visualMode ?? false) && args.linewise && ranges[0].anchor.line + 1 == ranges[0].head.line {
      return Pos(oldAnchor.line, findFirstNonWhiteSpaceCharacter(cm.getLine(oldAnchor.line)))
    } else if args.linewise {
      return oldAnchor
    } else {
      return cursorMin(ranges[0].anchor, ranges[0].head)
    }
  }

  /// `operators.change`.
  private func opChange(_ cm: EditorAdapter, _ args: OperatorArgs, _ ranges: [VimRange]) throws {
    let vim = cm.vim!
    var anchor = ranges[0].anchor
    var head = ranges[0].head
    let finalHead: Pos
    var text: VimText
    if !vim.visualMode {
      text = cm.getRange(anchor, head)
      let lastState = vim.lastEditInputState
      if lastState?.motion == "moveByWords" && !VimText.isWhiteSpaceString(text) {
        // Exclude trailing whitespace if the range is not all whitespace.
        let trailing = text.length - text.trimEnd().length
        if trailing > 0 && (lastState?.motionArgs?.forward ?? false) {
          head = head.offsetting(0, -trailing)
          text = text.slice(0, -trailing)
        }
      }
      if args.linewise {
        anchor = Pos(anchor.line, findFirstNonWhiteSpaceCharacter(cm.getLine(anchor.line)))
        if head.line > anchor.line { head = Pos(head.line - 1, Pos.endOfLine) }
      }
      try cm.replaceRange("", anchor, head)
      finalHead = anchor
    } else if args.fullLine {
      head.ch = Pos.endOfLine
      head.line -= 1
      cm.setSelection(anchor, head)
      text = cm.getSelection()
      cm.replaceSelection("")
      finalHead = anchor
    } else {
      text = cm.getSelection()
      cm.replaceSelections(Array(repeating: VimText(), count: ranges.count))
      finalHead = cursorMin(ranges[0].head, ranges[0].anchor)
    }
    globalState.registerController.pushText(args.registerName, "change", text, linewise: args.linewise, blockwise: ranges.count > 1)
    let actionArgs = ActionArgs()
    actionArgs.head = finalHead
    try actEnterInsertMode(cm, actionArgs, vim)
  }

  /// `operators.delete`.
  private func opDelete(_ cm: EditorAdapter, _ args: OperatorArgs, _ ranges: [VimRange]) throws -> Pos? {
    let vim = cm.vim!
    var finalHead: Pos
    let text: VimText
    if !vim.visualBlock {
      var anchor = ranges[0].anchor
      let head = ranges[0].head
      if args.linewise && head.line != cm.firstLine() && anchor.line == cm.lastLine() && anchor.line == head.line - 1 {
        // Special case for dd on last line (and first line).
        if anchor.line == cm.firstLine() {
          anchor.ch = 0
        } else {
          anchor = Pos(anchor.line - 1, lineLength(cm, anchor.line - 1))
        }
      }
      text = cm.getRange(anchor, head)
      try cm.replaceRange("", anchor, head)
      finalHead = anchor
      if args.linewise {
        finalHead = Pos(anchor.line, findFirstNonWhiteSpaceCharacter(cm.getLine(anchor.line)))
      }
    } else {
      text = cm.getSelection()
      cm.replaceSelections(Array(repeating: VimText(), count: ranges.count))
      finalHead = cursorMin(ranges[0].head, ranges[0].anchor)
    }
    globalState.registerController.pushText(args.registerName, "delete", text, linewise: args.linewise, blockwise: vim.visualBlock)
    return clipCursorToContent(cm, finalHead)
  }

  /// `operators.indent`.
  private func opIndent(_ cm: EditorAdapter, _ args: OperatorArgs, _ ranges: [VimRange]) throws -> Pos? {
    let vim = cm.vim!
    // In visual mode, n> shifts the selection right n times, instead of shifting n lines right
    // once.
    let count = vim.visualMode ? (args.repeat != 0 ? args.repeat : 1) : 1
    if vim.visualBlock {
      let tabSize = cm.tabSize
      let indent: VimText = cm.indentWithTabs ? "\t" : VimText(" ").repeating(tabSize)
      var cursor: Pos?
      for i in stride(from: ranges.count - 1, through: 0, by: -1) {
        let c = cursorMin(ranges[i].anchor, ranges[i].head)
        cursor = c
        if args.indentRight {
          try cm.replaceRange(indent.repeating(count), c, c)
        } else {
          let text = cm.getLine(c.line)
          var end = 0
          for _ in 0..<count {
            let ch = charAt(text, c.ch + end)
            if ch == 0x09 {
              end += 1
            } else if ch == 0x20 {
              end += 1
              for _ in 1..<max(1, indent.length) {
                if charAt(text, c.ch + end) != 0x20 { break }
                end += 1
              }
            } else {
              break
            }
          }
          try cm.replaceRange("", c, c.offsetting(0, end))
        }
      }
      return cursor
    }
    for _ in 0..<count {
      if args.indentRight { cm.indentMore() } else { cm.indentLess() }
    }
    return Pos(ranges[0].anchor.line, findFirstNonWhiteSpaceCharacter(cm.getLine(ranges[0].anchor.line)))
  }
}
