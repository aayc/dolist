// Ported from the helper functions of vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn
// Haverbeke and others): cursor clipping and comparison, selection building (`makeCmSelection`,
// `selectBlock`, `selectForInsert`), visual mode exit, marks and character search.

/// `cursorIsBefore(cur1, cur2)`.
@inline(__always) func cursorIsBefore(_ a: Pos, _ b: Pos) -> Bool {
  a.line < b.line || (a.line == b.line && a.ch < b.ch)
}

func cursorMin(_ a: Pos, _ b: Pos) -> Pos { cursorIsBefore(a, b) ? a : b }
func cursorMax(_ a: Pos, _ b: Pos) -> Pos { cursorIsBefore(a, b) ? b : a }

/// `cursorMin(a, b, c, …)`: vim.js folds from the right.
func cursorMin(_ first: Pos, _ rest: Pos...) -> Pos {
  var result = rest.last!
  for p in rest.dropLast().reversed() { result = cursorMin(p, result) }
  return cursorMin(first, result)
}

/// `cursorIsBetween(cur1, cur2, cur3)`: cur2 strictly between cur1 and cur3.
func cursorIsBetween(_ a: Pos, _ b: Pos, _ c: Pos) -> Bool {
  cursorIsBefore(a, b) && cursorIsBefore(b, c)
}

enum SelectionMode {
  case char, line, block
}

extension Vim {
  func lineLength(_ cm: EditorAdapter, _ line: Int) -> Int { cm.getLine(line).length }

  /// `updateSelectionForSurrogateCharacters(cm, curStart, curEnd)`: widens a one-character range
  /// that starts on a high surrogate (vim.js tests 0xD800...0xD8FF only).
  func updateSelectionForSurrogateCharacters(_ cm: EditorAdapter, _ curStart: Pos, _ curEnd: Pos) -> (start: Pos, end: Pos) {
    var end = curEnd
    if curStart.line == curEnd.line && curStart.ch >= curEnd.ch - 1 {
      let text = cm.getLine(curStart.line)
      if let code = text.code(at: curStart.ch), code >= 0xD800 && code <= 0xD8FF { end.ch = chAdd(end.ch, 1) }
    }
    return (curStart, end)
  }

  /// `clipCursorToContent(cm, cur, oldCur)`: into the document, off the line break (except in
  /// insert and visual mode) and off low surrogates.
  func clipCursorToContent(_ cm: EditorAdapter, _ cur: Pos, _ oldCur: Pos? = nil) -> Pos {
    let vim = cm.vim
    let includeLineBreak = (vim?.insertMode ?? false) || (vim?.visualMode ?? false)
    let line = min(max(cm.firstLine(), cur.line), cm.lastLine())
    let text = cm.getLine(line)
    let maxCh = text.length - 1 + (includeLineBreak ? 1 : 0)
    var ch = min(max(0, cur.ch), maxCh)
    // prevent cursor from entering surrogate pair
    if let code = text.code(at: ch), code >= 0xDC00 && code <= 0xDFFF {
      var direction = 1
      if let oldCur, oldCur.line == line, oldCur.ch > ch { direction = -1 }
      ch += direction
      if ch > maxCh { ch -= 2 }
    }
    return Pos(line, ch)
  }

  /// `trim(s)`.
  func trim(_ s: VimText) -> VimText { s.trim() }

  /// `escapeRegex(s)`: `s.replace(/([.?*+$\[\]\/\\(){}|\-])/g, '\\$1')`.
  func escapeRegex(_ s: VimText) -> VimText {
    let special: Set<UInt16> = Set(".?*+$[]/\\(){}|-".utf16)
    var out: [UInt16] = []
    for u in s.units {
      if special.contains(u) { out.append(0x5C) }
      out.append(u)
    }
    return VimText(units: out)
  }

  /// `extendLineToColumn(cm, lineNum, column)`: pads the line with spaces.
  func extendLineToColumn(_ cm: EditorAdapter, _ lineNum: Int, _ column: Int) throws {
    let endCh = lineLength(cm, lineNum)
    let spaces = VimText(" ").repeating(max(0, column - endCh))
    cm.setCursor(Pos(lineNum, endCh))
    try cm.replaceRange(spaces, cm.getCursor())
  }

