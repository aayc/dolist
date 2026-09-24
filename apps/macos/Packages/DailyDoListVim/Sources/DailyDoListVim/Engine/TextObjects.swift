// Ported from vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// `selectCompanionObject`, `findBeginningAndEnd`, `findParagraph`, `getSentence`, `findSentence`,
// `expandTagUnderCursor` and `findSymbol` (with `symbolToMode` / `findSymbolModes`).

extension Vim {
  /// `selectCompanionObject(cm, head, symb, inclusive)`: the bracket pair around `head`.
  func selectCompanionObject(_ cm: EditorAdapter, _ head: Pos, _ symb: VimText, _ inclusive: Bool) -> (start: Pos, end: Pos)? {
    let cur = head
    let pairs: [String: (open: UInt16, close: UInt16)] = [
      "(": (0x28, 0x29), ")": (0x28, 0x29), "[": (0x5B, 0x5D), "]": (0x5B, 0x5D),
      "{": (0x7B, 0x7D), "}": (0x7B, 0x7D), "<": (0x3C, 0x3E), ">": (0x3C, 0x3E),
    ]
    guard let pair = pairs[symb.string] else { return nil }
    let bracketRegex: (UInt16) -> Bool = { $0 == pair.open || $0 == pair.close }
    let curChar = charAt(cm.getLine(cur.line), cur.ch)
    // Due to the behavior of scanForBracket, we need to add an offset if the cursor is on a
    // matching open bracket.
    let offset = curChar == pair.open ? 1 : 0
    let startBracket = cm.scanForBracket(Pos(cur.line, cur.ch + offset), -1, bracketRegex: bracketRegex)
    let endBracket = cm.scanForBracket(Pos(cur.line, cur.ch + offset), 1, bracketRegex: bracketRegex)
    guard var start = startBracket?.pos, var end = endBracket?.pos else { return nil }
    if (start.line == end.line && start.ch > end.ch) || start.line > end.line { swap(&start, &end) }
    if inclusive { end.ch += 1 } else { start.ch += 1 }
    return (start, end)
  }

  /// `findBeginningAndEnd(cm, head, symb, inclusive)`: quotes around the cursor on its line.
  func findBeginningAndEnd(_ cm: EditorAdapter, _ head: Pos, _ symb: UInt16, _ inclusive: Bool) -> (start: Pos, end: Pos) {
    var cur = head
    let chars = cm.getLine(cur.line).units
    var start: Int?
    var end: Int?
    let firstIndex = chars.firstIndex(of: symb) ?? -1
    func at(_ i: Int) -> UInt16? { i >= 0 && i < chars.count ? chars[i] : nil }
    // the decision tree is to always look backwards for the beginning first, but if the cursor is
    // in front of the first instance of the symb, then move the cursor forward
    if cur.ch < firstIndex {
      cur.ch = firstIndex
    } else if firstIndex < cur.ch && at(cur.ch) == symb {
      // otherwise if the cursor is currently on the closing symbol (no strings in plain text)
      end = cur.ch
      cur.ch -= 1
    }
    // if we're currently on the symbol, we've got a start
    if at(cur.ch) == symb && (end == nil || end == 0) {
      start = cur.ch + 1
    } else {
      // go backwards to find the start
      var i = cur.ch
      while i > -1 && (start == nil || start == 0) {
        if at(i) == symb { start = i + 1 }
        i -= 1
      }
    }
    // look forwards for the end symbol
    if let s = start, s != 0, end == nil || end == 0 {
      var i = s
      while i < chars.count && (end == nil || end == 0) {
        if chars[i] == symb { end = i }
        i += 1
      }
    }
    // nothing found
    guard var s = start, s != 0, var e = end, e != 0 else { return (cur, cur) }
    // include the symbols
    if inclusive {
      s -= 1
      e += 1
    }
    return (Pos(cur.line, s), Pos(cur.line, e))
  }

