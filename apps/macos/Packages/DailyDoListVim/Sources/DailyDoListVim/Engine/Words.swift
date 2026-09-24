// Ported from vim.js (@replit/codemirror-vim-core 0.1.0, MIT, © Marijn Haverbeke and others):
// `wordCharTest`, `bigWordCharTest`, `findWord`, `moveToWord` and `expandWordUnderCursor`. The
// tests receive `line.charAt(i)`: one UTF-16 code unit, or nil past the end.

/// `line.charAt(i)` as a code unit (nil for "").
@inline(__always) func charAt(_ line: VimText, _ i: Int) -> UInt16? { line.code(at: i) }

typealias CharTest = @Sendable (UInt16?) -> Bool

/// `wordCharTest[0]`: `CodeMirror.isWordChar`.
let isWordCharTest: CharTest = { $0.map(isWordChar) ?? false }
/// `wordCharTest[1]`: neither a word character nor whitespace.
let isPunctuationTest: CharTest = { $0.map(isPunctuationChar) ?? false }
/// `bigWordCharTest[0]`: `/\S/`.
let isNonSpaceTest: CharTest = { $0.map { !isJSWhitespace($0) } ?? false }
/// `/\s/`.
let isSpaceTest: CharTest = { $0.map(isJSWhitespace) ?? false }

/// A word found by `findWord`: `from..<to` on `line`.
struct FoundWord {
  var from: Int
  var to: Int
  var line: Int
}

extension Vim {
  func isLine(_ cm: EditorAdapter, _ line: Int) -> Bool {
    line >= cm.firstLine() && line <= cm.lastLine()
  }

  /// `findWord(cm, cur, forward, bigWord, emptyLineIsWord)`: the next word from `cur` (the rest of
  /// the current word when in the middle of one).
  func findWord(_ cm: EditorAdapter, _ cur: Pos, _ forward: Bool, _ bigWord: Bool, _ emptyLineIsWord: Bool) -> FoundWord? {
    var lineNum = cur.line
    var pos = cur.ch
    var line = cm.getLine(lineNum)
    let dir = forward ? 1 : -1
    let charTests: [CharTest] = bigWord ? [isNonSpaceTest] : [isWordCharTest, isPunctuationTest]
    if emptyLineIsWord && line.isEmpty {
      lineNum += dir
      line = cm.getLine(lineNum)
      if !isLine(cm, lineNum) { return nil }
      pos = forward ? 0 : line.length
    }
    while true {
      if emptyLineIsWord && line.isEmpty { return FoundWord(from: 0, to: 0, line: lineNum) }
      let stop = dir > 0 ? line.length : -1
      var wordStart = stop, wordEnd = stop
      // `pos != stop`, guarded against starting past the end of the line.
      while dir > 0 ? pos < stop : pos > stop {
        var foundWord = false
        var i = 0
        while i < charTests.count && !foundWord {
          if charTests[i](charAt(line, pos)) {
            wordStart = pos
            // Advance to end of word.
            while pos != stop && charTests[i](charAt(line, pos)) { pos += dir }
            wordEnd = pos
            foundWord = wordStart != wordEnd
            if wordStart == cur.ch && lineNum == cur.line && wordEnd == wordStart + dir {
              // We started at the end of a word. Find the next one.
              i += 1
              continue
            } else {
              return FoundWord(from: min(wordStart, wordEnd + 1), to: max(wordStart, wordEnd), line: lineNum)
            }
          }
          i += 1
        }
        if !foundWord { pos += dir }
      }
      // Advance to next/prev line.
      lineNum += dir
      if !isLine(cm, lineNum) { return nil }
      line = cm.getLine(lineNum)
      pos = dir > 0 ? 0 : line.length
    }
  }