  /// `selectBlock(cm, selectionEnd)`: a rectangular selection with `selectionEnd` as a corner.
  @discardableResult
  func selectBlock(_ cm: EditorAdapter, _ selectionEnd: inout Pos) -> Pos {
    var selections: [VimRange] = []
    let ranges = cm.listSelections()
    let head = cm.clipPos(selectionEnd)
    let isClipped = selectionEnd != head
    let curHead = cm.getCursor(.head)
    let primIndex = getIndex(ranges, curHead)
    let wasClipped = primIndex >= 0 ? ranges[primIndex].head == ranges[primIndex].anchor : false
    let max = ranges.count - 1
    let index = max - primIndex > primIndex ? max : 0
    var base = ranges[index].anchor
    let firstLine = min(base.line, head.line)
    let lastLine = Swift.max(base.line, head.line)
    var baseCh = base.ch, headCh = head.ch
    let dir = ranges[index].head.ch - baseCh
    let newDir = headCh - baseCh
    if dir > 0 && newDir <= 0 {
      baseCh += 1
      if !isClipped { headCh -= 1 }
    } else if dir < 0 && newDir >= 0 {
      baseCh -= 1
      if !wasClipped { headCh += 1 }
    } else if dir < 0 && newDir == -1 {
      baseCh -= 1
      headCh += 1
    }
    for line in firstLine...lastLine {
      selections.append(VimRange(anchor: Pos(line, baseCh), head: Pos(line, headCh)))
    }
    cm.setSelections(selections)
    selectionEnd.ch = headCh
    base.ch = baseCh
    return base
  }

  /// `selectForInsert(cm, head, height)`: a cursor on each of `height` lines from `head`.
  func selectForInsert(_ cm: EditorAdapter, _ head: Pos, _ height: Int) {
    var sel: [VimRange] = []
    for i in 0..<max(0, height) {
      let lineHead = head.offsetting(i, 0)
      sel.append(VimRange(anchor: lineHead, head: lineHead))
    }
    if sel.isEmpty { return }
    cm.setSelections(sel, 0)
  }

  /// `getIndex(ranges, cursor, end)`.
  func getIndex(_ ranges: [VimRange], _ cursor: Pos, _ end: String? = nil) -> Int {
    for (i, range) in ranges.enumerated() {
      let atAnchor = end != "head" && range.anchor == cursor
      let atHead = end != "anchor" && range.head == cursor
      if atAnchor || atHead { return i }
    }
    return -1
  }

  /// `getSelectedAreaRange(cm, vim)`.
  func getSelectedAreaRange(_ cm: EditorAdapter, _ vim: VimState) -> (Pos, Pos) {
    let selections = cm.listSelections()
    let start = selections[0]
    let end = selections[selections.count - 1]
    let selectionStart = cursorIsBefore(start.anchor, start.head) ? start.anchor : start.head
    let selectionEnd = cursorIsBefore(end.anchor, end.head) ? end.head : end.anchor
    return (selectionStart, selectionEnd)
  }

  /// `updateLastSelection(cm, vim)`: remembers the visual selection for `gv`.
  func updateLastSelection(_ cm: EditorAdapter, _ vim: VimState) throws {
    let anchor = vim.sel.anchor
    var head = vim.sel.head
    // To accommodate the effect of lastPastedText in the last selection
    if let pasted = vim.lastPastedText {
      head = try cm.posFromIndexChecked(cm.indexFromPos(anchor) + pasted.length)
      vim.lastPastedText = nil
    }
    vim.lastSelection = LastSelection(
      anchorMark: cm.setBookmark(anchor), headMark: cm.setBookmark(head), anchor: anchor, head: head,
      visualMode: vim.visualMode, visualLine: vim.visualLine, visualBlock: vim.visualBlock)
  }

  /// `expandSelection(cm, start, end, move)`: grows the visual selection over a text object.
  func expandSelection(_ cm: EditorAdapter, _ startIn: Pos, _ endIn: Pos, _ move: Bool) -> (Pos, Pos) {
    let sel = cm.vim!.sel
    var head = move ? startIn : sel.head
    var anchor = move ? startIn : sel.anchor
    var start = startIn, end = endIn
    if cursorIsBefore(end, start) { swap(&start, &end) }
    if cursorIsBefore(head, anchor) {
      head = cursorMin(start, head)
      anchor = cursorMax(anchor, end)
    } else {
      anchor = cursorMin(start, anchor)
      head = cursorMax(head, end)
      head = head.offsetting(0, -1)
      if head.ch == -1 && head.line != cm.firstLine() {
        head = Pos(head.line - 1, lineLength(cm, head.line - 1))
      }
    }
    return (anchor, head)
  }

