import DailyDoListModels
import Foundation

/// A daily note found among vault paths.
public struct DailyNoteRef: Hashable, Sendable, Codable {
  public var path: String
  public var date: LocalDate

  public init(path: String, date: LocalDate) {
    self.path = path
    self.date = date
  }
}

/// Daily and weekly note paths, port of @ddl/core `daily-notes.ts`. Folders and formats behave
/// like Obsidian's `.obsidian/daily-notes.json`: a trailing slash in the folder is fine and the
/// format may contain `/` for nested folders (`YYYY/MM/YYYY-MM-DD`).
///
/// The core throws when settings would put a note outside the vault (`../` in the folder or
/// format), which the daemon rejects. The `checked…` functions throw the same way; the others
/// never fail and drop the escaping `..` instead, and agree with the core on everything else.
public enum DailyNotes {
  public enum Direction: Int, Sendable {
    case previous = -1
    case next = 1
  }

  public static let defaultFormat = "YYYY-MM-DD"
  public static let defaultWeeklyFormat = "gggg-[W]ww"
  /// Content used for a brand-new daily note when no template exists.
  public static let defaultContent = "- [ ] "

  // MARK: - Paths

  /// `dailyNotePath`: the vault path of the daily note for `date`.
  public static func path(
    for date: LocalDate, settings: DailyNoteSettings, timeZone: TimeZone = .current
  ) -> String {
    if let path = try? checkedPath(for: date, settings: settings, timeZone: timeZone) { return path }
    return notePath(date, folder: settings.folder, format: settings.format, fallback: defaultFormat, timeZone)
  }

  /// `dailyNotePath`, throwing where the core throws.
  public static func checkedPath(
    for date: LocalDate, settings: DailyNoteSettings, timeZone: TimeZone = .current
  ) throws(InvalidPathError) -> String {
    try checkedNotePath(date, folder: settings.folder, format: settings.format, fallback: defaultFormat, timeZone)
  }

  /// `todayDailyNotePath`.
  public static func todayPath(
    settings: DailyNoteSettings, now: Date = Date(), timeZone: TimeZone = .current
  ) -> String {
    path(for: LocalDate(date: now, timeZone: timeZone), settings: settings, timeZone: timeZone)
  }

  /// `weeklyNotePath`: the note of the week containing `date` (default format `gggg-[W]ww`).
  public static func weeklyPath(
    for date: LocalDate, settings: WeeklyNoteSettings, timeZone: TimeZone = .current
  ) -> String {
    if let path = try? checkedWeeklyPath(for: date, settings: settings, timeZone: timeZone) { return path }
    return notePath(date, folder: settings.folder, format: settings.format, fallback: defaultWeeklyFormat, timeZone)
  }

  public static func checkedWeeklyPath(
    for date: LocalDate, settings: WeeklyNoteSettings, timeZone: TimeZone = .current
  ) throws(InvalidPathError) -> String {
    try checkedNotePath(
      date, folder: settings.folder, format: settings.format, fallback: defaultWeeklyFormat, timeZone)
  }

  /// `templateNotePath`: the template note (with `.md`), or nil when there is none. A template
  /// outside the vault (where the core throws) counts as none.
  public static func templatePath(_ template: String) -> String? {
    let trimmed = TextTools.trimmed(template)
    guard !trimmed.isEmpty, let path = try? VaultPath.validated(trimmed) else { return nil }
    return VaultPath.ensureMarkdownExtension(path)
  }

  public static func templatePath(settings: DailyNoteSettings) -> String? {
    templatePath(settings.template)
  }

  // MARK: - Recognizing daily notes

  /// `parseDailyNotePath`: the note's date if `path` is a daily note under the configured folder
  /// and format, nil otherwise. Unicode normalization doesn't matter (macOS may spell a folder
  /// decomposed on disk) and the `.md` extension may have any case.
  public static func date(forPath path: String, settings: DailyNoteSettings) -> LocalDate? {
    let folder = (try? VaultPath.validated(settings.folder)) ?? VaultPath.normalize(settings.folder)
    return parse(path, folder: folder, format: settings.format)
  }

  /// `parseDailyNotePath`, throwing where the core throws (a folder outside the vault).
  public static func checkedDate(
    forPath path: String, settings: DailyNoteSettings
  ) throws(InvalidPathError) -> LocalDate? {
    parse(path, folder: try VaultPath.validated(settings.folder), format: settings.format)
  }

  /// `isDailyNotePath`.
  public static func isDailyNote(_ path: String, settings: DailyNoteSettings) -> Bool {
    date(forPath: path, settings: settings) != nil
  }

