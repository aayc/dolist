// Ported from the commands of @replit/codemirror-vim 6.4.0 (`CodeMirror.commands`, `execCommand`,
// `indentLine`, `runHistoryCommand`) and the @codemirror/commands 6.11.1 / @codemirror/language
// 6.12.4 functions they call (`indentMore`, `indentLess`, `indentSelection`,
// `insertNewlineAndIndent`, `cursorLineBoundaryBackward`/`Forward`, `cursorCharLeft`,
// `toggleLineComment`), for a document without a language (MIT, © Marijn Haverbeke and others).

extension EditorAdapter {
  // MARK: execCommand

  /// `execCommand(name)`.
  func execCommand(_ name: String) {
    switch name {
    case "toggleLineComment": toggleLineComment()
    case "cursorCharLeft": cursorCharLeft()
    case "redo": runHistoryCommand(revert: false)
    case "undo": runHistoryCommand(revert: true)
    case "newlineAndIndent": newlineAndIndent()
    case "indentAuto": indentSelection()
    case "goLineLeft": cursorLineBoundary(forward: false)
    case "goLineRight":
      cursorLineBoundary(forward: true)
      let cur = selection.main.head
      if cur < docLength && sliceDoc(cur, cur + 1) != "\n" { cursorCharBackward() }
    default: break
    }
  }

  /// `runHistoryCommand(cm, revert)`: undo/redo, then the cursor goes to the start of the change.
  func runHistoryCommand(revert: Bool) {
    curOp?.changeStart = nil
    if !host.vimIsReadOnly, let transaction = revert ? host.vimUndo() : host.vimRedo() {
      hostDidApply(transaction)
    }
    if let start = curOp?.changeStart {
      dispatch(selection: .single(start))
    }
  }

  // MARK: Indentation

  /// `indentLine(line, more)`: the adapter indents the selected lines, whatever `line` is.
  func indentLine(_ line: Int, _ more: Bool) {
    if more { indentMore() } else { indentLess() }
  }

  /// `changeBySelectedLine(state, f)`.
  private func changeBySelectedLine(_ f: (Int, inout [ChangeSet.Spec], SelRange) -> Void) -> (
    ChangeSet, EditorSelection
  ) {
    var atLine = -1
    return changeByRange { range in
      var specs: [ChangeSet.Spec] = []
      var pos = range.from
      while pos <= range.to {
        let line = host.vimLineNumber(at: pos)
        if line > atLine && (range.isEmpty || range.to > host.vimLineStart(line)) {
          f(line, &specs, range)
          atLine = line
        }
        pos = lineEnd(line) + 1
      }
      let changeSet = (try? ChangeSet.of(specs, length: docLength)) ?? .empty(docLength)
      return (
        specs, .range(changeSet.map(range.anchor, assoc: 1), changeSet.map(range.head, assoc: 1))
      )
    }
  }

  func indentMore() {
    if host.vimIsReadOnly { return }
    let unit = VimText(host.vimIndentUnit)
    let (changes, sel) = changeBySelectedLine { line, specs, _ in
      specs.append(.init(from: host.vimLineStart(line), insert: unit))
    }
    dispatch(changes: changes, selection: sel, userEvent: "input.indent")
  }

  func indentLess() {
    if host.vimIsReadOnly { return }
    let (changes, sel) = changeBySelectedLine { line, specs, _ in
      let text = host.vimLine(line)
      let spaceLength = text.leadingWhitespaceCount()
      if spaceLength == 0 { return }
      let space = text.slice(0, spaceLength)
      let col = countColumn(space, tabSize: tabSize)
      let insert = indentString(max(0, col - indentUnitColumns))
      var keep = 0
      while keep < space.length && keep < insert.length && space[keep] == insert[keep] { keep += 1 }
      let from = host.vimLineStart(line)
      specs.append(.init(from: from + keep, to: from + space.length, insert: insert.slice(keep)))
    }
    dispatch(changes: changes, selection: sel, userEvent: "delete.dedent")
  }

