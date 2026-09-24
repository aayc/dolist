/// Proleptic Gregorian calendar arithmetic on day numbers (days since 1970-01-01), using Howard
/// Hinnant's civil-from-days algorithms. Out-of-range months and days roll over the way
/// JavaScript's `Date.UTC(year, month - 1, day)` does, which is what @ddl/core relies on.
enum CivilCalendar {
  static func dayNumber(year: Int, month: Int, day: Int) -> Int {
    let y0 = year + floorDiv(month - 1, 12)
    let m = floorMod(month - 1, 12) + 1
    let y = y0 - (m <= 2 ? 1 : 0)
    let era = floorDiv(y, 400)
    let yoe = y - era * 400
    let doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468 + (day - 1)
  }

  static func date(fromDayNumber n: Int) -> (year: Int, month: Int, day: Int) {
    let z = n + 719_468
    let era = floorDiv(z, 146_097)
    let doe = z - era * 146_097
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let month = mp + (mp < 10 ? 3 : -9)
    return (yoe + era * 400 + (month <= 2 ? 1 : 0), month, doy - (153 * mp + 2) / 5 + 1)
  }

  /// 0 = Sunday. Day 0 (1970-01-01) was a Thursday.
  static func weekday(dayNumber n: Int) -> Int {
    floorMod(n + 4, 7)
  }

  static func isLeapYear(_ year: Int) -> Bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
  }

  static func daysInYear(_ year: Int) -> Int {
    isLeapYear(year) ? 366 : 365
  }

  static func daysInMonth(year: Int, month: Int) -> Int {
    dayNumber(year: year, month: month + 1, day: 1) - dayNumber(year: year, month: month, day: 1)
  }
}

@inline(__always)
func floorDiv(_ a: Int, _ b: Int) -> Int {
  let q = a / b
  return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q
}

@inline(__always)
func floorMod(_ a: Int, _ b: Int) -> Int {
  let r = a % b
  return (r != 0 && (r < 0) != (b < 0)) ? r + b : r
}

/// `String(n).padStart(width, "0")`: pads the decimal text, sign included (`-5` → `"00-5"`).
func jsPad(_ n: Int, _ width: Int) -> String {
  let text = String(n)
  let length = text.utf8.count
  return length >= width ? text : String(repeating: "0", count: width - length) + text
}