  /// `listDailyNotes`: every daily note among `paths`, oldest first (ties keep their order).
  public static func list(paths: some Sequence<String>, settings: DailyNoteSettings) -> [DailyNoteRef] {
    let folder = (try? VaultPath.validated(settings.folder)) ?? VaultPath.normalize(settings.folder)
    let notes = paths.enumerated().compactMap { index, path -> (Int, DailyNoteRef)? in
      parse(path, folder: folder, format: settings.format).map { (index, DailyNoteRef(path: path, date: $0)) }
    }
    return notes.sorted { a, b in
      let order = LocalDate.compare(a.1.date, b.1.date)
      return order != 0 ? order < 0 : a.0 < b.0
    }.map(\.1)
  }

  /// `findAdjacentDailyNote`: Obsidian's "Open previous/next daily note", the nearest EXISTING
  /// daily note strictly before or after `from` (gaps are skipped). Ties keep the first path.
  public static func adjacent(
    paths: some Sequence<String>, from: LocalDate, direction: Direction, settings: DailyNoteSettings
  ) -> (path: String, date: LocalDate)? {
    let folder = (try? VaultPath.validated(settings.folder)) ?? VaultPath.normalize(settings.folder)
    var best: (path: String, date: LocalDate)?
    for path in paths {
      guard let date = parse(path, folder: folder, format: settings.format) else { continue }
      let order = LocalDate.compare(date, from)
      if direction == .previous ? order >= 0 : order <= 0 { continue }
      guard let current = best else {
        best = (path, date)
        continue
      }
      let closer = LocalDate.compare(date, current.date)
      if direction == .previous ? closer > 0 : closer < 0 { best = (path, date) }
    }
    return best
  }

  /// `navigationAnchorDate`: what daily-note navigation is relative to, the open daily note or
  /// else today.
  public static func navigationAnchor(
    activePath: String?, settings: DailyNoteSettings, now: Date = Date(), timeZone: TimeZone = .current
  ) -> LocalDate {
    if let activePath, !activePath.isEmpty, let date = date(forPath: activePath, settings: settings) {
      return date
    }
    return LocalDate(date: now, timeZone: timeZone)
  }

  /// `isWithinWindow`: `date` lies in `[from - pastDays, from + futureDays]`.
  public static func isWithinWindow(_ date: LocalDate, from: LocalDate, pastDays: Int, futureDays: Int) -> Bool {
    LocalDate.compare(date, from.adding(days: -pastDays)) >= 0
      && LocalDate.compare(date, from.adding(days: futureDays)) <= 0
  }

  /// "Wednesday, September 23, 2026" (Gregorian, localized by `locale`).
  public static func friendlyTitle(_ date: LocalDate, locale: Locale = Locale(identifier: "en_US")) -> String {
    let utc = TimeZone(identifier: "UTC")!
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = utc
    let formatter = DateFormatter()
    formatter.calendar = calendar
    formatter.timeZone = utc
    formatter.locale = locale
    formatter.setLocalizedDateFormatFromTemplate("EEEEMMMMdyyyy")
    return formatter.string(from: Date(jsMilliseconds: date.dayNumber * 86_400_000 + 43_200_000))
  }

  /// A daily note's header title: "Thursday, September 24", with the year only when it isn't
  /// `today`'s year ("Monday, December 29, 2025"). English, formatted like the core's
  /// `formatLocalDate`, so the web app shows the same text.
  public static func friendlyTitle(_ date: LocalDate, today: LocalDate) -> String {
    MomentFormat.format(date, date.year == today.year ? "dddd, MMMM D" : "dddd, MMMM D, YYYY")
  }

  // MARK: - Private

  private static func checkedNotePath(
    _ date: LocalDate, folder: String, format: String, fallback: String, _ timeZone: TimeZone
  ) throws(InvalidPathError) -> String {
    let name = MomentFormat.format(date, format.isEmpty ? fallback : format, timeZone: timeZone)
    let normalized = try VaultPath.validated(folder)
    let prefix = normalized.isEmpty ? "" : "\(normalized)/"
    return try VaultPath.validated(prefix + VaultPath.ensureMarkdownExtension(name))
  }

  private static func notePath(
    _ date: LocalDate, folder: String, format: String, fallback: String, _ timeZone: TimeZone
  ) -> String {
    let name = MomentFormat.format(date, format.isEmpty ? fallback : format, timeZone: timeZone)
    return VaultPath.join(VaultPath.normalize(folder), VaultPath.ensureMarkdownExtension(name))
  }

  /// `folder` is already normalized.
  private static func parse(_ path: String, folder: String, format: String) -> LocalDate? {
    guard VaultPath.isMarkdown(path) else { return nil }
    let name = UTF16Buffer(path.nfc)
    let prefix = UTF16Buffer(folder.isEmpty ? "" : "\(folder)/".nfc)
    guard name.units.starts(with: prefix.units) else { return nil }
    let end = Swift.max(prefix.count, name.count - 3)
    let stem = String(utf16Units: Array(name.units[prefix.count..<end]))
    return MomentFormat.parse(stem, format: format.isEmpty ? defaultFormat : format)
  }
}