  /// `getIndentUnit(state)`: the columns of one indentation unit.
  var indentUnitColumns: Int {
    let unit = VimText(host.vimIndentUnit)
    return unit.code(at: 0) == 9 ? tabSize * unit.length : unit.length
  }

  /// `indentString(state, cols)`.
  func indentString(_ columns: Int) -> VimText {
    var cols = columns
    var out: [UInt16] = []
    var ch = VimText(host.vimIndentUnit).code(at: 0) ?? 0x20
    if ch == 0x09 {
      while cols >= tabSize {
        out.append(0x09)
        cols -= tabSize
      }
      ch = 0x20
    }
    out.append(contentsOf: repeatElement(ch, count: max(0, cols)))
    return VimText(units: out)
  }

  /// `getIndentation(cx, pos)` without a language: 0 at the very start of the document (the top
  /// node's indentation), unknown elsewhere.
  private func languageIndentation(at pos: Int) -> Int? { pos == 0 ? 0 : nil }

  /// `indentSelection`.
  func indentSelection() {
    if host.vimIsReadOnly { return }
    let (changes, sel) = changeBySelectedLine { line, specs, range in
      let from = host.vimLineStart(line)
      guard var indent = languageIndentation(at: from) else { return }
      let text = host.vimLine(line)
      if !text.hasNonWhitespace { indent = 0 }
      let cur = text.slice(0, text.leadingWhitespaceCount())
      let norm = indentString(indent)
      if cur != norm || range.from < from + cur.length {
        specs.append(.init(from: from, to: from + cur.length, insert: norm))
      }
    }
    if !changes.isEmpty { dispatch(changes: changes, selection: sel, userEvent: "indent") }
  }

  // MARK: Newline

  /// `CodeMirror.commands.newlineAndIndent`: `insertNewlineAndIndent` through `dispatchChange`.
  func newlineAndIndent() {
    if host.vimIsReadOnly { return }
    let (changes, sel) = changeByRange { range in
      var from = range.from
      var to = range.to
      let line = host.vimLineNumber(at: from)
      let lineFrom = host.vimLineStart(line)
      let lineTo = lineEnd(line)
      let text = host.vimLine(line)
      let explode = from == to && isBetweenBrackets(from)
      let indent =
        languageIndentation(at: from)
        ?? countColumn(text.slice(0, text.leadingWhitespaceCount()), tabSize: tabSize)
      while to < lineTo && isJSWhitespace(text[to - lineFrom]) { to += 1 }
      if explode {
        from = range.from
        to = range.from
      } else if from > lineFrom && from < lineFrom + 100 && !text.slice(0, from).hasNonWhitespace {
        // CodeMirror slices the line with a document offset here.
        from = lineFrom
      }
      let indentText = indentString(indent)
      var insert = VimText("\n") + indentText
      if explode {
        // `cx.lineIndent(line.from, -1)` with the break simulated at the cursor.
        let before = text.slice(0, range.from - lineFrom)
        let firstNonBlank = before.firstNonWhitespace()
        let lineIndent =
          range.from == lineFrom
          ? 0
          : countColumn(
            before, tabSize: tabSize, to: firstNonBlank < 0 ? before.length : firstNonBlank)
        insert += VimText("\n") + indentString(lineIndent)
      }
      return ([.init(from: from, to: to, insert: insert)], .cursor(from + 1 + indentText.length))
    }
    dispatchChange(changes, selection: sel, userEvent: "input", scrollIntoView: true)
  }

  /// `isBetweenBrackets(state, pos)` without a syntax tree.
  private func isBetweenBrackets(_ pos: Int) -> Bool {
    let around = sliceDoc(pos - 1, pos + 1)
    return around == "()" || around == "[]" || around == "{}"
  }

  // MARK: Cursor motion commands

