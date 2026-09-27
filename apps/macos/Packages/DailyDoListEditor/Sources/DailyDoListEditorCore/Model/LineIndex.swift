import Foundation

/// Start offsets of every line (lines end at `\n` only, like `@ddl/core`), updated incrementally
/// on edits. Line numbers are 0-based; a text with `n` newlines has `n + 1` lines.
package struct LineIndex: Equatable, Sendable {
  /// Lines affected by an edit: `firstLine...oldLastLine` (old numbering) became
  /// `firstLine...newLastLine` (new numbering); later lines shifted by `newLastLine - oldLastLine`.
  package struct Change: Equatable, Sendable {
    package var firstLine: Int
    package var oldLastLine: Int
    package var newLastLine: Int
  }

  package private(set) var starts: [Int] = [0]

  package var count: Int { starts.count }

  package init() {}

  package init(_ text: NSString) {
    rebuild(text)
  }

  package mutating func rebuild(_ text: NSString) {
    starts = [0] + Self.newlineStarts(in: text, range: NSRange(location: 0, length: text.length))
  }

  /// Applies the replacement of `oldLength` units at `location` by `newLength` units (already in
  /// `text`).
  @discardableResult
  package mutating func applyEdit(location: Int, oldLength: Int, newLength: Int, text: NSString)
    -> Change
  {
    let firstLine = line(containing: location)
    let oldLastLine = line(containing: location + oldLength)
    let inserted = Self.newlineStarts(
      in: text, range: NSRange(location: location, length: newLength))
    starts.replaceSubrange((firstLine + 1)..<(oldLastLine + 1), with: inserted)
    let delta = newLength - oldLength
    if delta != 0 {
      for k in (firstLine + 1 + inserted.count)..<starts.count { starts[k] += delta }
    }
    return Change(
      firstLine: firstLine, oldLastLine: oldLastLine, newLastLine: firstLine + inserted.count)
  }

  /// The 0-based line containing `offset` (clamped to the document).
  package func line(containing offset: Int) -> Int {
    var low = 0
    var high = starts.count - 1
    while low < high {
      let mid = (low + high + 1) / 2
      if starts[mid] <= offset { low = mid } else { high = mid - 1 }
    }
    return low
  }

  package func start(ofLine line: Int) -> Int {
    starts[max(0, min(line, starts.count - 1))]
  }

  /// Content of `line` without its `\n`.
  package func contentRange(ofLine line: Int, textLength: Int) -> NSRange {
    let clamped = max(0, min(line, starts.count - 1))
    let start = starts[clamped]
    let end = clamped + 1 < starts.count ? starts[clamped + 1] - 1 : textLength
    return NSRange(start, max(start, end))
  }

  /// `line` including its `\n` (if any).
  package func fullRange(ofLine line: Int, textLength: Int) -> NSRange {
    let clamped = max(0, min(line, starts.count - 1))
    let start = starts[clamped]
    let end = clamped + 1 < starts.count ? starts[clamped + 1] : textLength
    return NSRange(start, max(start, end))
  }

  /// Whole lines covering `range` (including the last line's `\n`).
  package func fullLines(covering range: NSRange, textLength: Int) -> NSRange {
    let first = line(containing: range.location)
    let last = line(containing: range.end)
    let start = starts[first]
    let end = fullRange(ofLine: last, textLength: textLength).end
    return NSRange(start, end)
  }

  private static func newlineStarts(in text: NSString, range: NSRange) -> [Int] {
    guard range.length > 0 else { return [] }
    let units = text.utf16Units(in: range)
    var result: [Int] = []
    for (offset, unit) in units.enumerated() where unit == UTF16Unit.newline {
      result.append(range.location + offset + 1)
    }
    return result
  }
}
