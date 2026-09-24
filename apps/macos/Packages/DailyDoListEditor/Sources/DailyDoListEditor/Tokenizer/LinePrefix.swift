import Foundation

/// The structural prefix of a markdown line: blockquote markers, indentation, a list marker and a
/// task box. Shared by the tokenizer (styling) and the editing commands (list continuation,
/// checklists), so both agree on what a task line is. The rules match `parseTasks` in `@ddl/core`
/// (a task is `[-*+]` or `1.`/`1)`, whitespace, `[c]`, then whitespace or the end of the line),
/// extended with blockquote prefixes like the web editor.
struct LinePrefix: Equatable, Sendable {
  struct OrderedMarker: Equatable, Sendable {
    var number: Int
    /// `.` or `)`.
    var delimiter: UInt16
  }

  /// Ranges of each `>` marker, including the whitespace before the first one and one space or tab
  /// after each.
  var quoteMarkers: [NSRange] = []
  /// End of the quote prefix (0 without quotes).
  var quoteEnd = 0
  /// End of the indentation after the quote prefix.
  var indentEnd = 0
  /// The list marker (`-`, `*`, `+`, `12.`, `3)`), if this is a list item.
  var marker: NSRange?
  var bullet: UInt16?
  var ordered: OrderedMarker?
  /// Whitespace between the marker and the content (or the box).
  var markerSpace = NSRange(location: 0, length: 0)
  /// The `[c]` task box.
  var box: NSRange?
  var status: UInt16?
  /// Where the item's text starts (after the marker, the box and their whitespace).
  var contentStart = 0

  var quoteDepth: Int { quoteMarkers.count }
  var isListItem: Bool { marker != nil }
  var isTask: Bool { box != nil }

  /// Parses the prefix of one line (UTF-16 units, without the line terminator).
  static func parse(_ s: [UInt16]) -> LinePrefix {
    var prefix = LinePrefix()
    let n = s.count
    var pos = scanQuotes(s, into: &prefix)
    prefix.quoteEnd = pos
    while pos < n, CharClass.isSpaceOrTab(s[pos]) { pos += 1 }
    prefix.indentEnd = pos
    prefix.contentStart = pos
    guard !MarkdownBlockRules.isHorizontalRule(s, from: prefix.quoteEnd) else { return prefix }

    let markerStart = pos
    var markerEnd = pos
    if pos < n, s[pos] == UTF16Unit.dash || s[pos] == UTF16Unit.asterisk || s[pos] == UTF16Unit.plus {
      markerEnd = pos + 1
      prefix.bullet = s[pos]
    } else {
      var digits = 0
      var number = 0
      while pos + digits < n, digits < 10, CharClass.isASCIIDigit(s[pos + digits]) {
        number = number * 10 + Int(s[pos + digits] - UTF16Unit.zero)
        digits += 1
      }
      guard digits >= 1, digits <= 9, pos + digits < n else { return prefix }
      let delimiter = s[pos + digits]
      guard delimiter == UTF16Unit.dot || delimiter == UTF16Unit.closeParen else { return prefix }
      markerEnd = pos + digits + 1
      prefix.ordered = OrderedMarker(number: number, delimiter: delimiter)
    }
    guard markerEnd == n || CharClass.isSpaceOrTab(s[markerEnd]) else {
      prefix.bullet = nil
      prefix.ordered = nil
      return prefix
    }
    prefix.marker = NSRange(markerStart, markerEnd)
    var spaceEnd = markerEnd
    while spaceEnd < n, CharClass.isSpaceOrTab(s[spaceEnd]) { spaceEnd += 1 }
    prefix.markerSpace = NSRange(markerEnd, spaceEnd)
    prefix.contentStart = spaceEnd

    let boxStart = spaceEnd
    if spaceEnd > markerEnd, boxStart + 2 < n, s[boxStart] == UTF16Unit.openBracket,
      s[boxStart + 2] == UTF16Unit.closeBracket,
      boxStart + 3 == n || CharClass.isSpaceOrTab(s[boxStart + 3])
    {
      prefix.box = NSRange(location: boxStart, length: 3)
      prefix.status = s[boxStart + 1]
      var textStart = boxStart + 3
      while textStart < n, CharClass.isSpaceOrTab(s[textStart]) { textStart += 1 }
      prefix.contentStart = textStart
    }
    return prefix
  }

