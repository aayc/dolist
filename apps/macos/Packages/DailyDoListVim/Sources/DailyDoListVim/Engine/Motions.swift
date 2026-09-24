// Ported from `motions` of vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke
// and others). Every motion returns the new head (or an [anchor, head] pair), or nil to do
// nothing.

extension Vim {
  func registerMotions() {
    func define(_ name: String, _ fn: @escaping MotionFn) { motions[name] = fn }
    define("moveToTopLine") { [unowned self] cm, _, args, _, _ throws in
      let line = self.getUserVisibleLines(cm).top + args.repeat - 1
      return .pos(Pos(line, self.findFirstNonWhiteSpaceCharacter(cm.getLine(line))))
    }
    define("moveToMiddleLine") { [unowned self] cm, _, _, _, _ throws in
      let range = self.getUserVisibleLines(cm)
      let line = Int((Double(range.top + range.bottom) * 0.5).rounded(.down))
      return .pos(Pos(line, self.findFirstNonWhiteSpaceCharacter(cm.getLine(line))))
    }
    define("moveToBottomLine") { [unowned self] cm, _, args, _, _ throws in
      let line = self.getUserVisibleLines(cm).bottom - args.repeat + 1
      return .pos(Pos(line, self.findFirstNonWhiteSpaceCharacter(cm.getLine(line))))
    }
    define("expandToLine") { _, head, args, _, _ throws in
      // Expands forward to end of line, and then to next line if repeat is >1. Does not handle
      // backward motion!
      .pos(Pos(head.line + args.repeat - 1, Pos.endOfLine))
    }
    define("findNext") { [unowned self] cm, _, args, _, _ throws in
      guard let query = self.globalState.query else { return nil }
      var prev = !args.forward
      // If search is initiated with ? instead of /, negate direction.
      prev = self.globalState.isReversed ? !prev : prev
      self.highlightSearchMatches(cm, query)
      let result = try self.findNext(cm, prev, query, args.repeat)
      if result == nil {
        self.showConfirm(cm, "No match found " + query.description + (self.pcre ? " (set nopcre to use Vim regexps)" : ""))
      }
      return result.map { .pos($0) }
    }
    define("findAndSelectNextInclusive") { [unowned self] cm, _, args, vim, prevInputState throws in
      try self.findAndSelectNextInclusive(cm, args, vim, prevInputState)
    }
    define("goToMark") { [unowned self] cm, _, args, vim, _ throws in
      guard let pos = self.getMarkPos(cm, vim, args.selectedCharacter?.string ?? "") else { return nil }
      return .pos(args.linewise ? Pos(pos.line, self.findFirstNonWhiteSpaceCharacter(cm.getLine(pos.line))) : pos)
    }
    define("moveToOtherHighlightedEnd") { [unowned self] cm, _, args, vim, _ throws in
      let sel = vim.sel
      if vim.visualBlock && args.sameLine {
        return .range(
          self.clipCursorToContent(cm, Pos(sel.anchor.line, sel.head.ch)),
          self.clipCursorToContent(cm, Pos(sel.head.line, sel.anchor.ch)))
      }
      return .range(sel.head, sel.anchor)
    }
    define("jumpToMark") { [unowned self] cm, head, args, vim, _ throws in
      var best = head
      for _ in 0..<max(0, args.repeat) {
        let cursor = best
        for key in vim.marks.keys where VimText(key).isLowerCaseLetter {
          // vim.js reads `mark.line` of a mark deleted by edits.
          guard let mark = vim.marks[key]?.find() else { throw JSException.typeError("Cannot read properties of null (reading 'line')") }
          let isWrongDirection = args.forward ? cursorIsBefore(mark, cursor) : cursorIsBefore(cursor, mark)
          if isWrongDirection { continue }
          if args.linewise && mark.line == cursor.line { continue }
          let equal = cursor == best
          let between = args.forward ? cursorIsBetween(cursor, mark, best) : cursorIsBetween(best, mark, cursor)
          if equal || between { best = mark }
        }
      }
      if args.linewise {
        // Vim places the cursor on the first non-whitespace character of the line if there is
        // one, else it places the cursor at the end of the line, regardless of whether a mark was
        // found.
        best = Pos(best.line, self.findFirstNonWhiteSpaceCharacter(cm.getLine(best.line)))
      }
      return .pos(best)
    }
    define("moveByCharacters") { _, head, args, _, _ throws in
      let ch = args.forward ? chAdd(head.ch, args.repeat) : (head.ch == Pos.endOfLine ? head.ch : head.ch - args.repeat)
      return .pos(Pos(head.line, ch))
    }
    define("moveByLines") { [unowned self] cm, head, args, vim, input throws in
      try self.moveByLines(cm, head, args, vim, input)
    }
    define("moveByDisplayLines") { [unowned self] cm, head, args, vim, _ throws in
      .pos(self.moveByDisplayLines(cm, head, args, vim))
    }
    define("moveByPage") { cm, head, args, _, _ throws in
      // CodeMirror only exposes functions that move the cursor page down, so doing this bad hack
      // to move the cursor and move it back. evalInput will move the cursor to where it should
      // be in the end.
      .pos(cm.findPosV(head, Double(args.forward ? args.repeat : -args.repeat), page: true, goalColumn: nil).pos)
    }
    define("moveByParagraph") { [unowned self] cm, head, args, _, _ throws in
      .pos(self.findParagraph(cm, head, args.repeat, args.forward ? 1 : -1).start)
    }
    define("moveBySentence") { [unowned self] cm, head, args, _, _ throws in
      .pos(self.findSentence(cm, head, args.repeat, args.forward ? 1 : -1))
    }
    define("moveByScroll") { [unowned self] cm, head, args, vim, _ throws in
      let scrollbox = cm.getScrollInfo()
      var count = args.repeat
      if count == 0 {
        count = Int(JSNumber.round(scrollbox.clientHeight / (2 * cm.defaultTextHeight())))
      }
      let orig = cm.charCoords(head)
      args.repeat = count
      let curEnd = self.moveByDisplayLines(cm, head, args, vim)
      let dest = cm.charCoords(curEnd)
      cm.scrollTo(nil, scrollbox.top + dest.top - orig.top)
      return .pos(curEnd)
    }
    define("moveByWords") { [unowned self] cm, head, args, _, _ throws in
      self.moveToWord(cm, head, args.repeat, args.forward, args.wordEnd, args.bigWord).map { .pos($0) }
    }
    define("moveTillCharacter") { [unowned self] cm, head, args, _, _ throws in
      let curEnd = self.moveToCharacter(cm, args.repeat, args.forward, args.selectedCharacter, head)
      let increment = args.forward ? -1 : 1
      self.recordLastCharacterSearch(increment, args)
      guard var end = curEnd else { return nil }
      end.ch += increment
      return .pos(end)
    }
    define("moveToCharacter") { [unowned self] cm, head, args, _, _ throws in
      self.recordLastCharacterSearch(0, args)
      return .pos(self.moveToCharacter(cm, args.repeat, args.forward, args.selectedCharacter, head) ?? head)
    }
    define("moveToSymbol") { [unowned self] cm, head, args, _, _ throws in
      guard let character = args.selectedCharacter, !character.isEmpty else { return .pos(head) }
      return .pos(self.findSymbol(cm, args.repeat, args.forward, character))
    }
    define("moveToColumn") { [unowned self] cm, head, args, vim, _ throws in
      // repeat is equivalent to which column we want to move to!
      vim.lastHPos = args.repeat - 1
      vim.lastHSPos = cm.charCoords(head).left
      return .pos(self.moveToColumn(cm, args.repeat))
    }
    define("moveToEol") { [unowned self] cm, head, args, vim, _ throws in
      .pos(self.moveToEol(cm, head, args, vim, false))
    }
    define("moveToFirstNonWhiteSpaceCharacter") { [unowned self] cm, head, _, _, _ throws in
      // Go to the start of the line where the text begins, or the end for whitespace-only lines
      .pos(Pos(head.line, self.findFirstNonWhiteSpaceCharacter(cm.getLine(head.line))))
    }
    define("moveToMatchedSymbol") { cm, head, _, _, _ throws in
      let line = head.line
      var ch = head.ch
      let lineText = cm.getLine(line)
      var symbol: UInt16?
      while ch < lineText.length {
        symbol = lineText[ch]
        if let s = symbol, VimText(unit: s).isMatchableSymbol {
          let style = cm.getTokenTypeAt(Pos(line, ch + 1))
          if style != "string" && style != "comment" { break }
        }
        ch += 1
      }
      if ch < lineText.length {
        // Only include angle brackets in analysis if they are being matched (the adapter
        // ignores the option and matches ()[]{} only).
        return cm.findMatchingBracket(Pos(line, ch)).map { .pos($0) }
      }
      return .pos(head)
    }
    define("moveToStartOfLine") { _, head, _, _, _ throws in
      .pos(Pos(head.line, 0))
    }
    define("moveToLineOrEdgeOfDocument") { [unowned self] cm, _, args, _, _ throws in
      var lineNum = args.forward ? cm.lastLine() : cm.firstLine()
      if args.repeatIsExplicit {
        lineNum = args.repeat - (cm.getOption("firstLineNumber")?.intValue ?? 1)
      }
      return .pos(Pos(lineNum, self.findFirstNonWhiteSpaceCharacter(cm.getLine(lineNum))))
    }
    define("moveToStartOfDisplayLine") { cm, _, _, _, _ throws in
      cm.execCommand("goLineLeft")
      return .pos(cm.getCursor())
    }
    define("moveToEndOfDisplayLine") { cm, _, _, _, _ throws in
      cm.execCommand("goLineRight")
      return .pos(cm.getCursor())
    }
    define("textObjectManipulation") { [unowned self] cm, head, args, vim, _ throws in
      try self.textObjectManipulation(cm, head, args, vim)
    }
    define("repeatLastCharacterSearch") { [unowned self] cm, head, args, _, _ throws in
      let lastSearch = self.globalState.lastCharacterSearch
      let forward = args.forward == lastSearch.forward
      let increment = (lastSearch.increment != 0 ? 1 : 0) * (forward ? -1 : 1)
      args.inclusive = forward
      guard var curEnd = self.moveToCharacter(cm, args.repeat, forward, lastSearch.selectedCharacter, head.offsetting(0, -increment)) else {
        return .pos(head)
      }
      curEnd.ch += increment
      return .pos(curEnd)
    }
  }

