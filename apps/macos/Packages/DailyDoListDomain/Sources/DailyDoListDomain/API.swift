import DailyDoListModels
import Foundation

// Public API of the domain package. (Initial minimal implementations — replaced by full ports of
// @ddl/core verified against generated vectors.)

// MARK: - Local dates

/// A calendar date in the user's local time zone (daily notes are never UTC).
public struct LocalDate: Hashable, Comparable, Sendable, Codable, CustomStringConvertible {
  public var year: Int
  /// 1-12
  public var month: Int
  /// 1-31
  public var day: Int

  public init(year: Int, month: Int, day: Int) {
    self.year = year
    self.month = month
    self.day = day
  }

  public init(date: Date, calendar: Calendar = .current) {
    let c = calendar.dateComponents([.year, .month, .day], from: date)
    self.init(year: c.year!, month: c.month!, day: c.day!)
  }

  public static func today(now: Date = Date(), calendar: Calendar = .current) -> LocalDate {
    LocalDate(date: now, calendar: calendar)
  }

  /// Local noon of this date (safe from DST edges).
  public func date(calendar: Calendar = .current) -> Date {
    calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12))!
  }

  public func adding(days: Int, calendar: Calendar = .current) -> LocalDate {
    LocalDate(date: calendar.date(byAdding: .day, value: days, to: date(calendar: calendar))!, calendar: calendar)
  }

  /// `YYYY-MM-DD`
  public var isoString: String { String(format: "%04d-%02d-%02d", year, month, day) }

  public init?(iso: String) {
    let parts = iso.split(separator: "-")
    guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
      let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
      (1...12).contains(m), (1...31).contains(d)
    else { return nil }
    self.init(year: y, month: m, day: d)
  }

  public var description: String { isoString }

  public static func < (a: LocalDate, b: LocalDate) -> Bool {
    (a.year, a.month, a.day) < (b.year, b.month, b.day)
  }
}

// MARK: - Moment-style formatting

public enum MomentFormat {
  /// Formats with Moment tokens (`YYYY-MM-DD`, `dddd, MMMM Do`, `gggg-[W]ww`, …).
  public static func format(_ date: LocalDate, _ format: String) -> String {
    format
      .replacingOccurrences(of: "YYYY", with: String(format: "%04d", date.year))
      .replacingOccurrences(of: "MM", with: String(format: "%02d", date.month))
      .replacingOccurrences(of: "DD", with: String(format: "%02d", date.day))
  }

  /// Strict parse; nil when `string` does not match `format` exactly.
  public static func parse(_ string: String, format: String) -> LocalDate? {
    format == "YYYY-MM-DD" ? LocalDate(iso: string) : nil
  }
}

// MARK: - Daily notes

public enum DailyNotes {
  public enum Direction: Int, Sendable {
    case previous = -1
    case next = 1
  }

  public static func path(for date: LocalDate, settings: DailyNoteSettings) -> String {
    let name = MomentFormat.format(date, settings.format.isEmpty ? "YYYY-MM-DD" : settings.format)
    let folder = VaultPath.normalize(settings.folder)
    return VaultPath.join(folder, name.hasSuffix(".md") ? name : "\(name).md")
  }

  public static func date(forPath path: String, settings: DailyNoteSettings) -> LocalDate? {
    guard VaultPath.isMarkdown(path) else { return nil }
    let folder = VaultPath.normalize(settings.folder)
    let prefix = folder.isEmpty ? "" : "\(folder)/"
    guard path.hasPrefix(prefix) else { return nil }
    let name = String(path.dropFirst(prefix.count).dropLast(3))
    return MomentFormat.parse(name, format: settings.format.isEmpty ? "YYYY-MM-DD" : settings.format)
  }

  public static func isDailyNote(_ path: String, settings: DailyNoteSettings) -> Bool {
    date(forPath: path, settings: settings) != nil
  }

  /// Obsidian's previous/next daily note: the nearest EXISTING note before/after `from`.
  public static func adjacent(
    paths: some Sequence<String>, from: LocalDate, direction: Direction, settings: DailyNoteSettings
  ) -> (path: String, date: LocalDate)? {
    var best: (path: String, date: LocalDate)?
    for path in paths {
      guard let date = date(forPath: path, settings: settings) else { continue }
      let isCandidate = direction == .previous ? date < from : date > from
      guard isCandidate else { continue }
      if let current = best {
        if direction == .previous ? date > current.date : date < current.date { best = (path, date) }
      } else {
        best = (path, date)
      }
    }
    return best
  }

  /// The date navigation is relative to: the open daily note, else today.
  public static func navigationAnchor(activePath: String?, settings: DailyNoteSettings, now: Date = Date()) -> LocalDate {
    if let activePath, let date = date(forPath: activePath, settings: settings) { return date }
    return .today(now: now)
  }

  public static func weeklyPath(for date: LocalDate, settings: WeeklyNoteSettings) -> String {
    let name = MomentFormat.format(date, settings.format.isEmpty ? "gggg-[W]ww" : settings.format)
    return VaultPath.join(VaultPath.normalize(settings.folder), "\(name).md")
  }

  /// "Wednesday, September 23, 2026"
  public static func friendlyTitle(_ date: LocalDate, locale: Locale = Locale(identifier: "en_US")) -> String {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.dateFormat = "EEEE, MMMM d, yyyy"
    return formatter.string(from: date.date())
  }
}

// MARK: - Vault paths

