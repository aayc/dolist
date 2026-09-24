import DailyDoListModels
import Foundation

/// A local calendar date (`@ddl/core` `LocalDate`).
struct LocalDate: Hashable, Comparable, Sendable {
  var year: Int
  var month: Int
  var day: Int

  static func < (a: LocalDate, b: LocalDate) -> Bool {
    (a.year, a.month, a.day) < (b.year, b.month, b.day)
  }

  var iso: String { pad(year, 4) + "-" + pad(month, 2) + "-" + pad(day, 2) }

  /// Strict `YYYY-MM-DD` (real calendar dates only).
  init?(iso: String) {
    let parts = iso.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
      parts.allSatisfy({ $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
      let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
      (1...12).contains(month), (1...LocalDate.daysInMonth(year, month)).contains(day)
    else { return nil }
    self.init(year: year, month: month, day: day)
  }

  init(year: Int, month: Int, day: Int) {
    self.year = year
    self.month = month
    self.day = day
  }

  /// Days since 1970-01-01 (proleptic Gregorian).
  var epochDay: Int {
    let y = month <= 2 ? year - 1 : year
    let era = (y >= 0 ? y : y - 399) / 400
    let yoe = y - era * 400
    let mp = (month + 9) % 12
    let doy = (153 * mp + 2) / 5 + day - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468
  }

  init(epochDay: Int) {
    let z = epochDay + 719_468
    let era = (z >= 0 ? z : z - 146_096) / 146_097
    let doe = z - era * 146_097
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let day = doy - (153 * mp + 2) / 5 + 1
    let month = mp < 10 ? mp + 3 : mp - 9
    self.init(year: yoe + era * 400 + (month <= 2 ? 1 : 0), month: month, day: day)
  }

  func adding(days: Int) -> LocalDate { LocalDate(epochDay: epochDay + days) }

  /// 0 = Sunday.
  var weekday: Int { ((epochDay % 7) + 11) % 7 }

  var dayOfYear: Int { epochDay - LocalDate(year: year, month: 1, day: 1).epochDay + 1 }

  static func isLeap(_ year: Int) -> Bool { (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 }

  static func daysInMonth(_ year: Int, _ month: Int) -> Int {
    switch month {
    case 2: isLeap(year) ? 29 : 28
    case 4, 6, 9, 11: 30
    default: 31
    }
  }
}

/// Wall-clock helpers in the fake's time zone, and the Moment-style formatting of `@ddl/core`
/// dates (daily note names, template variables, trash suffixes).
struct FakeCalendar: Sendable {
  let timeZone: TimeZone

  private var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    return calendar
  }

  func localDate(_ date: Date) -> LocalDate {
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return LocalDate(year: parts.year ?? 1970, month: parts.month ?? 1, day: parts.day ?? 1)
  }

  /// Local midnight of `date` (the instant daily-note names format their time tokens from).
  func midnight(_ date: LocalDate) -> Date {
    calendar.date(from: DateComponents(year: date.year, month: date.month, day: date.day)) ?? Date(timeIntervalSince1970: 0)
  }

  func format(_ instant: Date, _ format: String) -> String {
    formatParts(localDate(instant), instant, format)
  }

  func format(_ date: LocalDate, _ format: String) -> String {
    formatParts(date, midnight(date), format)
  }

  private static let months = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December",
  ]
  private static let weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
  /// Same alternation order as `TOKEN_RE` in `@ddl/core` dates.
  private static let tokens = [
    "YYYY", "YY", "gggg", "gg", "GGGG", "GG", "MMMM", "MMM", "MM", "M", "DDDD", "DDD", "Do", "DD",
    "D", "dddd", "ddd", "dd", "d", "E", "e", "ww", "w", "WW", "W", "HH", "H", "hh", "h", "mm", "m",
    "ss", "s", "A", "a", "X", "x",
  ]

  private func formatParts(_ date: LocalDate, _ instant: Date, _ format: String) -> String {
    let characters = Array(format)
    var out = ""
    var index = 0
    let time = calendar.dateComponents([.hour, .minute, .second], from: instant)
    let hour = time.hour ?? 0
    scan: while index < characters.count {
      if characters[index] == "[", let close = characters[(index + 1)...].firstIndex(of: "]") {
        out += String(characters[(index + 1)..<close])
        index = close + 1
        continue
      }
      for token in Self.tokens where Self.hasPrefix(characters, at: index, token) {
        out += value(of: token, date, instant, hour: hour, minute: time.minute ?? 0, second: time.second ?? 0)
        index += token.count
        continue scan
      }
      out.append(characters[index])
      index += 1
    }
    return out
  }

  private static func hasPrefix(_ characters: [Character], at index: Int, _ token: String) -> Bool {
    let token = Array(token)
    guard index + token.count <= characters.count else { return false }
    return Array(characters[index..<(index + token.count)]) == token
  }

  private func value(of token: String, _ date: LocalDate, _ instant: Date, hour: Int, minute: Int, second: Int) -> String {
    switch token {
    case "YYYY": pad(date.year, 4)
    case "YY": pad(date.year % 100, 2)
    case "gggg": pad(Self.weekOfYear(date, dow: 0, doy: 6).year, 4)
    case "gg": pad(Self.weekOfYear(date, dow: 0, doy: 6).year % 100, 2)
    case "GGGG": pad(Self.weekOfYear(date, dow: 1, doy: 4).year, 4)
    case "GG": pad(Self.weekOfYear(date, dow: 1, doy: 4).year % 100, 2)
    case "MMMM": Self.months[date.month - 1]
    case "MMM": String(Self.months[date.month - 1].prefix(3))
    case "MM": pad(date.month, 2)
    case "M": String(date.month)
    case "DDDD": pad(date.dayOfYear, 3)
    case "DDD": String(date.dayOfYear)
    case "Do": Self.ordinal(date.day)
    case "DD": pad(date.day, 2)
    case "D": String(date.day)
    case "dddd": Self.weekdays[date.weekday]
    case "ddd": String(Self.weekdays[date.weekday].prefix(3))
    case "dd": String(Self.weekdays[date.weekday].prefix(2))
    case "d", "e": String(date.weekday)
    case "E": String(date.weekday == 0 ? 7 : date.weekday)
    case "ww": pad(Self.weekOfYear(date, dow: 0, doy: 6).week, 2)
    case "w": String(Self.weekOfYear(date, dow: 0, doy: 6).week)
    case "WW": pad(Self.weekOfYear(date, dow: 1, doy: 4).week, 2)
    case "W": String(Self.weekOfYear(date, dow: 1, doy: 4).week)
    case "HH": pad(hour, 2)
    case "H": String(hour)
    case "hh": pad(hour % 12 == 0 ? 12 : hour % 12, 2)
    case "h": String(hour % 12 == 0 ? 12 : hour % 12)
    case "mm": pad(minute, 2)
    case "m": String(minute)
    case "ss": pad(second, 2)
    case "s": String(second)
    case "A": hour < 12 ? "AM" : "PM"
    case "a": hour < 12 ? "am" : "pm"
    case "X": String(Int(instant.timeIntervalSince1970.rounded(.down)))
    case "x": String(Int((instant.timeIntervalSince1970 * 1000).rounded(.down)))
    default: token
    }
  }

  /// Moment's week-of-year: `dow` = first day of week, `doy` defines week 1 (ISO: 1/4, en: 0/6).
  static func weekOfYear(_ date: LocalDate, dow: Int, doy: Int) -> (week: Int, year: Int) {
    let offset = firstWeekOffset(date.year, dow: dow, doy: doy)
    let week = Int((Double(date.dayOfYear - offset - 1) / 7).rounded(.down)) + 1
    if week < 1 {
      return (week + weeksInYear(date.year - 1, dow: dow, doy: doy), date.year - 1)
    }
    let inYear = weeksInYear(date.year, dow: dow, doy: doy)
    return week > inYear ? (week - inYear, date.year + 1) : (week, date.year)
  }

  private static func firstWeekOffset(_ year: Int, dow: Int, doy: Int) -> Int {
    let fwd = 7 + dow - doy
    let fwdlw = (7 + LocalDate(year: year, month: 1, day: 1).adding(days: fwd - 1).weekday - dow) % 7
    return -fwdlw + fwd - 1
  }

  private static func weeksInYear(_ year: Int, dow: Int, doy: Int) -> Int {
    let days = LocalDate.isLeap(year) ? 366 : 365
    return (days - firstWeekOffset(year, dow: dow, doy: doy) + firstWeekOffset(year + 1, dow: dow, doy: doy)) / 7
  }

  private static func ordinal(_ n: Int) -> String {
    if (11...13).contains(n % 100) { return "\(n)th" }
    switch n % 10 {
    case 1: return "\(n)st"
    case 2: return "\(n)nd"
    case 3: return "\(n)rd"
    default: return "\(n)th"
    }
  }

  // MARK: - Daily notes & templates

  /// `@ddl/core` `DEFAULT_DAILY_NOTE_CONTENT`.
  static let defaultDailyNoteContent = "- [ ] "

  /// `dailyNotePath`: `<folder>/<format>.md`, normalized (throws when it escapes the vault).
  func dailyNotePath(_ date: LocalDate, _ settings: DailyNoteSettings) throws(FakeVaultPaths.EscapeError) -> String {
    let folder = try FakeVaultPaths.normalize(settings.folder)
    let name = format(date, settings.format.isEmpty ? "YYYY-MM-DD" : settings.format)
    return try FakeVaultPaths.normalize((folder.isEmpty ? "" : folder + "/") + FakeVaultPaths.ensureMarkdownExtension(name))
  }

  func weeklyNotePath(_ date: LocalDate, _ settings: WeeklyNoteSettings) throws(FakeVaultPaths.EscapeError) -> String {
    let folder = try FakeVaultPaths.normalize(settings.folder)
    let name = format(date, settings.format.isEmpty ? "gggg-[W]ww" : settings.format)
    return try FakeVaultPaths.normalize((folder.isEmpty ? "" : folder + "/") + FakeVaultPaths.ensureMarkdownExtension(name))
  }

  /// `templateNotePath`: nil when no template is configured.
  static func templateNotePath(_ template: String) throws(FakeVaultPaths.EscapeError) -> String? {
    let trimmed = template.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    return FakeVaultPaths.ensureMarkdownExtension(try FakeVaultPaths.normalize(trimmed))
  }

  private static let templateVariable = try? NSRegularExpression(
    pattern: #"\{\{\s*(title|date|time)\s*(?::\s*([^}]+?))?\s*\}\}"#, options: [.caseInsensitive])

  /// Obsidian core-template variables: `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}`,
  /// `{{time:FORMAT}}`; anything else is left untouched.
  func renderTemplate(_ template: String, title: String, date: LocalDate, now: Date) -> String {
    guard let regex = Self.templateVariable else { return template }
    let source = template as NSString
    var out = ""
    var cursor = 0
    for match in regex.matches(in: template, range: NSRange(location: 0, length: source.length)) {
      out += source.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
      let name = source.substring(with: match.range(at: 1)).lowercased()
      let custom = match.range(at: 2).location == NSNotFound ? nil : source.substring(with: match.range(at: 2))
      switch name {
      case "title": out += title
      case "date": out += format(date, custom ?? "YYYY-MM-DD")
      default: out += format(now, custom ?? "HH:mm")
      }
      cursor = match.range.location + match.range.length
    }
    out += source.substring(from: cursor)
    return out
  }
}

private func pad(_ value: Int, _ width: Int) -> String {
  let digits = String(abs(value))
  return (value < 0 ? "-" : "") + String(repeating: "0", count: max(0, width - digits.count)) + digits
}