  /// Blockquote markers: optional leading whitespace, then `>` with one optional space, repeated.
  private static func scanQuotes(_ s: [UInt16], into prefix: inout LinePrefix) -> Int {
    let n = s.count
    var markerStart = 0
    var probe = 0
    while probe < n, CharClass.isSpaceOrTab(s[probe]) { probe += 1 }
    guard probe < n, s[probe] == UTF16Unit.greaterThan else { return 0 }
    var pos = probe
    while true {
      pos += 1
      if pos < n, CharClass.isSpaceOrTab(s[pos]) { pos += 1 }
      prefix.quoteMarkers.append(NSRange(markerStart, pos))
      var next = pos
      while next < n, CharClass.isSpaceOrTab(s[next]) { next += 1 }
      guard next < n, s[next] == UTF16Unit.greaterThan else { break }
      markerStart = pos
      pos = next
    }
    return pos
  }
}

/// Block-level line rules shared by the tokenizer and the commands.
enum MarkdownBlockRules {
  static func isBlank(_ s: [UInt16]) -> Bool {
    s.allSatisfy(CharClass.isLineBlank)
  }

  /// `---`, `***`, `___` (three or more, spaces allowed between) and nothing else from `from` on.
  static func isHorizontalRule(_ s: [UInt16], from: Int) -> Bool {
    var marker: UInt16 = 0
    var count = 0
    var i = from
    while i < s.count {
      let c = s[i]
      if CharClass.isLineBlank(c) {
        i += 1
        continue
      }
      if marker == 0 {
        guard c == UTF16Unit.dash || c == UTF16Unit.asterisk || c == UTF16Unit.underscore else {
          return false
        }
        marker = c
      } else if c != marker {
        return false
      }
      count += 1
      i += 1
    }
    return count >= 3
  }

  /// An opening code fence (```` ``` ```` or `~~~`, three or more, any indentation). A backtick
  /// fence's info string can't contain backticks (that would be inline code).
  static func openingFence(_ s: [UInt16]) -> (marker: UInt16, length: Int)? {
    var i = 0
    while i < s.count, CharClass.isSpaceOrTab(s[i]) { i += 1 }
    guard i < s.count, s[i] == UTF16Unit.backtick || s[i] == UTF16Unit.tilde else { return nil }
    let marker = s[i]
    var length = 0
    while i + length < s.count, s[i + length] == marker { length += 1 }
    guard length >= 3 else { return nil }
    if marker == UTF16Unit.backtick {
      for j in (i + length)..<s.count where s[j] == UTF16Unit.backtick { return nil }
    }
    return (marker, length)
  }

  /// A closing fence for an opening fence of `marker` × `length`: same character, at least as long,
  /// nothing but blanks around it.
  static func isClosingFence(_ s: [UInt16], marker: UInt16, length: Int) -> Bool {
    var i = 0
    while i < s.count, CharClass.isSpaceOrTab(s[i]) { i += 1 }
    var run = 0
    while i + run < s.count, s[i + run] == marker { run += 1 }
    guard run >= 3, run >= length else { return false }
    for j in (i + run)..<s.count where !CharClass.isLineBlank(s[j]) { return false }
    return true
  }

  /// Frontmatter opening line: `---` then blanks (only meaningful on the first line).
  static func isFrontmatterOpen(_ s: [UInt16]) -> Bool {
    delimiterLine(s, of: UTF16Unit.dash)
  }

  /// Frontmatter closing line: `---` or `...` then blanks.
  static func isFrontmatterClose(_ s: [UInt16]) -> Bool {
    delimiterLine(s, of: UTF16Unit.dash) || delimiterLine(s, of: UTF16Unit.dot)
  }

  private static func delimiterLine(_ s: [UInt16], of c: UInt16) -> Bool {
    guard s.count >= 3, s[0] == c, s[1] == c, s[2] == c else { return false }
    for j in 3..<s.count where !CharClass.isLineBlank(s[j]) { return false }
    return true
  }
}