  /// `updateCmSelection(cm, sel, mode)`: shows the vim selection in the editor.
  func updateCmSelection(_ cm: EditorAdapter, _ selIn: VimRange? = nil, _ modeIn: SelectionMode? = nil) {
    guard let vim = cm.vim else { return }
    let sel = selIn ?? vim.sel
    let mode = modeIn ?? (vim.visualLine ? .line : vim.visualBlock ? .block : .char)
    let cmSel = makeCmSelection(cm, sel, mode)
    cm.setSelections(cmSel.ranges, cmSel.primary)
  }

  /// `makeCmSelection(cm, sel, mode, exclusive)`: CodeMirror ranges for a vim selection.
  func makeCmSelection(_ cm: EditorAdapter, _ sel: VimRange, _ mode: SelectionMode, exclusive: Bool = false) -> (ranges: [VimRange], primary: Int) {
    var head = sel.head
    var anchor = sel.anchor
    switch mode {
    case .char:
      let headOffset = !exclusive && !cursorIsBefore(sel.head, sel.anchor) ? 1 : 0
      let anchorOffset = cursorIsBefore(sel.head, sel.anchor) ? 1 : 0
      head = sel.head.offsetting(0, headOffset)
      anchor = sel.anchor.offsetting(0, anchorOffset)
      return ([VimRange(anchor: anchor, head: head)], 0)
    case .line:
      if !cursorIsBefore(sel.head, sel.anchor) {
        anchor.ch = 0
        let lastLine = cm.lastLine()
        if head.line > lastLine { head.line = lastLine }
        head.ch = lineLength(cm, head.line)
      } else {
        head.ch = 0
        anchor.ch = lineLength(cm, anchor.line)
      }
      return ([VimRange(anchor: anchor, head: head)], 0)
    case .block:
      let top = min(anchor.line, head.line)
      var fromCh = anchor.ch
      let bottom = max(anchor.line, head.line)
      var toCh = head.ch
      if fromCh < toCh { toCh = chAdd(toCh, 1) } else { fromCh = chAdd(fromCh, 1) }
      let height = bottom - top + 1
      let primary = head.line == top ? 0 : height - 1
      var ranges: [VimRange] = []
      for i in 0..<height {
        ranges.append(VimRange(anchor: Pos(top + i, fromCh), head: Pos(top + i, toCh)))
      }
      return (ranges, primary)
    }
  }

  /// `getHead(cm)`: with one character selected, the "real" head is its left end.
  func getHead(_ cm: EditorAdapter) -> Pos {
    var cur = cm.getCursor(.head)
    if cm.getSelection().length == 1 { cur = cursorMin(cur, cm.getCursor(.anchor)) }
    return cur
  }

  /// `exitVisualMode(cm, moveHead)`.
  func exitVisualMode(_ cm: EditorAdapter, moveHead: Bool = true) throws {
    guard let vim = cm.vim else { return }
    if moveHead { cm.setCursor(clipCursorToContent(cm, vim.sel.head)) }
    try updateLastSelection(cm, vim)
    vim.visualMode = false
    vim.visualLine = false
    vim.visualBlock = false
    if !vim.insertMode { cm.signal(.vimModeChange, .modeChange(mode: "normal", subMode: nil)) }
  }

  /// `clipToLine(cm, curStart, curEnd)`: drops trailing line breaks (and whitespace) of a forward
  /// motion's range, so `dw` at the end of a line keeps the line break.
  func clipToLine(_ cm: EditorAdapter, _ curStart: Pos, _ curEnd: inout Pos) {
    let selection = cm.getRange(curStart, curEnd)
    // Only clip if the selection ends with trailing newline + whitespace: /\n\s*$/
    guard let lastNewline = selection.units.lastIndex(of: 0x0A),
      selection.units[(lastNewline + 1)...].allSatisfy(isJSWhitespace)
    else { return }
    var lines = selection.split(unit: 0x0A)
    // We know this is all whitespace.
    lines.removeLast()
    // Find the line containing the last word, and clip all whitespace up to it.
    var line = lines.popLast()
    while !lines.isEmpty, let l = line, !l.isEmpty, VimText.isWhiteSpaceString(l) {
      curEnd.line -= 1
      curEnd.ch = 0
      line = lines.popLast()
    }
    // If the last word is not an empty line, clip an additional newline
    if let l = line, !l.isEmpty {
      curEnd.line -= 1
      curEnd.ch = lineLength(cm, curEnd.line)
    } else {
      curEnd.ch = 0
    }
  }

  /// `expandSelectionToLine(cm, curStart, curEnd)`.
  func expandSelectionToLine(_ cm: EditorAdapter, _ curStart: inout Pos, _ curEnd: inout Pos) {
    curStart.ch = 0
    curEnd.ch = 0
    curEnd.line += 1
  }