  /// `moveToWord(cm, cur, repeat, forward, wordEnd, bigWord)`: `w`, `e`, `b`, `ge` and friends.
  func moveToWord(_ cm: EditorAdapter, _ start: Pos, _ repeatIn: Int, _ forward: Bool, _ wordEnd: Bool, _ bigWord: Bool) -> Pos? {
    let curStart = start
    var cur = start
    var words: [FoundWord] = []
    var count = repeatIn
    if (forward && !wordEnd) || (!forward && wordEnd) { count += 1 }
    // For 'e', empty lines are not considered words, go figure.
    let emptyLineIsWord = !(forward && wordEnd)
    for _ in 0..<max(0, count) {
      guard let word = findWord(cm, cur, forward, bigWord, emptyLineIsWord) else {
        let eodCh = lineLength(cm, cm.lastLine())
        words.append(forward ? FoundWord(from: eodCh, to: eodCh, line: cm.lastLine()) : FoundWord(from: 0, to: 0, line: 0))
        break
      }
      words.append(word)
      cur = Pos(word.line, forward ? word.to - 1 : word.from)
    }
    let shortCircuit = words.count != count
    guard let firstWord = words.first else { return nil }
    var lastWord = words.popLast()
    if forward && !wordEnd {
      // w
      if !shortCircuit && (firstWord.from != curStart.ch || firstWord.line != curStart.line) {
        // We did not start in the middle of a word. Discard the extra word at the end.
        lastWord = words.popLast()
      }
      return lastWord.map { Pos($0.line, $0.from) }
    } else if forward && wordEnd {
      return lastWord.map { Pos($0.line, $0.to - 1) }
    } else if !forward && wordEnd {
      // ge
      if !shortCircuit && (firstWord.to != curStart.ch || firstWord.line != curStart.line) {
        lastWord = words.popLast()
      }
      return lastWord.map { Pos($0.line, $0.to) }
    } else {
      // b
      return lastWord.map { Pos($0.line, $0.from) }
    }
  }

  struct WordOptions {
    var inclusive = false
    var innerWord = false
    var bigWord = false
    var noSymbol = false
    var multiline = false
  }

  /// `expandWordUnderCursor(cm, options, cursor)`: the word at (or after) the cursor, for `*`, `#`,
  /// `iw`, `aw`, `iW`, `aW`.
  func expandWordUnderCursor(_ cm: EditorAdapter, _ options: WordOptions, _ cursor: Pos? = nil) -> (start: Pos, end: Pos)? {
    let cur = cursor ?? getHead(cm)
    let line = cm.getLine(cur.line)
    var endLine = line
    let startLineNumber = cur.line
    var endLineNumber = startLineNumber
    var idx = cur.ch
    var wordOnNextLine: FoundWord?
    // Seek to first word or non-whitespace character, depending on if noSymbol is true.
    var test: CharTest = options.noSymbol ? isWordCharTest : isNonSpaceTest
    if options.innerWord && isSpaceTest(charAt(line, idx)) {
      test = isSpaceTest
    } else {
      while !test(charAt(line, idx)) {
        idx += 1
        if idx >= line.length {
          if !options.multiline { return nil }
          idx -= 1
          wordOnNextLine = findWord(cm, cur, true, options.bigWord, true)
          break
        }
      }
      if options.bigWord {
        test = isNonSpaceTest
      } else {
        test = isWordCharTest
        if !test(charAt(line, idx)) { test = isPunctuationTest }
      }
    }
    var end = idx, start = idx
    while test(charAt(line, start)) && start >= 0 { start -= 1 }
    start += 1
    if let next = wordOnNextLine {
      end = next.to
      endLineNumber = next.line
      endLine = cm.getLine(endLineNumber)
      if endLine.isEmpty && end == 0 { end += 1 }
    } else {
      while test(charAt(line, end)) && end < line.length { end += 1 }
    }
    if options.inclusive {
      // If present, include all whitespace after word. Otherwise, include all whitespace before
      // word, except indentation.
      let wordEnd = end
      let startsWithSpace = cur.ch <= start && isSpaceTest(charAt(line, cur.ch))
      if !startsWithSpace {
        while isSpaceTest(charAt(endLine, end)) && end < endLine.length { end += 1 }
      }
      if wordEnd == end || startsWithSpace {
        let wordStart = start
        while isSpaceTest(charAt(line, start - 1)) && start > 0 { start -= 1 }
        if start == 0 && !startsWithSpace { start = wordStart }
      }
    }
    return (Pos(startLineNumber, start), Pos(endLineNumber, end))
  }
}