  /// `moveSel(view, how)`: dispatches only when the selection changes (assoc included).
  private func moveSel(_ how: (SelRange) -> SelRange) {
    let current = selection
    let moved = EditorSelection.create(current.ranges.map(how), mainIndex: current.mainIndex)
    if moved.eq(current, includeAssoc: true) { return }
    dispatch(selection: moved, userEvent: "select", scrollIntoView: true)
  }

  /// `cursorLineBoundaryBackward` / `cursorLineBoundaryForward` without line wrapping.
  func cursorLineBoundary(forward: Bool) {
    moveSel { start in
      let line = host.vimLineNumber(at: start.head)
      let from = host.vimLineStart(line)
      let to = lineEnd(line)
      var moved = SelRange.cursor(forward ? to : from, assoc: forward ? -1 : 1)
      if !forward && moved.head == from && to > from {
        let space = sliceDoc(from, min(from + 100, to)).leadingWhitespaceCount()
        if space > 0 && start.head != from + space { moved = .cursor(from + space) }
      }
      return moved
    }
  }

  /// `cursorCharLeft` (left-to-right text): one grapheme cluster back, or the previous line end.
  func cursorCharLeft() {
    moveSel { range in range.isEmpty ? moveByChar(range, forward: false) : .cursor(range.from) }
  }

  /// `cursorCharRight` (left-to-right text): one grapheme cluster on, or the next line start.
  func cursorCharRight() {
    moveSel { range in range.isEmpty ? moveByChar(range, forward: true) : .cursor(range.to) }
  }

  /// `cursorLineUp` / `cursorLineDown`: one line vertically, or to the line boundary on the
  /// first/last line.
  func cursorLine(forward: Bool) {
    moveSel { range in
      if !range.isEmpty { return .cursor(forward ? range.to : range.from) }
      let moved = moveVertically(range, forward: forward, distance: nil)
      if moved.head != range.head { return moved }
      let line = host.vimLineNumber(at: range.head)
      return .cursor(forward ? lineEnd(line) : host.vimLineStart(line), assoc: forward ? -1 : 1)
    }
  }

  func cursorCharBackward() {
    cursorCharLeft()
  }

  /// `view.moveByChar(start, forward)` for left-to-right text.
  private func moveByChar(_ start: SelRange, forward: Bool) -> SelRange {
    let line = host.vimLineNumber(at: start.head)
    let from = host.vimLineStart(line)
    let text = host.vimLine(line)
    let index = start.head - from
    if forward ? index < text.length : index > 0 {
      let next = ClusterBreak.find(text.units, index, forward: forward)
      return .cursor(from + next, assoc: forward ? -1 : 1)
    }
    if line == (forward ? host.vimLineCount - 1 : 0) { return start }
    // `visualLineSide`: the start of the next line or the end of the previous one.
    return forward ? .cursor(lineEnd(line) + 1, assoc: 1) : .cursor(from - 1, assoc: -1)
  }

  // MARK: Comments

  /// `toggleLineComment`: plain text has no comment syntax, so nothing happens.
  func toggleLineComment() {}

  // MARK: Brackets

  /// `findMatchingBracket(pos)`: the matching bracket of the one at `pos` (or right after it).
  func findMatchingBracket(_ pos: Pos) -> Pos? {
    let offset = indexFromPos(pos)
    if let end = matchPlainBrackets(offset + 1, dir: -1) { return posFromIndex(end) }
    if let end = matchPlainBrackets(offset, dir: 1) { return posFromIndex(end) }
    return nil
  }

