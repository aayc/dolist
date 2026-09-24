import Foundation

/// Minimal single replacement between two texts, for applying external changes without disturbing
/// the selection, scroll position and badge anchors (port of `minimalChange` in the web editor).
enum TextDiff {
  struct Change: Equatable, Sendable {
    /// Replaced range in the current text.
    var range: NSRange
    var replacement: String
  }

  /// The replacement turning `current` into `next`: common prefix/suffix trimmed, never splitting a
  /// surrogate pair. Whole-line insertions/deletions are aligned to line starts, so text inserted
  /// above a line moves positions on that line down instead of leaving them behind.
  static func minimalChange(from current: String, to next: String) -> Change? {
    minimalChange(from: Array(current.utf16), to: Array(next.utf16))
  }

  static func minimalChange(from a: [UInt16], to b: [UInt16]) -> Change? {
    guard a != b else { return nil }
    let limit = min(a.count, b.count)
    var start = 0
    while start < limit, a[start] == b[start] { start += 1 }
    var end = 0
    while end < limit - start, a[a.count - 1 - end] == b[b.count - 1 - end] { end += 1 }
    if start > 0, CharClass.isHighSurrogate(a[start - 1]) { start -= 1 }
    if end > 0, CharClass.isLowSurrogate(a[a.count - end]) { end -= 1 }

    var from = start
    var to = a.count - end
    var insertTo = b.count - end
    if from == to, b[from..<insertTo].contains(UTF16Unit.newline) {
      let shift = from - slideToLineStart(b, from: from, length: insertTo - from)
      from -= shift
      to -= shift
      insertTo -= shift
    } else if from == insertTo, a[from..<to].contains(UTF16Unit.newline) {
      let shift = from - slideToLineStart(a, from: from, length: to - from)
      from -= shift
      to -= shift
      insertTo -= shift
    }
    return Change(range: NSRange(from, to), replacement: String(utf16Units: b[from..<insertTo]))
  }

  /// Slides the segment `[from, from + length)` left towards the nearest line start while the text
  /// allows it (each step needs the unit before the segment to equal its last unit).
  private static func slideToLineStart(_ text: [UInt16], from: Int, length: Int) -> Int {
    var pos = from
    while pos > 0, text[pos - 1] != UTF16Unit.newline {
      if text[pos - 1] != text[pos - 1 + length] { return from }
      pos -= 1
    }
    return pos
  }

  /// `\r\n` and lone `\r` become `\n` (the editor's line model).
  static func normalizeLineEndings(_ text: String) -> String {
    guard text.utf8.contains(0x0D) else { return text }
    return text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
  }
}
