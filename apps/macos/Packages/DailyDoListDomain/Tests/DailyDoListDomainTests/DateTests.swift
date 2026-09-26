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
  /// What the dates vectors can't reach (they pin tokens, parsing, calendar math and clock changes
  /// in 13 zones): the Swift-only API, and daily-note paths in zones other than theirs.
  struct DateTests {
    @Test func swiftOnlyAPI() throws {
      var calendar = Calendar(identifier: .gregorian)
      calendar.timeZone = zone("America/Los_Angeles")
      // Noon is a safe instant for the day, even on a clock change.
      #expect(d(2026, 3, 8).date(calendar: calendar) == instant("2026-03-08T19:00:00Z"))
      #expect(
        LocalDate(date: d(2026, 3, 8).date(calendar: calendar), calendar: calendar) == d(2026, 3, 8)
      )
      #expect(
        d(2023, 9, 2).adding(days: 1, calendar: Calendar(identifier: .gregorian)) == d(2023, 9, 3))
      #expect(MomentFormat.isoWeek(d(2021, 1, 3)) == WeekOfYear(week: 53, year: 2020))
      #expect(MomentFormat.localeWeek(d(2025, 12, 28)) == WeekOfYear(week: 1, year: 2026))
      #expect(
        MomentFormat.format(instant: Date(timeIntervalSince1970: .nan), "YYYY")
          == MomentFormat.invalidDate)
      // A week without a year uses the reference year (default: this year).
      #expect(MomentFormat.parse("W1", format: "[W]W")?.year ?? 0 >= LocalDate.today().year - 1)
      let json = try JSONEncoder().encode(d(2026, 9, 23))
      #expect(try JSONDecoder().decode(LocalDate.self, from: json) == d(2026, 9, 23))
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

    @Test func headerTitlesShowTheYearOnlyWhenItIsNotThisYear() {
      let today = d(2026, 9, 24)
      #expect(DailyNotes.friendlyTitle(d(2026, 9, 23)) == "Wednesday, September 23, 2026")
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
