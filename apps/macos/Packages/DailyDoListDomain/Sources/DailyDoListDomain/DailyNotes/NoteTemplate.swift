import Foundation

/// Obsidian core-template variables, port of @ddl/core `template.ts`.
public enum NoteTemplate {
  public struct Context: Hashable, Sendable {
    /// Title of the note being created (its file stem).
    public var title: String
    /// The note's date (for daily notes, the day the note represents).
    public var date: LocalDate
    /// Wall-clock time used for `{{time}}` (default: now).
    public var now: Date?
    /// Default format of `{{date}}` (default `YYYY-MM-DD`).
    public var dateFormat: String?
    /// Default format of `{{time}}` (default `HH:mm`).
    public var timeFormat: String?

    public init(
      title: String, date: LocalDate, now: Date? = nil, dateFormat: String? = nil, timeFormat: String? = nil
    ) {
      self.title = title
      self.date = date
      self.now = now
      self.dateFormat = dateFormat
      self.timeFormat = timeFormat
    }
  }

  /// `renderTemplate`: replaces `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}` and
  /// `{{time:FORMAT}}` (names in any case, blanks allowed inside the braces); anything else is left
  /// untouched and substituted text is never expanded again. Times are read in `timeZone`.
  public static func render(_ template: String, context: Context, timeZone: TimeZone = .current) -> String {
    let now = context.now ?? Date()
    let source = UTF16Buffer(template)
    return source.withPointer { p, n in
      var out = UTF16Builder(capacity: n)
      var copied = 0
      var i = 0
      while i < n {
        guard p[i] == 0x7B, let match = variable(at: i, p, n) else {
          i += 1
          continue
        }
        out.append(p, copied..<i)
        let format = match.format.map { String(utf16: p, $0) }
        switch match.name {
        case .title:
          out.append(context.title)
        case .date:
          out.append(
            MomentFormat.format(context.date, format ?? context.dateFormat ?? "YYYY-MM-DD", timeZone: timeZone))
        case .time:
          out.append(
            MomentFormat.format(instant: now, format ?? context.timeFormat ?? "HH:mm", timeZone: timeZone))
        }
        i = match.end
        copied = i
      }
      out.append(p, copied..<n)
      return out.string
    }
  }

  private enum Name { case title, date, time }

  /// Matches `/\{\{\s*(title|date|time)\s*(?::\s*([^}]+?))?\s*}}/i` at `start`, with the regex's
  /// backtracking: the format is the shortest run before `\s*}}`, and a format of only blanks
  /// keeps one blank.
  private static func variable(
    at start: Int, _ p: UnsafePointer<UInt16>, _ n: Int
  ) -> (name: Name, format: Range<Int>?, end: Int)? {
    guard start + 1 < n, p[start] == 0x7B, p[start + 1] == 0x7B else { return nil }
    var i = start + 2
    while i < n && isJSWhitespace(p[i]) { i += 1 }
    var name: Name?
    for (candidate, word) in [(Name.title, "title"), (.date, "date"), (.time, "time")] {
      let units = Array(word.utf16)
      if i + units.count <= n, units.indices.allSatisfy({ p[i + $0] | 0x20 == units[$0] }) {
        name = candidate
        i += units.count
        break
      }
    }
    guard let name else { return nil }
    while i < n && isJSWhitespace(p[i]) { i += 1 }
    if i + 1 < n && p[i] == 0x7D && p[i + 1] == 0x7D { return (name, nil, i + 2) }
    guard i < n, p[i] == 0x3A else { return nil }  // :
    let blanksStart = i + 1
    var afterBlanks = blanksStart
    while afterBlanks < n && isJSWhitespace(p[afterBlanks]) { afterBlanks += 1 }
    var close = afterBlanks
    while close < n && p[close] != 0x7D { close += 1 }
    guard close + 1 < n, p[close + 1] == 0x7D else { return nil }
    // Greedy `\s*` gives back one blank when the format would otherwise be empty.
    let formatStart = close > afterBlanks ? afterBlanks : afterBlanks - 1
    guard formatStart >= blanksStart, formatStart < close else { return nil }
    var formatEnd = close
    while formatEnd > formatStart + 1 && isJSWhitespace(p[formatEnd - 1]) { formatEnd -= 1 }
    return (name, formatStart..<formatEnd, close + 2)
  }
}
