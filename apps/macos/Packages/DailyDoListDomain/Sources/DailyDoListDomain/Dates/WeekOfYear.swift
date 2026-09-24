/// A week number and the week-based year it belongs to (which differs from the calendar year for
/// the first and last days of a year).
public struct WeekOfYear: Hashable, Sendable, Codable {
  public var week: Int
  public var year: Int

  public init(week: Int, year: Int) {
    self.week = week
    self.year = year
  }
}

extension MomentFormat {
  /// Week of the year using Moment's algorithm: `dow` is the first day of the week (0 = Sunday)
  /// and `doy` fixes which January day is always in week 1 (`7 + dow - doy`). ISO 8601 is
  /// `dow: 1, doy: 4`; Moment's default "en" locale (Obsidian's `gggg-[W]ww`) is `dow: 0, doy: 6`.
  public static func weekOfYear(_ date: LocalDate, dow: Int, doy: Int) -> WeekOfYear {
    let offset = firstWeekOffset(year: date.year, dow: dow, doy: doy)
    let week = floorDiv(date.dayOfYear - offset - 1, 7) + 1
    if week < 1 {
      let year = date.year - 1
      return WeekOfYear(week: week + weeksInYear(year, dow: dow, doy: doy), year: year)
    }
    let inYear = weeksInYear(date.year, dow: dow, doy: doy)
    if week > inYear { return WeekOfYear(week: week - inYear, year: date.year + 1) }
    return WeekOfYear(week: week, year: date.year)
  }

  /// ISO 8601 week (`WW` / `GGGG`): weeks start on Monday and belong to the year of their Thursday.
  public static func isoWeek(_ date: LocalDate) -> WeekOfYear {
    weekOfYear(date, dow: 1, doy: 4)
  }

  /// Moment "en" week (`ww` / `gggg`): weeks start on Sunday; the week of January 1st is week 1.
  public static func localeWeek(_ date: LocalDate) -> WeekOfYear {
    weekOfYear(date, dow: 0, doy: 6)
  }

  /// The first day of `week` in `weekYear` (or its `weekday`, 0 = Sunday), nil if the year has no
  /// such week.
  static func weekDate(weekYear: Int, week: Int, iso: Bool, weekday: Int?) -> LocalDate? {
    let dow = iso ? 1 : 0
    let doy = iso ? 4 : 6
    guard week >= 1, week <= weeksInYear(weekYear, dow: dow, doy: doy) else { return nil }
    let start = LocalDate(year: weekYear, month: 1, day: 1)
      .adding(days: firstWeekOffset(year: weekYear, dow: dow, doy: doy) + (week - 1) * 7)
    guard let weekday else { return start }
    return start.adding(days: (weekday - dow + 7) % 7)
  }

  static func firstWeekOffset(year: Int, dow: Int, doy: Int) -> Int {
    let fwd = 7 + dow - doy
    let weekday = CivilCalendar.weekday(
      dayNumber: CivilCalendar.dayNumber(year: year, month: 1, day: fwd))
    let fwdlw = (7 + weekday - dow) % 7
    return -fwdlw + fwd - 1
  }

  static func weeksInYear(_ year: Int, dow: Int, doy: Int) -> Int {
    let offset = firstWeekOffset(year: year, dow: dow, doy: doy)
    let next = firstWeekOffset(year: year + 1, dow: dow, doy: doy)
    return (CivilCalendar.daysInYear(year) - offset + next) / 7
  }
}