  /// `findFirstNonWhiteSpaceCharacter(text)`.
  func findFirstNonWhiteSpaceCharacter(_ text: VimText?) -> Int {
    guard let text, !text.isEmpty else { return 0 }
    let first = text.firstNonWhitespace()
    return first == -1 ? text.length : first
  }

  /// `recordJumpPosition(cm, oldCur, newCur)`.
  func recordJumpPosition(_ cm: EditorAdapter, _ oldCur: Pos, _ newCur: Pos) {
    if oldCur != newCur { globalState.jumpList.add(cm, oldCur, newCur) }
  }

  /// `recordLastCharacterSearch(increment, args)`.
  func recordLastCharacterSearch(_ increment: Int, _ args: MotionArgs) {
    globalState.lastCharacterSearch = (increment, args.forward, args.selectedCharacter ?? VimText())
  }

  /// `updateMark(cm, vim, markName, pos)`.
  func updateMark(_ cm: EditorAdapter, _ vim: VimState, _ markName: String, _ pos: Pos) {
    if !validMarks.contains(markName) && !VimText(markName).isLatinChar { return }
    vim.marks[markName]?.clear()
    vim.marks[markName] = cm.setBookmark(pos)
  }

  /// `charIdxInLine(start, line, character, forward, includeChar)`.
  func charIdxInLine(_ start: Int, _ line: VimText, _ character: VimText, _ forward: Bool, _ includeChar: Bool) -> Int {
    var idx: Int
    if forward {
      idx = line.indexOf(character, start + 1)
      if idx != -1 && !includeChar { idx -= 1 }
    } else {
      idx = line.lastIndexOf(character, start - 1)
      if idx != -1 && !includeChar { idx += 1 }
    }
    return idx
  }

  /// `moveToCharacter(cm, repeat, forward, character, head)`.
  func moveToCharacter(_ cm: EditorAdapter, _ count: Int, _ forward: Bool, _ character: VimText?, _ head: Pos?) -> Pos? {
    guard let character, !character.isEmpty else { return nil }
    let cur = head ?? cm.getCursor()
    var start = cur.ch
    var idx: Int?
    for _ in 0..<max(0, count) {
      let line = cm.getLine(cur.line)
      let found = charIdxInLine(start, line, character, forward, true)
      if found == -1 { return nil }
      idx = found
      start = found
    }
    if let idx { return Pos(cm.getCursor().line, idx) }
    return nil
  }

  /// `moveToColumn(cm, repeat)`.
  func moveToColumn(_ cm: EditorAdapter, _ count: Int) -> Pos {
    let line = cm.getCursor().line
    return clipCursorToContent(cm, Pos(line, count - 1))
  }

  /// `moveToEol(cm, head, motionArgs, vim, keepHPos)`.
  func moveToEol(_ cm: EditorAdapter, _ head: Pos, _ motionArgs: MotionArgs, _ vim: VimState, _ keepHPos: Bool) -> Pos {
    let retval = Pos(head.line + motionArgs.repeat - 1, Pos.endOfLine)
    var end = cm.clipPos(retval)
    end.ch -= 1
    if !keepHPos {
      vim.lastHPos = Pos.endOfLine
      vim.lastHSPos = cm.charCoords(end).left
    }
    return retval
  }

  /// `getUserVisibleLines(cm)`.
  func getUserVisibleLines(_ cm: EditorAdapter) -> (top: Int, bottom: Int) {
    let scrollInfo = cm.getScrollInfo()
    let occludeToleranceTop = 6.0
    let occludeToleranceBottom = 10.0
    let from = cm.coordsChar(left: 0, top: occludeToleranceTop + scrollInfo.top)
    let bottomY = scrollInfo.clientHeight - occludeToleranceBottom + scrollInfo.top
    let to = cm.coordsChar(left: 0, top: bottomY)
    return (from.line, to.line)
  }

  /// `getMarkPos(cm, vim, markName)`.
  func getMarkPos(_ cm: EditorAdapter, _ vim: VimState, _ markName: String) -> Pos? {
    if markName == "'" || markName == "`" {
      return globalState.jumpList.find(cm, -1) ?? Pos(0, 0)
    } else if markName == "." {
      return getLastEditPos(cm)
    }
    return vim.marks[markName]?.find()
  }

  /// `getLastEditPos(cm)`.
  func getLastEditPos(_ cm: EditorAdapter) -> Pos? {
    cm.getLastEditEnd()
  }

  /// `isInRange(pos, start, end)`.
  func isInRange(_ line: Int, _ start: Int, _ end: Int?) -> Bool {
    if let end { return line >= start && line <= end }
    return line == start
  }
}