public enum VaultPath {
  /// Canonical vault form: POSIX separators, no leading slash, no `.` segments; `..` pops.
  public static func normalize(_ path: String) -> String {
    var out: [Substring] = []
    for segment in path.replacingOccurrences(of: "\\", with: "/").split(separator: "/") {
      if segment == "." || segment.isEmpty { continue }
      if segment == ".." { if !out.isEmpty { out.removeLast() }; continue }
      out.append(segment)
    }
    return out.joined(separator: "/")
  }

  public static func join(_ parts: String...) -> String {
    normalize(parts.filter { !$0.isEmpty }.joined(separator: "/"))
  }

  public static func dirname(_ path: String) -> String {
    guard let slash = path.lastIndex(of: "/") else { return "" }
    return String(path[..<slash])
  }

  public static func basename(_ path: String) -> String {
    guard let slash = path.lastIndex(of: "/") else { return path }
    return String(path[path.index(after: slash)...])
  }

  /// Extension including the dot (`.md`), or "".
  public static func extname(_ path: String) -> String {
    let base = basename(path)
    guard let dot = base.lastIndex(of: "."), dot != base.startIndex else { return "" }
    return String(base[dot...])
  }

  /// File name without extension.
  public static func stem(_ path: String) -> String {
    let base = basename(path)
    let ext = extname(base)
    return ext.isEmpty ? base : String(base.dropLast(ext.count))
  }

  public static func isMarkdown(_ path: String) -> Bool { extname(path).lowercased() == ".md" }

  public static func isHidden(_ path: String) -> Bool {
    path.split(separator: "/").contains { $0.hasPrefix(".") }
  }
}

// MARK: - Tasks

public enum TaskStatus: String, Sendable, Hashable, Codable {
  case open, done, inProgress = "in_progress", cancelled, deferred, other
}

/// A markdown checkbox task. Offsets are UTF-16 code units (same as JavaScript and NSString).
public struct ParsedTask: Hashable, Sendable {
  public var line: Int
  public var indent: Int
  public var depth: Int
  public var marker: String
  public var statusChar: String
  public var status: TaskStatus
  public var text: String
  public var raw: String
  public var from: Int
  public var to: Int
  public var textFrom: Int
  public var parentLine: Int?
  public var notes: [String]
  public var links: [String]

  public init(
    line: Int, indent: Int, depth: Int, marker: String, statusChar: String, status: TaskStatus,
    text: String, raw: String, from: Int, to: Int, textFrom: Int, parentLine: Int?,
    notes: [String], links: [String]
  ) {
    self.line = line
    self.indent = indent
    self.depth = depth
    self.marker = marker
    self.statusChar = statusChar
    self.status = status
    self.text = text
    self.raw = raw
    self.from = from
    self.to = to
    self.textFrom = textFrom
    self.parentLine = parentLine
    self.notes = notes
    self.links = links
  }
}

public enum TaskParser {
  /// Every checkbox task in the document (skips frontmatter and fenced code).
  public static func parse(_ markdown: String) -> [ParsedTask] {
    var tasks: [ParsedTask] = []
    var offset = 0
    for (index, line) in markdown.components(separatedBy: "\n").enumerated() {
      let length = (line as NSString).length
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.hasPrefix("- [") && trimmed.count >= 5 {
        let chars = Array(trimmed)
        let statusChar = String(chars[3])
        let text = String(trimmed.dropFirst(5)).trimmingCharacters(in: .whitespaces)
        let status: TaskStatus = statusChar == " " ? .open : (statusChar.lowercased() == "x" ? .done : .other)
        tasks.append(
          ParsedTask(
            line: index, indent: 0, depth: 0, marker: "-", statusChar: statusChar, status: status,
            text: text, raw: line, from: offset, to: offset + length, textFrom: offset + length - (text as NSString).length,
            parentLine: nil, notes: [], links: []))
      }
      offset += length + 1
    }
    return tasks
  }

  /// Toggles `[ ]` ↔ `[x]` on a task line; other lines unchanged.
  public static func toggleLine(_ line: String) -> String {
    if line.contains("- [ ]") { return line.replacingOccurrences(of: "- [ ]", with: "- [x]") }
    if line.contains("- [x]") { return line.replacingOccurrences(of: "- [x]", with: "- [ ]") }
    return line
  }
}

/// Minimal reference to a server-tracked task, enough to re-find it in an edited document.
public struct TaskAnchor: Hashable, Sendable {
  public var taskId: String
  public var text: String
  public var line: Int

  public init(taskId: String, text: String, line: Int) {
    self.taskId = taskId
    self.text = text
    self.line = line
  }
}

public enum TaskAnchors {
  /// taskId → current 0-based line, using the same identity algorithm as the daemon.
  public static func resolve(_ doc: String, anchors: [TaskAnchor]) -> [String: Int] {
    let tasks = TaskParser.parse(doc)
    var out: [String: Int] = [:]
    for anchor in anchors {
      if let task = tasks.first(where: { $0.text == anchor.text }) { out[anchor.taskId] = task.line }
    }
    return out
  }
}

// MARK: - Fuzzy matching

public struct FuzzyMatch: Hashable, Sendable {
  /// Higher is better.
  public var score: Double
  /// Matched character offsets in the candidate (UTF-16), for highlighting.
  public var matchedOffsets: [Int]

  public init(score: Double, matchedOffsets: [Int]) {
    self.score = score
    self.matchedOffsets = matchedOffsets
  }
}

public enum Fuzzy {
  /// Subsequence match of `query` in `candidate` (case-insensitive); nil when it doesn't match.
  public static func match(_ query: String, in candidate: String) -> FuzzyMatch? {
    if query.isEmpty { return FuzzyMatch(score: 0, matchedOffsets: []) }
    return candidate.localizedCaseInsensitiveContains(query) ? FuzzyMatch(score: 1, matchedOffsets: []) : nil
  }
}