  /// `findParagraph(cm, head, repeat, dir, inclusive)`.
  func findParagraph(_ cm: EditorAdapter, _ head: Pos, _ repeatIn: Int, _ dir: Int, _ inclusiveIn: Bool = false) -> (start: Pos, end: Pos) {
    var line = head.line
    let min = cm.firstLine()
    let max = cm.lastLine()
    var count = repeatIn
    var inclusive = inclusiveIn
    var i = line
    func isEmpty(_ i: Int) -> Bool { cm.getLine(i).isEmpty }
    func isBoundary(_ i: Int, _ dir: Int, _ any: Bool = false) -> Bool {
      if any { return isEmpty(i) != isEmpty(i + dir) }
      return !isEmpty(i) && isEmpty(i + dir)
    }
    if dir != 0 {
      while min <= i && i <= max && count > 0 {
        if isBoundary(i, dir) { count -= 1 }
        i += dir
      }
      return (Pos(i, 0), head)
    }
    let vim = cm.vim!
    if vim.visualLine && isBoundary(line, 1, true) {
      let anchor = vim.sel.anchor
      if isBoundary(anchor.line, -1, true) {
        if !inclusive || anchor.line != line { line += 1 }
      }
    }
    var startState = isEmpty(line)
    i = line
    while i <= max && count > 0 {
      if isBoundary(i, 1, true) {
        if !inclusive || isEmpty(i) != startState { count -= 1 }
      }
      i += 1
    }
    let end = Pos(i, 0)
    // select boundary before paragraph for the last one
    if i > max && !startState { startState = true } else { inclusive = false }
    i = line
    while i > min {
      if !inclusive || isEmpty(i) == startState || i == line {
        if isBoundary(i, -1, true) { break }
      }
      i -= 1
    }
    return (Pos(i, 0), end)
  }

  /// `getSentence(cm, cur, repeat, dir, inclusive)`: the start or end of the sentence at the
  /// cursor, for `is` / `as`.
  func getSentence(_ cm: EditorAdapter, _ cur: Pos, _ repeatIn: Int, _ dir: Int, _ inclusive: Bool) -> Pos {
    struct Index {
      var line: VimText?
      var ln: Int
      var pos: Int
      var dir: Int
    }
    func nextChar(_ curr: inout Index) {
      guard let line = curr.line else { return }
      if curr.pos + curr.dir < 0 || curr.pos + curr.dir >= line.length {
        curr.line = nil
      } else {
        curr.pos += curr.dir
      }
    }
    func forward(_ ln: Int, _ pos: Int, _ dir: Int) -> (ln: Int, pos: Int) {
      let line = cm.getLine(ln)
      var curr = Index(line: line, ln: ln, pos: pos, dir: dir)
      if line.isEmpty { return (curr.ln, curr.pos) }
      var lastSentencePos = curr.pos
      // Move one step to skip character we start on
      nextChar(&curr)
      while let text = curr.line {
        lastSentencePos = curr.pos
        if VimText.isEndOfSentenceSymbol(text.at(curr.pos)) {
          if !inclusive {
            return (curr.ln, curr.pos + 1)
          } else {
            nextChar(&curr)
            while let t = curr.line {
              if VimText.isWhiteSpaceString(t.at(curr.pos)) {
                lastSentencePos = curr.pos
                nextChar(&curr)
              } else {
                break
              }
            }
            return (curr.ln, lastSentencePos + 1)
          }
        }
        nextChar(&curr)
      }
      return (curr.ln, lastSentencePos + 1)
    }
    func reverse(_ ln: Int, _ pos: Int, _ dir: Int) -> (ln: Int, pos: Int) {
      let line = cm.getLine(ln)
      var curr = Index(line: line, ln: ln, pos: pos, dir: dir)
      if line.isEmpty { return (curr.ln, curr.pos) }
      var lastSentencePos = curr.pos
      // Move one step to skip character we start on
      nextChar(&curr)
      while let text = curr.line {
        let ch = text.at(curr.pos)
        if !VimText.isWhiteSpaceString(ch) && !VimText.isEndOfSentenceSymbol(ch) {
          lastSentencePos = curr.pos
        } else if VimText.isEndOfSentenceSymbol(ch) {
          if !inclusive {
            return (curr.ln, lastSentencePos)
          } else {
            if VimText.isWhiteSpaceString(text.at(curr.pos + 1)) {
              return (curr.ln, curr.pos + 1)
            } else {
              return (curr.ln, lastSentencePos)
            }
          }
        }
        nextChar(&curr)
      }
      curr.line = line
      if inclusive && VimText.isWhiteSpaceString(line.at(curr.pos)) {
        return (curr.ln, curr.pos)
      } else {
        return (curr.ln, lastSentencePos)
      }
    }
    var index = (ln: cur.line, pos: cur.ch)
    var count = repeatIn
    while count > 0 {
      index = dir < 0 ? reverse(index.ln, index.pos, dir) : forward(index.ln, index.pos, dir)
      count -= 1
    }
    return Pos(index.ln, index.pos)
  }