  /// `matchPlainBrackets` of @codemirror/language: the start of the matching bracket (brackets of
  /// any kind nest together), nil when not at a bracket, unmatched or out of reach.
  private func matchPlainBrackets(_ pos: Int, dir: Int) -> Int? {
    let brackets = VimText("()[]{}")
    if dir < 0 ? pos == 0 : pos >= docLength { return nil }
    let startCh = dir < 0 ? sliceDoc(pos - 1, pos) : sliceDoc(pos, pos + 1)
    let bracket = startCh.isEmpty ? -1 : brackets.indexOf(startCh)
    if bracket < 0 || (bracket % 2 == 0) != (dir > 0) { return nil }
    var depth = 0
    var distance = 0
    let maxScanDistance = 10000
    // The document as CodeMirror iterates it from `pos`: line texts and line breaks.
    var line = host.vimLineNumber(at: pos)
    var chunkStart = pos
    var chunkEnd = dir > 0 ? lineEnd(line) : pos
    if dir < 0 { chunkStart = host.vimLineStart(line) }
    var isBreak = false
    while distance <= maxScanDistance {
      let text: VimText = isBreak ? "\n" : sliceDoc(chunkStart, chunkEnd)
      if !text.isEmpty || isBreak {
        if dir < 0 { distance += text.length }
        let basePos = dir > 0 ? pos + distance : pos - distance
        var i = dir > 0 ? 0 : text.length - 1
        while i != (dir > 0 ? text.length : -1) {
          let found = brackets.indexOf(unit: text[i])
          if found >= 0 {
            if (found % 2 == 0) == (dir > 0) {
              depth += 1
            } else if depth == 1 {
              return basePos + i
            } else {
              depth -= 1
            }
          }
          i += dir
        }
        if dir > 0 { distance += text.length }
      }
      // The next chunk.
      if dir > 0 {
        if isBreak {
          isBreak = false
          line += 1
          chunkStart = host.vimLineStart(line)
          chunkEnd = lineEnd(line)
        } else {
          if line + 1 >= host.vimLineCount { return nil }
          isBreak = true
        }
      } else {
        if isBreak {
          isBreak = false
          line -= 1
          chunkStart = host.vimLineStart(line)
          chunkEnd = lineEnd(line)
        } else {
          if line == 0 { return nil }
          isBreak = true
        }
      }
    }
    return nil
  }

  /// `scanForBracket(where, dir, style, config)` of the CodeMirror 6 adapter: the first unmatched
  /// bracket accepted by `bracketRegex` from `pos` in direction `dir` (nil when there is none).
  func scanForBracket(_ pos: Pos, _ dir: Int, bracketRegex: (UInt16) -> Bool) -> (
    pos: Pos, ch: UInt16
  )? {
    let matching: [UInt16: (UInt16, Bool)] = [
      0x28: (0x29, true), 0x29: (0x28, false), 0x5B: (0x5D, true), 0x5D: (0x5B, false),
      0x7B: (0x7D, true), 0x7D: (0x7B, false), 0x3C: (0x3E, true), 0x3E: (0x3C, false),
    ]
    let maxScanLen = 10000
    let maxScanLines = 1000
    var stack: [UInt16] = []
    let lineEndLimit =
      dir > 0
      ? min(pos.line + maxScanLines, lastLine() + 1) : max(firstLine() - 1, pos.line - maxScanLines)
    var lineNo = pos.line
    while lineNo != lineEndLimit {
      let line = getLine(lineNo)
      if !line.isEmpty && line.length <= maxScanLen {
        var p = dir > 0 ? 0 : line.length - 1
        let end = dir > 0 ? line.length : -1
        if lineNo == pos.line { p = pos.ch - (dir < 0 ? 1 : 0) }
        while p != end {
          if p >= 0 && p < line.length, bracketRegex(line[p]) {
            let ch = line[p]
            if let match = matching[ch], match.1 == (dir > 0) {
              stack.append(ch)
            } else if stack.isEmpty {
              return (Pos(lineNo, p), ch)
            } else {
              stack.removeLast()
            }
          }
          p += dir
          if (dir > 0 && p > end) || (dir < 0 && p < end) { break }
        }
      }
      lineNo += dir
    }
    return nil
  }
}
