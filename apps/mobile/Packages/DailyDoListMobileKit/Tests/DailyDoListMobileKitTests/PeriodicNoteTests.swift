import DailyDoListDomain
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListMobileKit

struct PeriodicNoteTests {
  @Test func offlineTemplatesFreezeLocalDateAndPersistCreateOnlyIntent() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    var settings = AppSettings.defaults
    settings.dailyNotes.template = "Templates/Day"
    settings.weeklyNotes.template = "Templates/Week"
    for path in ["Templates/Day.md", "Templates/Week.md"] {
      _ = try await repository.cache(
        RemoteNote(content: "# {{title}}\n{{date}} at {{time}}", version: "v1"), path: path)
    }
    let date = LocalDate(year: 2026, month: 9, day: 27)
    let now = try #require(ISO8601DateFormatter().date(from: "2026-09-28T00:10:00Z"))
    let zone = try #require(TimeZone(secondsFromGMT: -7 * 3600))
    let daily = try await repository.createPeriodicNote(
      .daily, date: date, settings: settings, knownPaths: [], now: now, timeZone: zone)
    #expect(daily.content == "# 2026-09-27\n2026-09-27 at 17:10")
    #expect(daily.baseVersion == nil)
    #expect(daily.state == .waitingToSync)
    let weekly = try await repository.createPeriodicNote(
      .weekly, date: date, settings: settings, knownPaths: [], now: now, timeZone: zone)
    #expect(weekly.content.contains("2026-09-27 at 17:10"))
    let restarted = try fixture.open()
    let reopened = try await restarted.createPeriodicNote(
      .daily, date: date, settings: settings, knownPaths: [],
      now: now.addingTimeInterval(86400), timeZone: zone)
    #expect(reopened.content == daily.content)
    #expect(reopened.localRevision == daily.localRevision)
  }

  @Test func unavailableConfiguredTemplateAndKnownHostNoteNeverCreateBlankReplacements()
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let date = LocalDate(year: 2026, month: 9, day: 27)
    var settings = AppSettings.defaults
    settings.dailyNotes.template = "Templates/Day"
    await #expect(throws: PeriodicNoteError.templateNotDownloaded("Templates/Day.md")) {
      try await repository.createPeriodicNote(
        .daily, date: date, settings: settings, knownPaths: [], now: Date(), timeZone: .current)
    }
    settings.dailyNotes.template = ""
    let path = DailyNotes.path(for: date, settings: settings.dailyNotes)
    await #expect(throws: PeriodicNoteError.noteNotDownloaded(path)) {
      try await repository.createPeriodicNote(
        .daily, date: date, settings: settings, knownPaths: [path], now: Date(), timeZone: .current)
    }
    #expect(try await repository.notes().isEmpty)
    let created = try await repository.createPeriodicNote(
      .daily, date: date, settings: settings, knownPaths: [], now: Date(), timeZone: .current)
    #expect(created.content == "- [ ] ")
  }
}