  /// `findSentence(cm, cur, repeat, dir)`: `(` and `)`.
  func findSentence(_ cm: EditorAdapter, _ cur: Pos, _ repeatIn: Int, _ dir: Int) -> Pos {
    struct Index {
      var line: VimText?
      var ln: Int
      var pos: Int
      var dir: Int
    }
    func nextChar(_ idx: inout Index) {
      guard let line = idx.line else { return }
      if idx.pos + idx.dir < 0 || idx.pos + idx.dir >= line.length {
        idx.ln += idx.dir
        if !isLine(cm, idx.ln) {
          idx.line = nil
          return
        }
        let next = cm.getLine(idx.ln)
        idx.line = next
        idx.pos = idx.dir > 0 ? 0 : next.length - 1
      } else {
        idx.pos += idx.dir
      }
    }
    func forward(_ ln: Int, _ pos: Int, _ dir: Int) -> (ln: Int, pos: Int) {
      let line = cm.getLine(ln)
      var stop = line.isEmpty
      var curr = Index(line: line, ln: ln, pos: pos, dir: dir)
      var lastValid = (ln: curr.ln, pos: curr.pos)
      let skipEmptyLines = line.isEmpty
      // Move one step to skip character we start on
      nextChar(&curr)
      while let text = curr.line {
        lastValid = (curr.ln, curr.pos)
        if text.isEmpty && !skipEmptyLines {
          return (curr.ln, curr.pos)
        } else if stop && !text.isEmpty && !VimText.isWhiteSpaceString(text.at(curr.pos)) {
          return (curr.ln, curr.pos)
        } else if VimText.isEndOfSentenceSymbol(text.at(curr.pos)) && !stop
          && (curr.pos == text.length - 1 || VimText.isWhiteSpaceString(text.at(curr.pos + 1)))
        {
          stop = true
        }
        nextChar(&curr)
      }
      // Set the position to the last non whitespace character on the last valid line in the
      // case that we reach the end of the document.
      let lastLine = cm.getLine(lastValid.ln)
      lastValid.pos = 0
      var i = lastLine.length - 1
      while i >= 0 {
        if !VimText.isWhiteSpaceString(lastLine.at(i)) {
          lastValid.pos = i
          break
        }
        i -= 1
      }
      return lastValid
    }
    func reverse(_ ln: Int, _ pos: Int, _ dir: Int) -> (ln: Int, pos: Int) {
      let line = cm.getLine(ln)
      var curr = Index(line: line, ln: ln, pos: pos, dir: dir)
      var lastValidLn = curr.ln
      var lastValidPos: Int?
      var skipEmptyLines = line.isEmpty
      // Move one step to skip character we start on
      nextChar(&curr)
      while let text = curr.line {
        if text.isEmpty && !skipEmptyLines {
          if let lastValidPos {
            return (lastValidLn, lastValidPos)
          } else {
            return (curr.ln, curr.pos)
          }
        } else if VimText.isEndOfSentenceSymbol(text.at(curr.pos)), let validPos = lastValidPos,
          !(curr.ln == lastValidLn && curr.pos + 1 == validPos)
        {
          return (lastValidLn, validPos)
        } else if !text.isEmpty && !VimText.isWhiteSpaceString(text.at(curr.pos)) {
          skipEmptyLines = false
          lastValidLn = curr.ln
          lastValidPos = curr.pos
        }
        nextChar(&curr)
      }
      // Set the position to the first non whitespace character on the last valid line in the
      // case that we reach the beginning of the document.
      let validLine = cm.getLine(lastValidLn)
      var result = 0
      for i in 0..<validLine.length where !VimText.isWhiteSpaceString(validLine.at(i)) {
        result = i
        break
      }
      return (lastValidLn, result)
    }
    var index = (ln: cur.line, pos: cur.ch)
    var count = repeatIn
    while count > 0 {
      index = dir < 0 ? reverse(index.ln, index.pos, dir) : forward(index.ln, index.pos, dir)
      count -= 1
    }
    return Pos(index.ln, index.pos)
  }