  /// `motions.moveByLines`.
  private func moveByLines(_ cm: EditorAdapter, _ head: Pos, _ args: MotionArgs, _ vim: VimState, _ input: InputState) throws -> MotionResult? {
    let cur = head
    var endCh = cur.ch
    // Depending what our last motion was, we may want to do different things. If our last motion
    // was moving vertically, we want to preserve the HPos from our last horizontal move. If our
    // last motion was going to the end of a line, moving vertically we should go to the end of
    // the line, etc.
    switch vim.lastMotion {
    case "moveByLines", "moveByDisplayLines", "moveByScroll", "moveToColumn", "moveToEol":
      endCh = vim.lastHPos
    default:
      vim.lastHPos = endCh
    }
    let count = args.repeat + args.repeatOffset
    var line = args.forward ? cur.line + count : cur.line - count
    let first = cm.firstLine()
    let last = cm.lastLine()
    let posV = cm.findPosV(cur, Double(args.forward ? count : -count), page: false, goalColumn: vim.lastHSPos)
    let hasMarkedText = args.forward ? posV.pos.line > line : posV.pos.line < line
    if hasMarkedText {
      line = posV.pos.line
      endCh = posV.pos.ch
    }
    // Vim go to line begin or line end when cursor at first/last line and move to previous/next
    // line is triggered.
    if line < first && cur.line == first {
      return try motions["moveToStartOfLine"]!(cm, head, args, vim, input)
    } else if line > last && cur.line == last {
      return .pos(moveToEol(cm, head, args, vim, true))
    }
    if args.toFirstChar {
      endCh = findFirstNonWhiteSpaceCharacter(cm.getLine(line))
      vim.lastHPos = endCh
    }
    vim.lastHSPos = cm.charCoords(Pos(line, endCh)).left
    return .pos(Pos(line, endCh))
  }

