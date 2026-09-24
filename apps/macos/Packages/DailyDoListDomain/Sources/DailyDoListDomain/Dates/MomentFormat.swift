import Foundation

/// Moment.js-style date formatting and strict parsing, as Obsidian uses them for daily and weekly
/// note names. Port of `formatDate`, `formatLocalDate`, `parseDateWithFormat` and `weekOfYear` in
/// @ddl/core `dates.ts`, token for token: `YYYY YY gggg gg GGGG GG MMMM MMM MM M DDDD DDD Do DD D
/// dddd ddd dd d E e ww w WW W HH H hh h mm m ss s A a X x` and `[literals]` (English names).
public enum MomentFormat {
  /// What Moment prints for an invalid date.
  public static let invalidDate = "Invalid date"

  /// `formatLocalDate`: calendar tokens come from `date`; time tokens (`HH`, `X`, …) read local
  /// midnight of that date in `timeZone` (01:00 where a clock change skips midnight).
  public static func format(_ date: LocalDate, _ format: String, timeZone: TimeZone = .current)
    -> String
  {
    guard date.isValid else { return invalidDate }
    return render(
      date, format, instant: { date.startOfDayMilliseconds(in: timeZone) }, timeZone: timeZone)
  }

  /// `formatDate`: formats an instant on the wall clock of `timeZone`.
  public static func format(instant: Date, _ format: String, timeZone: TimeZone = .current)
    -> String
  {
    guard instant.timeIntervalSince1970.isFinite else { return invalidDate }
    let ms = instant.jsMilliseconds
    let local = LocalDate(date: Date(jsMilliseconds: ms), timeZone: timeZone)
    return render(local, format, instant: { ms }, timeZone: timeZone)
  }

  private static func render(
    _ date: LocalDate, _ format: String, instant: () -> Int, timeZone: TimeZone
  ) -> String {
    let source = UTF16Buffer(format)
    var out = UTF16Builder(capacity: source.count + 8)
    var clock: (ms: Int, hours: Int, minutes: Int, seconds: Int)?
    var localeWeek: WeekOfYear?
    var isoWeek: WeekOfYear?
    func time() -> (ms: Int, hours: Int, minutes: Int, seconds: Int) {
      if let clock { return clock }
      let ms = instant()
      let offset = timeZone.secondsFromGMT(
        for: Date(timeIntervalSince1970: Double(floorDiv(ms, 1000))))
      let msOfDay = floorMod(ms + offset * 1000, 86_400_000)
      let value = (ms, msOfDay / 3_600_000, msOfDay / 60_000 % 60, msOfDay / 1000 % 60)
      clock = value
      return value
    }
    func locale() -> WeekOfYear {
      if let localeWeek { return localeWeek }
      let week = weekOfYear(date, dow: 0, doy: 6)
      localeWeek = week
      return week
    }
    func iso() -> WeekOfYear {
      if let isoWeek { return isoWeek }
      let week = weekOfYear(date, dow: 1, doy: 4)
      isoWeek = week
      return week
    }
    source.withPointer { p, n in
      for segment in MomentTokenizer.tokenize(p, n) {
        switch segment {
        case .literal(let range):
          out.append(p, range)
        case .token(let token):
          let month = MomentNames.months[date.month - 1]
          let weekday = MomentNames.weekdays[date.weekday]
          let text: String
          switch token {
          case .YYYY: text = jsPad(date.year, 4)
          case .YY: text = jsPad(date.year % 100, 2)
          case .gggg: text = jsPad(locale().year, 4)
          case .gg: text = jsPad(locale().year % 100, 2)
          case .GGGG: text = jsPad(iso().year, 4)
          case .GG: text = jsPad(iso().year % 100, 2)
          case .MMMM: text = month
          case .MMM: text = String(month.prefix(3))
          case .MM: text = jsPad(date.month, 2)
          case .M: text = String(date.month)
          case .DDDD: text = jsPad(date.dayOfYear, 3)
          case .DDD: text = String(date.dayOfYear)
          case .Do: text = ordinal(date.day)
          case .DD: text = jsPad(date.day, 2)
          case .D: text = String(date.day)
          case .dddd: text = weekday
          case .ddd: text = String(weekday.prefix(3))
          case .dd: text = String(weekday.prefix(2))
          case .d, .e: text = String(date.weekday)
          case .E: text = String(date.weekday == 0 ? 7 : date.weekday)
          case .ww: text = jsPad(locale().week, 2)
          case .w: text = String(locale().week)
          case .WW: text = jsPad(iso().week, 2)
          case .W: text = String(iso().week)
          case .HH: text = jsPad(time().hours, 2)
          case .H: text = String(time().hours)
          case .hh: text = jsPad(twelveHour(time().hours), 2)
          case .h: text = String(twelveHour(time().hours))
          case .mm: text = jsPad(time().minutes, 2)
          case .m: text = String(time().minutes)
          case .ss: text = jsPad(time().seconds, 2)
          case .s: text = String(time().seconds)
          case .A: text = time().hours < 12 ? "AM" : "PM"
          case .a: text = time().hours < 12 ? "am" : "pm"
          case .X: text = String(floorDiv(time().ms, 1000))
          case .x: text = String(time().ms)
          }
          out.append(text)
        }
      }
    }
    return out.string
  }

  private static func twelveHour(_ hours: Int) -> Int {
    hours % 12 == 0 ? 12 : hours % 12
  }

  static func ordinal(_ n: Int) -> String {
    let mod100 = n % 100
    if mod100 >= 11 && mod100 <= 13 { return "\(n)th" }
    switch n % 10 {
    case 1: return "\(n)st"
    case 2: return "\(n)nd"
    case 3: return "\(n)rd"
    default: return "\(n)th"
    }
  }
}