  /// `expandTagUnderCursor(cm, head, inclusive)`: plain text has no tags, so the empty range at
  /// the cursor (like the CodeMirror 6 adapter without an XML language).
  func expandTagUnderCursor(_ cm: EditorAdapter, _ head: Pos, _ inclusive: Bool) -> (start: Pos, end: Pos) {
    (head, head)
  }

  // MARK: [ and ] symbols

  private struct FindSymbolState {
    var lineText: VimText
    var nextCh: VimText
    var lastCh: VimText?
    var index: Int
    var symb: VimText
    var reverseSymb: VimText?
    var forward: Bool
    var depth: Int
    var curMoveThrough: Bool
  }

  /// `findSymbol(cm, repeat, forward, symb)`: `[(`, `])`, `[{`, `]}`, `[[`, `]]`, `[m`, `[*`, `[#`…
  func findSymbol(_ cm: EditorAdapter, _ repeatIn: Int, _ forward: Bool, _ symb: VimText) -> Pos {
    var cur = cm.getCursor()
    let increment = forward ? 1 : -1
    let endLine = forward ? cm.lineCount() : -1
    let curCh = cur.ch
    var line = cur.line
    let lineText = cm.getLine(line)
    let reverseTable: [String: String] = forward ? [")": "(", "}": "{"] : ["(": ")", "{": "}"]
    var state = FindSymbolState(
      lineText: lineText, nextCh: lineText.charAt(curCh), lastCh: nil, index: curCh, symb: symb,
      reverseSymb: reverseTable[symb.string].map(VimText.init), forward: forward, depth: 0, curMoveThrough: false)
    let symbolToMode: [String: String] = [
      "(": "bracket", ")": "bracket", "{": "bracket", "}": "bracket", "[": "section", "]": "section",
      "*": "comment", "/": "comment", "m": "method", "M": "method", "#": "preprocess",
    ]
    guard let mode = symbolToMode[symb.string] else { return cur }
    // init
    switch mode {
    case "section":
      state.curMoveThrough = true
      state.symb = (state.forward ? "]" : "[") == state.symb ? "{" : "}"
    case "method":
      state.symb = state.symb == "m" ? "{" : "}"
      state.reverseSymb = state.symb == "{" ? "}" : "{"
    case "preprocess":
      state.index = 0
    default:
      break
    }
    func isComplete(_ state: inout FindSymbolState) -> Bool {
      switch mode {
      case "bracket":
        if state.nextCh == state.symb {
          state.depth += 1
          if state.depth >= 1 { return true }
        } else if let reverse = state.reverseSymb, state.nextCh == reverse {
          state.depth -= 1
        }
        return false
      case "section":
        return state.index == 0 && state.nextCh == state.symb
      case "comment":
        let found = state.lastCh == "*" && state.nextCh == "/"
        state.lastCh = state.nextCh
        return found
      case "method":
        return state.nextCh == state.symb
      case "preprocess":
        if state.nextCh == "#" {
          let token = preprocessorToken(state.lineText)
          if token == "endif" {
            if state.forward && state.depth == 0 { return true }
            state.depth += 1
          } else if token == "if" {
            if !state.forward && state.depth == 0 { return true }
            state.depth -= 1
          }
          if token == "else" && state.depth == 0 { return true }
        }
        return false
      default:
        return false
      }
    }
    var count = repeatIn
    while line != endLine && count > 0 {
      state.index += increment
      state.nextCh = state.lineText.charAt(state.index)
      if state.nextCh.isEmpty {
        line += increment
        state.lineText = cm.getLine(line)
        if increment > 0 {
          state.index = 0
        } else {
          let lineLen = state.lineText.length
          state.index = lineLen > 0 ? lineLen - 1 : 0
        }
        state.nextCh = state.lineText.charAt(state.index)
      }
      if isComplete(&state) {
        cur.line = line
        cur.ch = state.index
        count -= 1
      }
    }
    if !state.nextCh.isEmpty || state.curMoveThrough { return Pos(line, state.index) }
    return cur
  }

  /// `state.lineText.match(/^#(\w+)/)?.[1]`.
  private func preprocessorToken(_ text: VimText) -> String? {
    guard text.code(at: 0) == 0x23 else { return nil }
    var i = 1
    while i < text.length && isJSAsciiWordChar(text[i]) { i += 1 }
    return i > 1 ? text.slice(1, i).string : nil
  }
}
