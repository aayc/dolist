import Foundation

/// The result of an editing command: replacements in the original text's coordinates (sorted,
/// non-overlapping) and the selection afterwards. An edit without replacements means "handled,
/// nothing to change" (the key is still consumed).
struct TextEdit: Equatable, Sendable {
  struct Replacement: Equatable, Sendable {
    var range: NSRange
    var text: String
  }

  var replacements: [Replacement]
  var selection: [NSRange]

  /// The edited text (used by tests and for previews).
  func applied(to text: String) -> String {
    let result = NSMutableString(string: text)
    for replacement in replacements.reversed() {
      result.replaceCharacters(in: replacement.range, with: replacement.text)
    }
    return result as String
  }

  /// Maps an offset of the original text through the replacements. `forward` decides where an
  /// offset at an insertion point goes (after the inserted text when true).
  func map(_ offset: Int, forward: Bool) -> Int {
    var delta = 0
    for replacement in replacements {
      let range = replacement.range
      let inserted = (replacement.text as NSString).length
      if range.end < offset || (range.end == offset && (range.length > 0 || forward)) {
        delta += inserted - range.length
      } else if range.location < offset {
        return range.location + delta + (forward ? inserted : 0)
      } else {
        break
      }
    }
    return offset + delta
  }
}

/// Line lookup on an `NSString` (lines end at `\n` only).
struct TextLines {
  let text: NSString

  init(_ text: NSString) {
    self.text = text
  }

  var length: Int { text.length }

  /// Content range (without `\n`) of the line containing `offset`.
  func line(containing offset: Int) -> NSRange {
    let clamped = max(0, min(offset, text.length))
    var start = clamped
    while start > 0, text.character(at: start - 1) != UTF16Unit.newline { start -= 1 }
    var end = clamped
    while end < text.length, text.character(at: end) != UTF16Unit.newline { end += 1 }
    return NSRange(start, end)
  }

  /// The line after `line` (a content range), if any.
  func line(after line: NSRange) -> NSRange? {
    line.end < text.length ? self.line(containing: line.end + 1) : nil
  }

  /// The line before `line` (a content range), if any.
  func line(before line: NSRange) -> NSRange? {
    line.location > 0 ? self.line(containing: line.location - 1) : nil
  }

  func units(_ range: NSRange) -> [UInt16] {
    text.utf16Units(in: range)
  }

  func string(_ range: NSRange) -> String {
    text.substring(with: range.clamped(to: text.length))
  }

  /// Lines touched by the selection, in order. A non-empty range ending at a line start doesn't
  /// include that line.
  func selectedLines(_ selection: [NSRange]) -> [NSRange] {
    var result: [NSRange] = []
    for range in selection.sorted(by: { $0.location < $1.location }) {
      var line = self.line(containing: range.location)
      let last = range.length > 0 && range.end > line.end ? self.line(containing: range.end) : line
      let lastLine =
        range.length > 0 && last.location == range.end && last.location > line.location
        ? self.line(containing: range.end - 1) : last
      while true {
        if result.last.map({ $0.location < line.location }) ?? true { result.append(line) }
        guard line.location < lastLine.location, let next = self.line(after: line) else { break }
        line = next
      }
    }
    return result
  }
}
