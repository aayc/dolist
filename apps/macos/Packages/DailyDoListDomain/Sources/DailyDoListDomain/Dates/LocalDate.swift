import Foundation

/// A calendar date in the user's local time zone (daily notes are never UTC). Port of `LocalDate`
/// and the calendar helpers of @ddl/core `dates.ts`: arithmetic is pure proleptic Gregorian day
/// counting, so DST and skipped days never matter, and out-of-range fields roll over like
/// JavaScript's `Date.UTC` (month 13 of 2026 is January 2027).
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

  // MARK: - Calendar arithmetic

  /// Days since 1970-01-01 (negative before). Out-of-range fields roll over.
  public var dayNumber: Int {
    CivilCalendar.dayNumber(year: year, month: month, day: day)
  }

  public init(dayNumber: Int) {
    let d = CivilCalendar.date(fromDayNumber: dayNumber)
    self.init(year: d.year, month: d.month, day: d.day)
  }

  /// `addDays`: calendar arithmetic, not clock arithmetic.
  public func adding(days: Int) -> LocalDate {
    LocalDate(dayNumber: dayNumber + days)
  }

  /// Same as `adding(days:)`; calendar arithmetic doesn't depend on the calendar or time zone.
  public func adding(days: Int, calendar: Calendar) -> LocalDate {
    adding(days: days)
  }

  /// `daysBetween(a, b)`: whole days from `a` to `b` (positive when `b` is later).
  public static func daysBetween(_ a: LocalDate, _ b: LocalDate) -> Int {
    b.dayNumber - a.dayNumber
  }

  /// Whole days from this date to `other`.
  public func days(to other: LocalDate) -> Int {
    other.dayNumber - dayNumber
  }

  /// `isValidLocalDate`: a real calendar date (any year, including 0 and negative years).
  public var isValid: Bool {
    month >= 1 && month <= 12 && day >= 1
      && day <= CivilCalendar.daysInMonth(year: year, month: month)
  }

  /// 0 = Sunday … 6 = Saturday.
  public var weekday: Int {
    CivilCalendar.weekday(dayNumber: dayNumber)
  }

  /// 1-based day of the year.
  public var dayOfYear: Int {
    dayNumber - CivilCalendar.dayNumber(year: year, month: 1, day: 1) + 1
  }

  /// `compareLocalDates`: field by field, like the `Comparable` order.
  public static func compare(_ a: LocalDate, _ b: LocalDate) -> Int {
    if a.year != b.year { return a.year < b.year ? -1 : 1 }
    if a.month != b.month { return a.month < b.month ? -1 : 1 }
    if a.day != b.day { return a.day < b.day ? -1 : 1 }
    return 0
  }

  public static func < (a: LocalDate, b: LocalDate) -> Bool {
    (a.year, a.month, a.day) < (b.year, b.month, b.day)
  }

  // MARK: - ISO 8601

  /// `toISODate`: `YYYY-MM-DD` (zero padding follows JavaScript's `padStart`).
  public var isoString: String {
    "\(jsPad(year, 4))-\(jsPad(month, 2))-\(jsPad(day, 2))"
  }

  /// `parseISODate`: exactly `\d{4}-\d{2}-\d{2}` (ASCII digits) naming a real date.
  public init?(iso: String) {
    let units = Array(iso.utf16)
    guard units.count == 10, units[4] == 0x2D, units[7] == 0x2D else { return nil }
    func number(_ range: Range<Int>) -> Int? {
      var value = 0
      for u in units[range] {
        guard isASCIIDigit(u) else { return nil }
        value = value * 10 + Int(u - 0x30)
      }
      return value
    }
    guard let y = number(0..<4), let m = number(5..<7), let d = number(8..<10) else { return nil }
    let date = LocalDate(year: y, month: m, day: d)
    guard date.isValid else { return nil }
    self = date
  }

  public var description: String { isoString }

  // MARK: - Instants

  /// `toLocalDate`: the calendar date of `date` on the wall clock of `timeZone`.
  public init(date: Date, timeZone: TimeZone) {
    let ms = date.jsMilliseconds
    let offset = timeZone.secondsFromGMT(for: date) * 1000
    self.init(dayNumber: floorDiv(ms + offset, 86_400_000))
  }

  /// The calendar date of `date` in the calendar's time zone (Gregorian, whatever the calendar).
  public init(date: Date, calendar: Calendar = .current) {
    self.init(date: date, timeZone: calendar.timeZone)
  }

  /// `today(now)` on the wall clock of the calendar's time zone.
  public static func today(now: Date = Date(), calendar: Calendar = .current) -> LocalDate {
    LocalDate(date: now, timeZone: calendar.timeZone)
  }

  public static func today(now: Date = Date(), timeZone: TimeZone) -> LocalDate {
    LocalDate(date: now, timeZone: timeZone)
  }

  /// `fromLocalDate`: local midnight in `timeZone`. Where a clock change skips midnight this is
  /// the first instant after the gap (01:00), exactly as JavaScript resolves it.
  public func startOfDay(in timeZone: TimeZone = .current) -> Date {
    Date(jsMilliseconds: startOfDayMilliseconds(in: timeZone))
  }

  /// Local noon in the calendar's time zone: a safe instant for APIs that want a `Date`.
  public func date(calendar: Calendar = .current) -> Date {
    let noon = dayNumber * 86_400_000 + 43_200_000
    return Date(jsMilliseconds: utcMilliseconds(fromLocal: noon, in: calendar.timeZone))
  }

  func startOfDayMilliseconds(in timeZone: TimeZone) -> Int {
    utcMilliseconds(fromLocal: dayNumber * 86_400_000, in: timeZone)
  }
}

/// ECMAScript's `UTC(t)`: the instant at which the wall clock of `timeZone` reads `localMs`. A
/// time skipped by a clock change is read with the offset from before the change (00:00 in a
/// spring-forward gap becomes 01:00); a repeated time resolves to its earlier instant.
func utcMilliseconds(fromLocal localMs: Int, in timeZone: TimeZone) -> Int {
  func offset(atUTC ms: Int) -> Int {
    timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: Double(floorDiv(ms, 1000)))) * 1000
  }
  let before = offset(atUTC: localMs - 86_400_000)
  var earliest: Int?
  for candidate in [before, offset(atUTC: localMs), offset(atUTC: localMs + 86_400_000)] {
    let instant = localMs - candidate
    if offset(atUTC: instant) == candidate, earliest.map({ instant < $0 }) ?? true {
      earliest = instant
    }
  }
  return earliest ?? localMs - before
}

extension Date {
  /// Whole milliseconds since the epoch, like a JavaScript `Date` built from this instant.
  var jsMilliseconds: Int {
    let scaled = timeIntervalSince1970 * 1000
    let nearest = scaled.rounded()
    return Int(abs(scaled - nearest) < 1e-3 ? nearest : scaled.rounded(.down))
  }

  init(jsMilliseconds ms: Int) {
    self.init(timeIntervalSince1970: Double(ms) / 1000)
  }
}
