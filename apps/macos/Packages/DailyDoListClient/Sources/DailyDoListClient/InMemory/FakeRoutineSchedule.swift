import Foundation

/// A routine's recurrence, parsed from its schedule phrase: a port of `parseSchedule`,
/// `describeSchedule` and `nextRunAfter` in `@ddl/core` (`routine-schedule.ts`), with the same
/// phrases and error messages. Weekdays are 0 = Sunday … 6 = Saturday; times are minutes after
/// local midnight.
enum FakeRoutineSchedule: Hashable, Sendable {
  case weekly(days: [Int], times: [Int])
  case interval(minutes: Int, days: [Int], from: Int?, to: Int?)
  /// `day` -1 is the last day of the month.
  case monthly(day: Int, times: [Int])

  struct ParseError: Error, Equatable {
    let message: String
  }

  static let minimumIntervalMinutes = 15
  private static let maximumIntervalMinutes = 12 * 60
  private static let maximumTimes = 24
  private static let allDays = [0, 1, 2, 3, 4, 5, 6]
  private static let weekdays = [1, 2, 3, 4, 5]
  private static let weekend = [0, 6]
  private static let examples =
    "“every weekday at 7:30”, “every 2 hours” or “every month on the 1st at 9:00”"
  private static let dayNames: [(Int, [String])] = [
    (0, ["sunday", "sun"]), (1, ["monday", "mon"]), (2, ["tuesday", "tue", "tues"]),
    (3, ["wednesday", "wed"]), (4, ["thursday", "thu", "thur", "thurs"]),
    (5, ["friday", "fri"]), (6, ["saturday", "sat"]),
  ]
  private static let fullDayNames = [
    "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  ]
  private static let hourUnits: Set<String> = ["hours", "hour", "hrs", "hr", "h"]
  private static let minuteUnits: Set<String> = ["minutes", "minute", "mins", "min", "m"]

  // MARK: - Parsing

  static func parse(_ input: String) -> Result<FakeRoutineSchedule, ParseError> {
    var parser = Parser(input)
    do throws(ParseError) {
      return .success(try parser.parse())
    } catch {
      return .failure(error)
    }
  }

  private struct Frequency {
    enum Kind { case days, interval, weekly, monthly }
    var kind: Kind
    var days: [Int] = []
    var everyDay = false
    var phrase = ""
    var minutes = 0
  }

  private struct Parser {
    let input: String
    let tokens: [String]
    var index = 0

    init(_ input: String) {
      self.input = input
      var text = input.lowercased()
      text = text.replacingOccurrences(of: "’", with: "'").replacingOccurrences(of: "`", with: "'")
      text = Self.replace(#"\b([ap])\.m\.?"#, in: text, with: "$1m")
      text = Self.replace(#"\beveryday\b"#, in: text, with: "every day")
      text = Self.replace(#"\s*[.;!]\s*$"#, in: text, with: "")
      text = text.replacingOccurrences(of: ",", with: " , ")
        .replacingOccurrences(of: "&", with: " and ")
      tokens = text.split(whereSeparator: \.isWhitespace).map(String.init)
    }

    static func replace(_ pattern: String, in text: String, with template: String) -> String {
      guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
      return regex.stringByReplacingMatches(
        in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }

    static func matches(_ pattern: String, _ text: String) -> [String?]? {
      guard let regex = try? NSRegularExpression(pattern: pattern),
        let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
      else { return nil }
      return (0..<match.numberOfRanges).map { index in
        Range(match.range(at: index), in: text).map { String(text[$0]) }
      }
    }

    var done: Bool { index >= tokens.count }
    func peek(_ offset: Int = 0) -> String? {
      index + offset < tokens.count ? tokens[index + offset] : nil
    }
    mutating func next() -> String? {
      defer { index += 1 }
      return peek()
    }
    mutating func accept(_ words: String...) -> String? {
      guard let token = peek(), words.contains(token) else { return nil }
      index += 1
      return token
    }

    func fail(_ message: String) -> ParseError { ParseError(message: message) }

    static func day(of token: String?) -> Int? {
      guard let token else { return nil }
      let stripped = token.hasSuffix("s") ? String(token.dropLast()) : token
      return dayNames.first { $0.1.contains(token) || $0.1.contains(stripped) }?.0
    }

    static func isDayGroup(_ token: String?) -> Bool {
      guard let token else { return false }
      return day(of: token) != nil
        || ["weekday", "weekdays", "weekend", "weekends"].contains(token)
    }

    mutating func parseDays() -> (days: [Int], words: String)? {
      guard Self.isDayGroup(peek()) else { return nil }
      var days = Set<Int>()
      var words: [String] = []
      while let token = next() {
        words.append(token)
        if token == "weekday" || token == "weekdays" {
          days.formUnion(FakeRoutineSchedule.weekdays)
        } else if token == "weekend" || token == "weekends" {
          days.formUnion(FakeRoutineSchedule.weekend)
          if let word = accept("days", "day") { words.append(word) }
        } else if let day = Self.day(of: token) {
          days.insert(day)
        }
        let separator = peek()
        if separator == "," || separator == "and" || separator == "or", Self.isDayGroup(peek(1)) {
          words.append(next()!)
          continue
        }
        if separator == ",", peek(1) == "and", Self.isDayGroup(peek(2)) {
          index += 1
          words.append(next()!)
          continue
        }
        break
      }
      return (
        days.sorted(), words.joined(separator: " ").replacingOccurrences(of: " , ", with: ", ")
      )
    }

    static let timePattern = #"^(\d{1,2})(?:[:.](\d{2}))?(am|pm|a|p)?$"#

    func isTime(_ offset: Int = 0) -> Bool {
      guard let token = peek(offset) else { return false }
      return token == "noon" || token == "midnight" || Self.matches(Self.timePattern, token) != nil
    }

    mutating func parseTime() throws(ParseError) -> Int {
      let token = next()
      if token == "noon" { return 12 * 60 }
      if token == "midnight" { return 0 }
      let notATime = "“\(token ?? "")” isn't a time. Write times like 7:30, 7am or 18:00."
      guard let token, let match = Self.matches(Self.timePattern, token),
        var hour = match[1].flatMap(Int.init)
      else { throw fail(notATime) }
      let minute = match[2].flatMap(Int.init) ?? 0
      var meridiem = match[3]?.first
      if meridiem == nil, let word = accept("am", "pm", "a", "p") { meridiem = word.first }
      _ = accept("o'clock", "oclock")
      if minute > 59 { throw fail(notATime) }
      if let meridiem {
        if hour < 1 || hour > 12 {
          throw fail("“\(token)” isn't a time: with am/pm the hour is 1 to 12.")
        }
        hour = hour % 12 + (meridiem == "p" ? 12 : 0)
      } else if hour > 23 {
        throw fail(notATime)
      }
      return hour * 60 + minute
    }

    mutating func parseTimes() throws(ParseError) -> [Int] {
      guard isTime() else { throw fail("Add a time after “at”, e.g. “at 7:30”.") }
      var times: Set<Int> = [try parseTime()]
      while true {
        if peek() == "," || peek() == "and", isTime(1) {
          index += 1
          times.insert(try parseTime())
        } else if peek() == ",", peek(1) == "and", isTime(2) {
          index += 2
          times.insert(try parseTime())
        } else {
          break
        }
      }
      if times.count > maximumTimes { throw fail("That's more than \(maximumTimes) times a day.") }
      return times.sorted()
    }

    mutating func parseDayOfMonth() throws(ParseError) -> Int {
      _ = accept("the")
      if accept("last") != nil {
        _ = accept("day")
        return -1
      }
      let hasDayWord = accept("day") != nil
      let token = next()
      guard let token, let match = Self.matches(#"^(\d{1,2})(?:st|nd|rd|th)?$"#, token),
        let day = match[1].flatMap(Int.init)
      else {
        throw fail("Say which day of the month, e.g. “on the 1st” or “on the last day”.")
      }
      if day < 1 || day > 31 { throw fail("“\(token)” isn't a day of the month.") }
      if !hasDayWord { _ = accept("day") }
      return day
    }

    mutating func parseFrequency() throws(ParseError) -> Frequency? {
      if accept("hourly") != nil { return Frequency(kind: .interval, minutes: 60) }
      if accept("daily") != nil {
        return Frequency(kind: .days, days: allDays, everyDay: true, phrase: "daily")
      }
      if accept("weekly") != nil { return Frequency(kind: .weekly) }
      if accept("monthly") != nil { return Frequency(kind: .monthly) }
      guard let every = accept("every", "each") else {
        return parseDays().map { Frequency(kind: .days, days: $0.days, phrase: $0.words) }
      }
      if accept("day") != nil {
        return Frequency(kind: .days, days: allDays, everyDay: true, phrase: "every day")
      }
      if accept("hour") != nil { return Frequency(kind: .interval, minutes: 60) }
      if accept("week") != nil { return Frequency(kind: .weekly) }
      if accept("month") != nil { return Frequency(kind: .monthly) }
      if accept("minute") != nil {
        throw fail("Routines run at most every \(minimumIntervalMinutes) minutes.")
      }
      if accept("other") != nil {
        throw fail(
          "“every other …” isn't supported: name the days instead, e.g. “every monday and thursday at 9:00”."
        )
      }
      if let word = peek(), ["morning", "evening", "afternoon", "night"].contains(word) {
        throw fail("Say when: e.g. “every day at 8:00” instead of “every \(word)”.")
      }
      if let days = parseDays() {
        return Frequency(kind: .days, days: days.days, phrase: "\(every) \(days.words)")
      }
      let count = peek() ?? ""
      let amount = count.allSatisfy(\.isNumber) ? Int(count) : nil
      let joined = Self.matches(#"^(\d+)(h|m|min|mins|hrs?)$"#, count)
      if amount != nil || joined != nil {
        index += 1
        let value = joined.flatMap { $0[1] }.flatMap(Int.init) ?? amount ?? 0
        let unit = joined.flatMap { $0[2] } ?? next()
        if let unit, hourUnits.contains(unit) {
          return Frequency(kind: .interval, minutes: value * 60)
        }
        if let unit, minuteUnits.contains(unit) {
          return Frequency(kind: .interval, minutes: value)
        }
        if let unit, Self.matches(#"^(days?|weeks?|months?|years?)$"#, unit) != nil {
          throw fail(
            "“every \(value) \(unit)” isn't supported: name the days instead, e.g. “every monday and thursday at 9:00”."
          )
        }
        throw fail("Every \(value) what? Write “every \(value) hours” or “every \(value) minutes”.")
      }
      throw fail("Couldn't read “every \(peek() ?? "")”. Try \(examples).")
    }

    mutating func parse() throws(ParseError) -> FakeRoutineSchedule {
      if tokens.isEmpty { throw fail("Add a schedule, e.g. \(examples).") }
      var frequency: Frequency?
      var times: [Int]?
      var onDays: [Int]?
      var dayOfMonth: Int?
      var window: (from: Int, to: Int)?
      while !done {
        if accept(",") != nil { continue }
        if accept("at") != nil {
          if times != nil { throw fail("Give the times once, e.g. “at 8:00 and 17:00”.") }
          times = try parseTimes()
          continue
        }
        if accept("on") != nil {
          if Self.isDayGroup(peek()) {
            if onDays != nil { throw fail("Name the days once, e.g. “on monday and thursday”.") }
            onDays = parseDays()?.days
          } else {
            if dayOfMonth != nil { throw fail("Name the day of the month once.") }
            dayOfMonth = try parseDayOfMonth()
          }
          continue
        }
        if accept("from", "between") != nil {
          if window != nil {
            throw fail("Give the time window once, e.g. “from 9:00 to 17:00”.")
          }
          let from = try parseTime()
          if accept("to", "until", "till", "and", "-") == nil {
            throw fail("Write the window as “from 9:00 to 17:00”.")
          }
          let to = try parseTime()
          if to <= from {
            throw fail("The window has to end after it starts (“from 9:00 to 17:00”).")
          }
          window = (from, to)
          continue
        }
        if frequency == nil, let parsed = try parseFrequency() {
          frequency = parsed
          continue
        }
        throw fail(
          "Couldn't read “\(peek() ?? "")” in “\(input.trimmingCharacters(in: .whitespaces))”. Try \(examples)."
        )
      }
      if frequency == nil {
        if let onDays {
          frequency = Frequency(kind: .days, days: onDays, phrase: "every day")
        } else if dayOfMonth != nil {
          frequency = Frequency(kind: .monthly)
        } else {
          throw fail("Say how often, e.g. \(examples).")
        }
      }
      return try build(
        frequency!, times: times, onDays: onDays, dayOfMonth: dayOfMonth, window: window)
    }

    func build(
      _ frequency: Frequency, times: [Int]?, onDays: [Int]?, dayOfMonth: Int?,
      window: (from: Int, to: Int)?
    ) throws(ParseError) -> FakeRoutineSchedule {
      let windowOnlyForIntervals =
        "A time window only goes with an interval, e.g. “every hour from 9 to 17”."
      switch frequency.kind {
      case .interval:
        if times != nil {
          throw fail(
            "An interval runs on its own clock: drop “at …”, or say “every day at …”.")
        }
        if dayOfMonth != nil { throw fail("An interval can't be on a day of the month.") }
        if frequency.minutes < minimumIntervalMinutes {
          throw fail("Routines run at most every \(minimumIntervalMinutes) minutes.")
        }
        if frequency.minutes > maximumIntervalMinutes {
          throw fail(
            "For once or twice a day, name the times instead, e.g. “every day at 8:00 and 20:00”."
          )
        }
        return .interval(
          minutes: frequency.minutes, days: onDays ?? allDays, from: window?.from, to: window?.to)
      case .days, .weekly:
        if window != nil { throw fail(windowOnlyForIntervals) }
        if dayOfMonth != nil { throw fail("Use “every month on the …” for a day of the month.") }
        let days: [Int]
        if frequency.kind == .weekly {
          guard let onDays else {
            throw fail("Say which day, e.g. “every week on monday at 9:00”.")
          }
          days = onDays
        } else if let onDays {
          if !frequency.everyDay {
            throw fail("Name the days once, e.g. “every monday and thursday”.")
          }
          days = onDays
        } else {
          days = frequency.days
        }
        guard let times else {
          let phrase = frequency.kind == .weekly ? "every week" : frequency.phrase
          throw fail("Add a time: “\(phrase)” needs one, e.g. “\(phrase) at 8:00”.")
        }
        return .weekly(days: days, times: times)
      case .monthly:
        if window != nil { throw fail(windowOnlyForIntervals) }
        if onDays != nil {
          throw fail("Use either days of the week or a day of the month, not both.")
        }
        guard let dayOfMonth else {
          throw fail("Say which day of the month, e.g. “every month on the 1st at 9:00”.")
        }
        guard let times else { throw fail("Add a time, e.g. “every month on the 1st at 9:00”.") }
        return .monthly(day: dayOfMonth, times: times)
      }
    }
  }

  // MARK: - In words

  /// `7:30 AM`, `12:00 PM`.
  static func format(minute: Int) -> String {
    let hour = minute / 60
    let h12 = hour % 12 == 0 ? 12 : hour % 12
    let minutes = minute % 60
    return "\(h12):\(minutes < 10 ? "0" : "")\(minutes) \(hour < 12 ? "AM" : "PM")"
  }

  private static func join(_ words: [String]) -> String {
    guard words.count > 1 else { return words.joined() }
    return words.dropLast().joined(separator: ", ") + " and " + words[words.count - 1]
  }

  private static func describe(days: [Int]) -> String {
    if Set(days) == Set(allDays) { return "day" }
    if Set(days) == Set(weekdays) { return "weekday" }
    let mondayFirst = days.sorted { ($0 + 6) % 7 < ($1 + 6) % 7 }
    return join(mondayFirst.map { fullDayNames[$0] })
  }

  private static func ordinal(_ day: Int) -> String {
    let teen = (11...13).contains(day % 100)
    let suffix =
      teen ? "th" : day % 10 == 1 ? "st" : day % 10 == 2 ? "nd" : day % 10 == 3 ? "rd" : "th"
    return "\(day)\(suffix)"
  }

  /// `Every weekday at 7:30 AM`, `Every 2 hours from 9:00 AM to 5:00 PM on weekdays`.
  var text: String {
    switch self {
    case .weekly(let days, let times):
      return
        "Every \(Self.describe(days: days)) at \(Self.join(times.map(Self.format(minute:))))"
    case .interval(let minutes, let days, let from, let to):
      var parts = [
        minutes == 60
          ? "Every hour"
          : minutes % 60 == 0 ? "Every \(minutes / 60) hours" : "Every \(minutes) minutes"
      ]
      if let from, let to {
        parts.append("from \(Self.format(minute: from)) to \(Self.format(minute: to))")
      }
      if Set(days) != Set(Self.allDays) {
        let words = Self.describe(days: days)
        parts.append(words == "weekday" ? "on weekdays" : "on \(words)")
      }
      return parts.joined(separator: " ")
    case .monthly(let day, let times):
      let which = day == -1 ? "the last day" : "the \(Self.ordinal(day))"
      return "Every month on \(which) at \(Self.join(times.map(Self.format(minute:))))"
    }
  }

  // MARK: - Next run

  private func slots(on date: LocalDate) -> [Int] {
    switch self {
    case .weekly(let days, let times):
      return days.contains(date.weekday) ? times : []
    case .interval(let minutes, let days, let from, let to):
      guard days.contains(date.weekday) else { return [] }
      return Array(stride(from: from ?? 0, through: to ?? 24 * 60 - 1, by: minutes))
    case .monthly(let day, let times):
      let last = LocalDate.daysInMonth(date.year, date.month)
      return date.day == (day == -1 ? last : min(day, last)) ? times : []
    }
  }

  /// The first run strictly after `after`, in the calendar's local time.
  func nextRun(after: Date, calendar: FakeCalendar) -> Date? {
    let start = calendar.localDate(after)
    let horizon: Int
    if case .monthly = self { horizon = 70 } else { horizon = 9 }
    for offset in 0..<horizon {
      let date = start.adding(days: offset)
      for minute in slots(on: date) {
        let at = calendar.instant(date, minute: minute)
        if at > after { return at }
      }
    }
    return nil
  }
}

extension FakeCalendar {
  /// `date` at `minute` after local midnight (a time skipped by a clock change moves forward).
  func instant(_ date: LocalDate, minute: Int) -> Date {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    return calendar.date(
      from: DateComponents(
        year: date.year, month: date.month, day: date.day, hour: minute / 60, minute: minute % 60))
      ?? midnight(date).addingTimeInterval(Double(minute) * 60)
  }
}
