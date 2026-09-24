// Ported from `RegExpCursor` / `MultilineRegExpCursor` of @codemirror/search 6.7.2 and
// `getSearchCursor` of @replit/codemirror-vim 6.4.0 (MIT, © Marijn Haverbeke and others).

/// A match found by a search cursor, in document offsets.
struct SearchMatch {
  let from: Int
  let to: Int
  let match: JSMatch
}

/// CodeMirror 6's `RegExpCursor`: finds the matches of `regex` (compiled with "gmu" and the query's
/// case flag) in `from...to`, line by line, or across lines when the pattern can match line
/// breaks (`\s`, `\W`, `\D`, `\n`, `\r`, `[^`).
@MainActor
struct RegExpCursor {
  private let cm: EditorAdapter
  private let regex: JSRegExp
  private let to: Int
  private let multiline: Bool
  private var matchPos: Int
  private var lastTo = -1
  // Line mode
  private var curLineStart = 0
  private var curLine = VimText()
  private var curSubject: JSSubject?
  // Multiline mode
  private var flatFrom = 0
  private var flatText = VimText()
  private var flatSubject: JSSubject?

  init(_ cm: EditorAdapter, regex: JSRegExp, source: VimText, from: Int, to: Int) {
    self.cm = cm
    self.regex = regex
    self.to = to
    self.multiline = RegExpCursor.needsMultiline(source)
    self.matchPos = RegExpCursor.toCharEnd(cm, from)
    if multiline {
      flatFrom = from
      flatText = cm.sliceDoc(from, chunkEnd(from + 5000))
    } else {
      let line = cm.host.vimLineNumber(at: from)
      curLineStart = cm.host.vimLineStart(line)
      loadLine(line)
    }
  }

  /// `/\\[sWDnr]|\n|\r|\[\^/.test(query)`.
  static func needsMultiline(_ source: VimText) -> Bool {
    let u = source.units
    for i in u.indices {
      switch u[i] {
      case 0x0A, 0x0D: return true
      case 0x5C where i + 1 < u.count && [0x73, 0x57, 0x44, 0x6E, 0x72].contains(u[i + 1]):
        return true
      case 0x5B where i + 1 < u.count && u[i + 1] == 0x5E: return true
      default: continue
      }
    }
    return false
  }

  /// Moves past low surrogates (never stops inside a surrogate pair).
  static func toCharEnd(_ cm: EditorAdapter, _ pos: Int) -> Int {
    if pos >= cm.docLength { return pos }
    let line = cm.host.vimLineNumber(at: pos)
    let start = cm.host.vimLineStart(line)
    let text = cm.host.vimLine(line)
    var p = pos
    while p < start + text.length, isLowSurrogate(text[p - start]) { p += 1 }
    return p
  }

  private mutating func loadLine(_ line: Int) {
    var text = cm.getLine(line)
    if curLineStart + text.length > to { text = text.slice(0, to - curLineStart) }
    curLine = text
    curSubject = nil
  }

  private mutating func nextLine() {
    curLineStart = curLineStart + curLine.length + 1
    if curLineStart > to {
      curLine = VimText()
      curSubject = nil
    } else {
      loadLine(cm.host.vimLineNumber(at: curLineStart))
    }
  }

  private func chunkEnd(_ pos: Int) -> Int {
    pos >= to ? to : cm.lineEnd(cm.host.vimLineNumber(at: pos))
  }

  /// The next match, or nil when the range is exhausted.
  mutating func next() -> SearchMatch? {
    multiline ? nextMultiline() : nextInLines()
  }

  private mutating func nextInLines() -> SearchMatch? {
    var off = matchPos - curLineStart
    while true {
      var match: JSMatch?
      if matchPos <= to {
        if curSubject == nil { curSubject = JSSubject(curLine) }
        match = off >= 0 && off <= curLine.length ? regex.exec(curSubject!, from: off) : nil
      }
      if let match {
        let from = curLineStart + match.index
        let end = from + match.length
        matchPos = RegExpCursor.toCharEnd(cm, end + (from == end ? 1 : 0))
        if from == curLineStart + curLine.length { nextLine() }
        if from < end || from > lastTo {
          lastTo = end
          return SearchMatch(from: from, to: end, match: match)
        }
        off = matchPos - curLineStart
      } else if curLineStart + curLine.length < to {
        nextLine()
        off = 0
      } else {
        return nil
      }
    }
  }

  private mutating func nextMultiline() -> SearchMatch? {
    while true {
      let off = matchPos - flatFrom
      if flatSubject == nil { flatSubject = JSSubject(flatText) }
      var match = off >= 0 && off <= flatText.length ? regex.exec(flatSubject!, from: off) : nil
      if let m = match, m.length == 0, m.index == off {
        match = off + 1 <= flatText.length ? regex.exec(flatSubject!, from: off + 1) : nil
      }
      if let match {
        let from = flatFrom + match.index
        let end = from + match.length
        if flatFrom + flatText.length >= to || match.index + match.length <= flatText.length - 10 {
          matchPos = RegExpCursor.toCharEnd(cm, end + (from == end ? 1 : 0))
          return SearchMatch(from: from, to: end, match: match)
        }
      }
      if flatFrom + flatText.length == to { return nil }
      flatText = cm.sliceDoc(flatFrom, chunkEnd(flatFrom + flatText.length * 2))
      flatSubject = nil
    }
  }
}