  /// `motions.moveByDisplayLines`.
  func moveByDisplayLines(_ cm: EditorAdapter, _ head: Pos, _ args: MotionArgs, _ vim: VimState) -> Pos {
    var cur = head
    switch vim.lastMotion {
    case "moveByDisplayLines", "moveByScroll", "moveByLines", "moveToColumn", "moveToEol":
      break
    default:
      vim.lastHSPos = cm.charCoords(cur).left
    }
    let count = args.repeat
    var moved = false
    for _ in 0..<max(0, count) {
      let res = cm.findPosV(cur, args.forward ? 1 : -1, page: false, goalColumn: vim.lastHSPos)
      if res.hitSide { break }
      cur = res.pos
      moved = true
    }
    if moved { vim.lastHPos = cur.ch }
    return cur
  }

  /// `motions.textObjectManipulation`.
  private func textObjectManipulation(_ cm: EditorAdapter, _ headIn: Pos, _ args: MotionArgs, _ vim: VimState) throws -> MotionResult? {
    var head = headIn
    let mirroredPairs: Set<String> = ["(", ")", "{", "}", "[", "]", "<", ">"]
    let selfPaired: Set<String> = ["'", "\"", "`"]
    var character = args.selectedCharacter ?? VimText()
    // 'b' refers to '()' block. 'B' refers to '{}' block.
    if character == "b" {
      character = "("
    } else if character == "B" {
      character = "{"
    }
    // Inclusive is the difference between a and i
    let inclusive = !args.textObjectInner
    var tmp: (start: Pos, end: Pos)?
    var move = false
    if mirroredPairs.contains(character.string) {
      move = true
      tmp = selectCompanionObject(cm, head, character, inclusive)
      if tmp == nil {
        let sc = cm.getSearchCursor(try JSRegExp.make(VimText("\\") + character, "g"), head)
        if try sc.find(false) != nil, let from = sc.from() {
          tmp = selectCompanionObject(cm, from, character, inclusive)
        }
      }
    } else if selfPaired.contains(character.string) {
      move = true
      tmp = findBeginningAndEnd(cm, head, character[0], inclusive)
    } else if character == "W" || character == "w" {
      var count = args.repeat != 0 ? args.repeat : 1
      while count > 0 {
        count -= 1
        let options = WordOptions(inclusive: inclusive, innerWord: !inclusive, bigWord: character == "W", noSymbol: character == "W", multiline: true)
        if let repeated = expandWordUnderCursor(cm, options, tmp?.end) {
          if tmp == nil { tmp = repeated }
          tmp!.end = repeated.end
        }
      }
    } else if character == "p" {
      var paragraph = findParagraph(cm, head, args.repeat, 0, inclusive)
      args.linewise = true
      if vim.visualMode {
        if !vim.visualLine { vim.visualLine = true }
      } else {
        vim.inputState.operatorArgs?.linewise = true
        paragraph.end.line -= 1
      }
      tmp = paragraph
    } else if character == "t" {
      tmp = expandTagUnderCursor(cm, head, inclusive)
    } else if character == "s" {
      // account for cursor on end of sentence symbol
      let content = cm.getLine(head.line)
      if head.ch > 0 && VimText.isEndOfSentenceSymbol(content.at(head.ch)) { head.ch -= 1 }
      let end = getSentence(cm, head, args.repeat, 1, inclusive)
      var start = getSentence(cm, head, args.repeat, -1, inclusive)
      // closer vim behaviour, 'a' only takes the space after the sentence if there is one before
      // and after
      if VimText.isWhiteSpaceString(cm.getLine(start.line).at(start.ch))
        && VimText.isWhiteSpaceString(cm.getLine(end.line).at(end.ch - 1))
      {
        start = Pos(start.line, start.ch + 1)
      }
      tmp = (start, end)
    }
    guard let range = tmp else {
      // No valid text object, don't move.
      return nil
    }
    if !(cm.vim?.visualMode ?? false) {
      return .range(range.start, range.end)
    }
    let (anchor, newHead) = expandSelection(cm, range.start, range.end, move)
    return .range(anchor, newHead)
  }
}
