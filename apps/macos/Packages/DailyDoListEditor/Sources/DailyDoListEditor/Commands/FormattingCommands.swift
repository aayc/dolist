import Foundation

/// Inline formatting toggles (⌘B, ⌘I, …) and link insertion (⌘K), ported from the web editor. A
/// toggle acts on the selection, or on the word at the caret: markup already around the text is
/// removed, otherwise it is added (an empty spot gets a marker pair with the caret inside).
enum FormattingCommands {
  struct MarkupStyle: Sendable {
    var character: UInt16
    var width: Int
    /// Characters to strip on each side given the marker run around the text (0 = not applied).
    var strip: @Sendable (Int) -> Int

    static let bold = MarkupStyle(character: UTF16Unit.asterisk, width: 2) { $0 >= 2 ? 2 : 0 }
    /// A run of 3 is bold + italic; a run of 2 is bold only, so italic is not active there.
    static let italic = MarkupStyle(character: UTF16Unit.asterisk, width: 1) { $0 == 1 || $0 == 3 ? 1 : 0 }
    static let strikethrough = MarkupStyle(character: UTF16Unit.tilde, width: 2) { $0 >= 2 ? 2 : 0 }
    static let highlight = MarkupStyle(character: UTF16Unit.equals, width: 2) { $0 >= 2 ? 2 : 0 }
    static let inlineCode = MarkupStyle(character: UTF16Unit.backtick, width: 1) { $0 >= 1 ? 1 : 0 }
  }

  private static let maxRun = 3

  static func toggle(_ style: MarkupStyle, in text: NSString, selection: [NSRange]) -> TextEdit {
    var replacements: [TextEdit.Replacement] = []
    var selections: [NSRange] = []
    var delta = 0
    for range in selection.sorted(by: { $0.location < $1.location }) {
      let (changes, local) = toggleRange(style, text: text, range: range)
      let ownDelta = changes.reduce(0) { $0 + ($1.text as NSString).length - $1.range.length }
      replacements += changes
      selections.append(local.shifted(by: delta))
      delta += ownDelta
    }
    return TextEdit(replacements: replacements.sorted { $0.range.location < $1.range.location }, selection: selections)
  }

  /// Changes for one range, and the range's selection after its own changes.
  private static func toggleRange(
    _ style: MarkupStyle, text: NSString, range: NSRange
  ) -> ([TextEdit.Replacement], NSRange) {
    let marker = String(repeating: String(utf16Units: [style.character][...]), count: style.width)
    let word = range.length == 0 ? wordRange(in: text, at: range.location) : nil
    let from = word?.location ?? range.location
    let to = word?.end ?? range.end

    if range.length > 0 {
      let units = text.utf16Units(in: NSRange(from, to))
      let run = min(leadingRun(units, style.character), trailingRun(units, style.character), maxRun)
      let inner = style.strip(run)
      if inner > 0, units.count > inner * 2 {
        return (
          [
            TextEdit.Replacement(range: NSRange(location: from, length: inner), text: ""),
            TextEdit.Replacement(range: NSRange(location: to - inner, length: inner), text: ""),
          ],
          NSRange(from, to - inner * 2)
        )
      }
    }

    let strip = style.strip(surroundingRun(text, from: from, to: to, character: style.character))
    if strip > 0 {
      return (
        [
          TextEdit.Replacement(range: NSRange(location: from - strip, length: strip), text: ""),
          TextEdit.Replacement(range: NSRange(location: to, length: strip), text: ""),
        ],
        NSRange(location: range.location - strip, length: range.length)
      )
    }
    if from == to {
      return (
        [TextEdit.Replacement(range: NSRange(location: from, length: 0), text: marker + marker)],
        NSRange(location: from + style.width, length: 0)
      )
    }
    return (
      [
        TextEdit.Replacement(range: NSRange(location: from, length: 0), text: marker),
        TextEdit.Replacement(range: NSRange(location: to, length: 0), text: marker),
      ],
      NSRange(location: range.location + style.width, length: range.length)
    )
  }

  /// ⌘K: selected text becomes `[text](|)`, a selected URL `[|](url)`, and an empty selection
  /// inserts `[|]()`.
  static func insertLink(in text: NSString, selection: [NSRange]) -> TextEdit {
    var replacements: [TextEdit.Replacement] = []
    var selections: [NSRange] = []
    var delta = 0
    for range in selection.sorted(by: { $0.location < $1.location }) {
      let selected = text.substring(with: range.clamped(to: text.length))
      let replacement: TextEdit.Replacement
      let caret: Int
      if range.length == 0 {
        replacement = TextEdit.Replacement(range: range, text: "[]()")
        caret = range.location + 1
      } else if let url = urlLike(selected) {
        let lead = (selected as NSString).length - (selected.drop { $0.isWhitespace } as Substring).utf16.count
        let start = range.location + lead
        replacement = TextEdit.Replacement(range: NSRange(location: start, length: (url as NSString).length), text: "[](\(url))")
        caret = start + 1
      } else {
        replacement = TextEdit.Replacement(range: range, text: "[\(selected)]()")
        caret = range.location + (selected as NSString).length + 3
      }
      replacements.append(replacement)
      selections.append(NSRange(location: caret + delta, length: 0))
      delta += (replacement.text as NSString).length - replacement.range.length
    }
    return TextEdit(replacements: replacements, selection: selections)
  }

  private static func urlLike(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, !trimmed.contains(where: \.isWhitespace) else { return nil }
    let lower = trimmed.lowercased()
    if lower.hasPrefix("www.") || lower.hasPrefix("mailto:") { return trimmed }
    guard let schemeEnd = lower.range(of: "://") else { return nil }
    let scheme = lower[..<schemeEnd.lowerBound]
    let units = Array(scheme.utf16)
    guard let first = units.first, CharClass.isASCIILetter(first),
      units.allSatisfy({ CharClass.isASCIIAlphanumeric($0) || $0 == UTF16Unit.plus || $0 == UTF16Unit.dot || $0 == UTF16Unit.dash }),
      trimmed.utf16.count > units.count + 3
    else { return nil }
    return trimmed
  }

  /// The word touching `offset` (letters, digits, `_`), or nil.
  static func wordRange(in text: NSString, at offset: Int) -> NSRange? {
    var start = offset
    while start > 0, CharClass.isWordCharacter(text.character(at: start - 1)) { start -= 1 }
    var end = offset
    while end < text.length, CharClass.isWordCharacter(text.character(at: end)) { end += 1 }
    return end > start ? NSRange(start, end) : nil
  }

  private static func leadingRun(_ units: [UInt16], _ c: UInt16) -> Int {
    units.prefix { $0 == c }.count
  }

  private static func trailingRun(_ units: [UInt16], _ c: UInt16) -> Int {
    units.reversed().prefix { $0 == c }.count
  }

  /// Length of the marker run directly around `[from, to)` on both sides (same line only).
  private static func surroundingRun(_ text: NSString, from: Int, to: Int, character: UInt16) -> Int {
    var before = 0
    while before < maxRun, from - before - 1 >= 0 {
      let c = text.character(at: from - before - 1)
      guard c == character else { break }
      before += 1
    }
    var after = 0
    while after < maxRun, to + after < text.length {
      let c = text.character(at: to + after)
      guard c == character else { break }
      after += 1
    }
    return min(before, after, maxRun)
  }
}