/// The search cursor vim.js gets from `cm.getSearchCursor(query, pos)`.
@MainActor
final class SearchCursor {
  private let cm: EditorAdapter
  private let query: JSRegExp
  private let source: VimText
  private var compiled: JSRegExp?
  private var last: (from: Int, to: Int, match: JSMatch)?
  private var lastResult: (from: Pos, to: Pos, match: JSMatch)?
  private var afterEmptyMatch = false
  private let firstOffset: Int

  init(_ cm: EditorAdapter, query: JSRegExp, pos: Pos) {
    self.cm = cm
    self.query = query
    firstOffset = cm.indexFromPos(pos)
    source = SearchCursor.escapeBraces(query.source)
  }

  /// CodeMirror's cursor compiles the query with the `u` flag when searching, which throws for
  /// some patterns that are valid without it (`\-`, `x{`).
  private var regex: JSRegExp {
    get throws {
      if let compiled { return compiled }
      let made = try JSRegExp.make(source, "gmu" + (query.ignoreCase ? "i" : ""))
      compiled = made
      return made
    }
  }

  /// Escapes braces that don't form a quantifier:
  /// `source.replace(/(\\.|{(?:\d+(?:,\d*)?|,\d+)})|[{}]/g, (a, b) => b ? b : "\\" + a)`.
  static func escapeBraces(_ source: VimText) -> VimText {
    let u = source.units
    var out: [UInt16] = []
    var i = 0
    while i < u.count {
      let c = u[i]
      if c == 0x5C, i + 1 < u.count, !isJSLineTerminator(u[i + 1]) {
        out.append(c)
        out.append(u[i + 1])
        i += 2
        continue
      }
      if c == 0x7B, let end = quantifierEnd(u, i) {
        out.append(contentsOf: u[i...end])
        i = end + 1
        continue
      }
      if c == 0x7B || c == 0x7D {
        out.append(0x5C)
      }
      out.append(c)
      i += 1
    }
    return VimText(units: out)
  }

  /// The index of the "}" of `{\d+(?:,\d*)?}` or `{,\d+}` starting at `i`.
  private static func quantifierEnd(_ u: [UInt16], _ i: Int) -> Int? {
    var j = i + 1
    let digitsStart = j
    while j < u.count, isASCIIDigit(u[j]) { j += 1 }
    if j > digitsStart {
      if j < u.count, u[j] == 0x2C {
        j += 1
        while j < u.count, isASCIIDigit(u[j]) { j += 1 }
      }
    } else {
      guard j < u.count, u[j] == 0x2C else { return nil }
      j += 1
      let start = j
      while j < u.count, isASCIIDigit(u[j]) { j += 1 }
      if j == start { return nil }
    }
    return j < u.count && u[j] == 0x7D ? j : nil
  }

  private func cursor(from: Int, to: Int? = nil) throws -> RegExpCursor {
    RegExpCursor(cm, regex: try regex, source: source, from: from, to: to ?? cm.docLength)
  }

  private func nextMatch(_ from: Int) throws -> SearchMatch? {
    if from > cm.docLength { return nil }
    var c = try cursor(from: from)
    return c.next()
  }

  private func prevMatchInRange(_ from: Int, _ to: Int) throws -> SearchMatch? {
    let chunk = 10000
    var size = 1
    while true {
      let start = max(from, to - size * chunk)
      var c = try cursor(from: start, to: to)
      var range: SearchMatch?
      while let m = c.next() { range = m }
      if let range, start == from || range.from > start + 10 { return range }
      if start == from { return nil }
      size += 1
    }
  }

  func findNext() throws -> JSMatch? { try find(false) }
  func findPrevious() throws -> JSMatch? { try find(true) }

  /// Moves to the next (or previous) match; nil when there is none.
  @discardableResult
  func find(_ back: Bool) throws -> JSMatch? {
    let found: SearchMatch?
    if back {
      let endAt = last.map { afterEmptyMatch ? $0.to - 1 : $0.from } ?? firstOffset
      found = try prevMatchInRange(0, endAt)
    } else {
      let startFrom = last.map { afterEmptyMatch ? $0.to + 1 : $0.to } ?? firstOffset
      found = try nextMatch(startFrom)
    }
    last = found.map { ($0.from, $0.to, $0.match) }
    lastResult = found.map { (cm.posFromIndex($0.from), cm.posFromIndex($0.to), $0.match) }
    afterEmptyMatch = found.map { $0.from == $0.to } ?? false
    return found?.match
  }

  func from() -> Pos? { lastResult?.from }
  func to() -> Pos? { lastResult?.to }
  var match: JSMatch? { lastResult?.match }

  func replace(_ text: VimText) throws {
    guard let current = last else { return }
    let changes = try ChangeSet.of(
      [.init(from: current.from, to: current.to, insert: text)], length: cm.docLength)
    cm.dispatchChange(changes)
    // CodeMirror adds the raw length (a "\r\n" counts two though it becomes one line break).
    let newTo = current.from + text.length
    last = (current.from, newTo, current.match)
    if let result = lastResult { lastResult = (result.from, cm.posFromIndex(newTo), result.match) }
  }
}

extension EditorAdapter {
  func getSearchCursor(_ query: JSRegExp, _ pos: Pos) -> SearchCursor {
    SearchCursor(self, query: query, pos: pos)
  }
}
