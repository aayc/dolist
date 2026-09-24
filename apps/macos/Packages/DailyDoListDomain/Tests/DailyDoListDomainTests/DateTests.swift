import DailyDoListDomain
import DailyDoListModels
import Foundation
import Testing

private func zone(_ id: String) -> TimeZone { TimeZone(identifier: id)! }
private func instant(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }
private func d(_ y: Int, _ m: Int, _ day: Int) -> LocalDate {
  LocalDate(year: y, month: m, day: day)
}

extension DomainTests {
  /// Clock changes, skipped days and southern-hemisphere zones: calendar dates never drift.
  struct TimeZoneTests {
    @Test func losAngelesSpringForward() {
      let la = zone("America/Los_Angeles")
      // 2026-03-08 02:00 PST → 03:00 PDT.
      #expect(
        MomentFormat.format(
          instant: instant("2026-03-08T09:59:59Z"), "YYYY-MM-DD HH:mm:ss", timeZone: la)
          == "2026-03-08 01:59:59")
      #expect(
        MomentFormat.format(
          instant: instant("2026-03-08T10:00:00Z"), "YYYY-MM-DD HH:mm:ss", timeZone: la)
          == "2026-03-08 03:00:00")
      #expect(d(2026, 3, 8).startOfDay(in: la) == instant("2026-03-08T08:00:00Z"))
      #expect(d(2026, 3, 9).startOfDay(in: la) == instant("2026-03-09T07:00:00Z"))
      // Noon is always a safe instant for the day.
      var calendar = Calendar(identifier: .gregorian)
      calendar.timeZone = la
      #expect(d(2026, 3, 8).date(calendar: calendar) == instant("2026-03-08T19:00:00Z"))
      #expect(
        LocalDate(date: d(2026, 3, 8).date(calendar: calendar), calendar: calendar) == d(2026, 3, 8)
      )
    }

    @Test func losAngelesFallBack() {
      let la = zone("America/Los_Angeles")
      // 01:30 happens twice on 2026-11-01; both are that day, an hour apart.
      let first = instant("2026-11-01T08:30:00Z")
      let second = instant("2026-11-01T09:30:00Z")
      #expect(MomentFormat.format(instant: first, "HH:mm X", timeZone: la) == "01:30 1793521800")
      #expect(MomentFormat.format(instant: second, "HH:mm X", timeZone: la) == "01:30 1793525400")
      #expect(LocalDate(date: first, timeZone: la) == d(2026, 11, 1))
      #expect(LocalDate(date: second, timeZone: la) == d(2026, 11, 1))
      #expect(LocalDate.today(now: instant("2026-11-02T07:59:59Z"), timeZone: la) == d(2026, 11, 1))
      #expect(LocalDate.today(now: instant("2026-11-02T08:00:00Z"), timeZone: la) == d(2026, 11, 2))
    }

    @Test func berlin() {
      let berlin = zone("Europe/Berlin")
      // 2026-03-29 02:00 CET → 03:00 CEST; 2026-10-25 03:00 CEST → 02:00 CET.
      #expect(
        MomentFormat.format(instant: instant("2026-03-29T00:59:59Z"), "HH:mm", timeZone: berlin)
          == "01:59")
      #expect(
        MomentFormat.format(instant: instant("2026-03-29T01:00:00Z"), "HH:mm", timeZone: berlin)
          == "03:00")
      #expect(
        MomentFormat.format(instant: instant("2026-10-25T00:30:00Z"), "HH:mm", timeZone: berlin)
          == "02:30")
      #expect(
        MomentFormat.format(instant: instant("2026-10-25T01:30:00Z"), "HH:mm", timeZone: berlin)
          == "02:30")
      #expect(d(2026, 3, 29).startOfDay(in: berlin) == instant("2026-03-28T23:00:00Z"))
      #expect(d(2026, 3, 30).startOfDay(in: berlin) == instant("2026-03-29T22:00:00Z"))
      #expect(
        LocalDate.today(now: instant("2026-10-25T22:59:59Z"), timeZone: berlin) == d(2026, 10, 25))
      #expect(
        LocalDate.today(now: instant("2026-10-25T23:00:00Z"), timeZone: berlin) == d(2026, 10, 26))
    }

    @Test func southernHemisphere() {
      let sydney = zone("Australia/Sydney")
      // DST starts 2026-10-04 02:00 AEST → 03:00 AEDT and ends 2026-04-05 03:00 → 02:00.
      #expect(
        MomentFormat.format(
          instant: instant("2026-10-03T15:59:59Z"), "YYYY-MM-DD HH:mm", timeZone: sydney)
          == "2026-10-04 01:59")
      #expect(
        MomentFormat.format(
          instant: instant("2026-10-03T16:00:00Z"), "YYYY-MM-DD HH:mm", timeZone: sydney)
          == "2026-10-04 03:00")
      // Sydney is UTC+11 in (southern) summer and UTC+10 in winter.
      #expect(d(2026, 1, 15).startOfDay(in: sydney) == instant("2026-01-14T13:00:00Z"))
      #expect(d(2026, 7, 15).startOfDay(in: sydney) == instant("2026-07-14T14:00:00Z"))
      #expect(
        LocalDate.today(now: instant("2026-12-31T12:59:59Z"), timeZone: sydney) == d(2026, 12, 31))
      #expect(
        LocalDate.today(now: instant("2026-12-31T13:00:00Z"), timeZone: sydney) == d(2027, 1, 1))
    }

    @Test func skippedMidnightAndSkippedDay() {
      // Chile moves 2023-09-03 00:00 to 01:00: local midnight doesn't exist, JS lands on 01:00.
      let santiago = zone("America/Santiago")
      let start = d(2023, 9, 3).startOfDay(in: santiago)
      #expect(start == instant("2023-09-03T04:00:00Z"))
      #expect(MomentFormat.format(d(2023, 9, 3), "HH:mm", timeZone: santiago) == "01:00")
      #expect(LocalDate(date: start, timeZone: santiago) == d(2023, 9, 3))
      // Samoa skipped 2011-12-30 entirely; its "midnight" is the next day's.
      let apia = zone("Pacific/Apia")
      #expect(
        LocalDate(date: d(2011, 12, 30).startOfDay(in: apia), timeZone: apia) == d(2011, 12, 31))
      // Calendar arithmetic ignores all of that.
      #expect(d(2011, 12, 29).adding(days: 1) == d(2011, 12, 30))
      #expect(
        d(2023, 9, 2).adding(days: 1, calendar: Calendar(identifier: .gregorian)) == d(2023, 9, 3))
    }

    @Test(arguments: [
      "America/Los_Angeles", "Europe/Berlin", "Australia/Lord_Howe", "America/Santiago",
      "Pacific/Chatham",
    ])
    func dailyNotePathsDoNotDependOnTheClock(zoneID: String) {
      let tz = zone(zoneID)
      let settings = DailyNoteSettings(folder: "Daily", format: "YYYY-MM-DD dddd", template: "")
      var date = d(2026, 3, 1)
      for _ in 0..<280 {
        let path = DailyNotes.path(for: date, settings: settings, timeZone: tz)
        #expect(DailyNotes.date(forPath: path, settings: settings) == date)
        let noon = date.startOfDay(in: tz).addingTimeInterval(12 * 3600)
        #expect(LocalDate.today(now: noon, timeZone: tz) == date)
        date = date.adding(days: 1)
      }
    }
  }

  struct MomentFormatTests {
    @Test(arguments: [
      ("2005-01-01", "2004-W53-6"), ("2005-01-02", "2004-W53-7"), ("2005-12-31", "2005-W52-6"),
      ("2006-01-01", "2005-W52-7"), ("2006-01-02", "2006-W01-1"), ("2007-12-31", "2008-W01-1"),
      ("2008-12-29", "2009-W01-1"), ("2009-12-31", "2009-W53-4"), ("2010-01-03", "2009-W53-7"),
      ("2026-09-23", "2026-W39-3"),
    ])
    func isoWeekYearBoundaries(iso: String, week: String) throws {
      let date = try #require(LocalDate(iso: iso))
      #expect(MomentFormat.format(date, "GGGG-[W]WW-E") == week)
      #expect(MomentFormat.parse(week, format: "GGGG-[W]WW-E") == date)
    }

    @Test(arguments: [
      ("2015-12-27", "2016-W01"), ("2016-12-31", "2016-W53"), ("2017-01-01", "2017-W01"),
      ("2021-12-26", "2022-W01"), ("2025-12-28", "2026-W01"), ("2026-09-23", "2026-W39"),
    ])
    func localeWeekYearBoundaries(iso: String, week: String) throws {
      let date = try #require(LocalDate(iso: iso))
      #expect(MomentFormat.format(date, "gggg-[W]ww") == week)
      // Parsing a week gives its first day (Sunday).
      let sunday = date.adding(days: -date.weekday)
      #expect(MomentFormat.parse(week, format: "gggg-[W]ww") == sunday)
    }

    @Test func weekHelpers() {
      #expect(MomentFormat.isoWeek(d(2021, 1, 3)) == WeekOfYear(week: 53, year: 2020))
      #expect(MomentFormat.localeWeek(d(2025, 12, 28)) == WeekOfYear(week: 1, year: 2026))
    }

    @Test func literals() {
      let date = d(2026, 9, 3)
      #expect(MomentFormat.format(date, "[YYYY] [Do] Q k Z YYYY") == "YYYY Do Q k Z 2026")
      // An unterminated bracket is plain text; the letters after it are tokens, as in Moment.
      #expect(MomentFormat.format(date, "[ YYYY [Do") == "[ 2026 [3rd")
      // The first `]` closes a literal; brackets don't nest.
      #expect(MomentFormat.format(date, "[a [b] c]") == "a [b c]")
      #expect(MomentFormat.format(date, "[]YYYY[]") == "2026")
      #expect(MomentFormat.format(date, "日記 YYYY年M月D日 😀") == "日記 2026年9月3日 😀")
      #expect(MomentFormat.parse("Daily 2026-09-03", format: "[Daily ]YYYY-MM-DD") == date)
      #expect(MomentFormat.parse("DAILY 2026-09-03", format: "[Daily ]YYYY-MM-DD") == date)
      #expect(MomentFormat.parse("Weekly 2026-09-03", format: "[Daily ]YYYY-MM-DD") == nil)
    }

    @Test func tokens() {
      let date = d(2026, 9, 3)
      #expect(MomentFormat.format(date, "dddd, MMMM Do YYYY") == "Thursday, September 3rd 2026")
      #expect(MomentFormat.format(date, "ddd D MMM YY") == "Thu 3 Sep 26")
      #expect(MomentFormat.format(date, "YYYY/MM/YYYY-MM-DD") == "2026/09/2026-09-03")
      #expect(MomentFormat.format(d(2026, 1, 11), "Do") == "11th")
      #expect(MomentFormat.format(d(2026, 1, 22), "Do") == "22nd")
      #expect(MomentFormat.format(d(50, 1, 1), "YYYY") == "0050")
      #expect(MomentFormat.format(d(-1, 1, 1), "YYYY") == "00-1")  // JavaScript's padStart
      #expect(MomentFormat.format(d(2026, 2, 30), "YYYY") == MomentFormat.invalidDate)
      #expect(
        MomentFormat.format(instant: Date(timeIntervalSince1970: .nan), "YYYY")
          == MomentFormat.invalidDate)
    }

    @Test func strictParsing() {
      #expect(MomentFormat.parse("2026-02-30", format: "YYYY-MM-DD") == nil)
      #expect(MomentFormat.parse("2026-09-23 ", format: "YYYY-MM-DD") == nil)
      #expect(MomentFormat.parse("2026-9-23", format: "YYYY-MM-DD") == nil)
      #expect(MomentFormat.parse("2026-09-23", format: "YYYY-M-D") == d(2026, 9, 23))
      #expect(MomentFormat.parse("september 3rd, 2026", format: "MMMM Do, YYYY") == d(2026, 9, 3))
      #expect(MomentFormat.parse("2026-09-23 Tuesday", format: "YYYY-MM-DD dddd") == nil)
      #expect(MomentFormat.parse("1700000000", format: "X") == nil)
      // Greedy digits with backtracking, exactly like the regular expression the core builds.
      #expect(MomentFormat.parse("202611", format: "YYYYMD") == d(2026, 1, 1))
      #expect(MomentFormat.parse("2026111", format: "YYYYMD") == d(2026, 11, 1))
      #expect(MomentFormat.parse("2026-W39", format: "YYYY-[W]WW") == d(2026, 9, 21))
      #expect(MomentFormat.parse("2026-W39", format: "YYYY-[W]ww") == d(2026, 9, 20))
      // A week without a year uses the reference year (default: this year).
      #expect(MomentFormat.parse("W39", format: "[W]ww", referenceYear: 2026) == d(2026, 9, 20))
      #expect(MomentFormat.parse("W1", format: "[W]W")?.year ?? 0 >= LocalDate.today().year - 1)
    }

    @Test func calendarBasics() throws {
      #expect(d(2026, 12, 31).adding(days: 1) == d(2027, 1, 1))
      #expect(d(2024, 3, 1).adding(days: -1) == d(2024, 2, 29))
      #expect(LocalDate.daysBetween(d(2026, 9, 1), d(2026, 9, 23)) == 22)
      #expect(d(2026, 9, 3).isoString == "2026-09-03")
      #expect(LocalDate(iso: "2026-09-03") == d(2026, 9, 3))
      #expect(LocalDate(iso: "2026-9-3") == nil)
      #expect(LocalDate(iso: "2026-02-30") == nil)
      #expect(LocalDate(iso: "２０２６-09-03") == nil)
      #expect(d(2026, 13, 1).dayNumber == d(2027, 1, 1).dayNumber)
      #expect(!d(2026, 13, 1).isValid)
      #expect(d(2026, 9, 23).weekday == 3)
      #expect(d(2026, 12, 31).dayOfYear == 365)
      let json = try JSONEncoder().encode(d(2026, 9, 23))
      #expect(try JSONDecoder().decode(LocalDate.self, from: json) == d(2026, 9, 23))
      #expect(DailyNotes.friendlyTitle(d(2026, 9, 23)) == "Wednesday, September 23, 2026")
    }

    @Test func headerTitlesShowTheYearOnlyWhenItIsNotThisYear() {
      let today = d(2026, 9, 24)
      #expect(DailyNotes.friendlyTitle(d(2026, 9, 24), today: today) == "Thursday, September 24")
      #expect(DailyNotes.friendlyTitle(d(2026, 1, 1), today: today) == "Thursday, January 1")
      #expect(DailyNotes.friendlyTitle(d(2026, 12, 31), today: today) == "Thursday, December 31")
      #expect(
        DailyNotes.friendlyTitle(d(2025, 12, 29), today: today) == "Monday, December 29, 2025")
      #expect(DailyNotes.friendlyTitle(d(2027, 1, 4), today: today) == "Monday, January 4, 2027")
      // Only the year matters, not how far away the date is.
      #expect(
        DailyNotes.friendlyTitle(d(2025, 12, 31), today: d(2026, 1, 1))
          == "Wednesday, December 31, 2025")
    }
  }
}
