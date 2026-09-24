import Foundation

/// Agent badges anchored to the start of their line and remapped through every edit until the host
/// sends fresh badges (same model as the web editor's annotation field).
///
/// - Lines inserted or deleted above a badge shift it; editing inside its line keeps it.
/// - Enter at the start of the badge's line moves the badge down with the line's text; Enter at its
///   end leaves it on the task.
/// - An edit that removes the line's entire content (delete line, cut, select + retype) drops the
///   badge, unless the same edit inserts that exact line again (e.g. a whole-document replacement).
struct BadgeStore: Sendable {
  struct Item: Equatable, Sendable {
    var badge: EditorBadge
    /// Start of the badge's line.
    var anchor: Int
    /// End of the line's content (before its `\n`).
    var lineEnd: Int
    /// The line's content, to recognize it again after a replacement that covers it.
    var lineText: String
  }

  /// Sorted by anchor.
  private(set) var items: [Item] = []

  var isEmpty: Bool { items.isEmpty }

  mutating func set(_ badges: [EditorBadge], lineIndex: LineIndex, text: NSString) {
    items = badges.compactMap { badge in
      guard badge.line >= 0, badge.line < lineIndex.count else { return nil }
      let content = lineIndex.contentRange(ofLine: badge.line, textLength: text.length)
      return Item(
        badge: badge, anchor: content.location, lineEnd: content.end,
        lineText: text.substring(with: content))
    }
    sortStably()
  }

  mutating func removeAll() {
    items.removeAll()
  }

  /// Maps anchors through the replacement of `oldLength` units at `location` by `newLength` units.
  /// `lineIndex` and `text` are already updated.
  mutating func applyEdit(
    location s: Int, oldLength: Int, newLength: Int, lineIndex: LineIndex, text: NSString
  ) {
    guard !items.isEmpty else { return }
    let e = s + oldLength
    let delta = newLength - oldLength
    var reinserted: [String: [Int]]?
    var reordered = false
    var result: [Item] = []
    result.reserveCapacity(items.count)
    for var item in items {
      if item.anchor > e {
        item.anchor += delta
        item.lineEnd += delta
        result.append(item)
        continue
      }
      if item.lineEnd < s {
        result.append(item)
        continue
      }
      if oldLength > 0, s <= item.anchor, e >= item.lineEnd {
        reinserted =
          reinserted
          ?? Self.insertedLines(
            in: NSRange(location: s, length: newLength), lineIndex: lineIndex, text: text)
        guard let at = reinserted?[item.lineText]?.first else { continue }
        reinserted?[item.lineText]?.removeFirst()
        let content = lineIndex.contentRange(
          ofLine: lineIndex.line(containing: at), textLength: text.length)
        item.anchor = content.location
        item.lineEnd = content.end
        reordered = true
        result.append(item)
        continue
      }
      let mapped = item.anchor < s ? item.anchor : s + newLength
      let content = lineIndex.contentRange(
        ofLine: lineIndex.line(containing: mapped), textLength: text.length)
      if content.location != item.anchor { reordered = true }
      item.anchor = content.location
      item.lineEnd = content.end
      item.lineText = text.substring(with: content)
      result.append(item)
    }
    items = result
    if reordered { sortStably() }
  }

  /// Badges with their current (mapped) 0-based lines.
  func currentBadges(lineIndex: LineIndex) -> [EditorBadge] {
    items.map { item in
      var badge = item.badge
      badge.line = lineIndex.line(containing: item.anchor)
      return badge
    }
  }

  private mutating func sortStably() {
    items = items.enumerated()
      .sorted { ($0.element.anchor, $0.offset) < ($1.element.anchor, $1.offset) }
      .map(\.element)
  }

  /// Start offsets of the non-blank whole lines lying inside `range` of the new text, by content.
  private static func insertedLines(in range: NSRange, lineIndex: LineIndex, text: NSString)
    -> [String: [Int]]
  {
    guard range.length > 0 else { return [:] }
    var result: [String: [Int]] = [:]
    let first = lineIndex.line(containing: range.location)
    let last = lineIndex.line(containing: range.end)
    for line in first...last {
      let content = lineIndex.contentRange(ofLine: line, textLength: text.length)
      guard content.location >= range.location, content.end <= range.end, content.length > 0 else {
        continue
      }
      let lineText = text.substring(with: content)
      guard !lineText.allSatisfy(\.isWhitespace) else { continue }
      result[lineText, default: []].append(content.location)
    }
    return result
  }
}
