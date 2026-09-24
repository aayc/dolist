import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListClient

/// The `@ddl/core` behaviors the fake daemon ports, checked against the TypeScript values.
struct FakeHelpersTests {
  /// Values of `hashString` computed with Node from `packages/core/src/text.ts`.
  @Test(arguments: [
    ("", "0bdcb81aee8d83"),
    ("- [ ] ", "1ace40a46a28e8"),
    ("hello", "106f3a63cd7226"),
    ("Café ☕ 👩‍👩‍👧", "088b013503ad4d"),
    ("# Title\n\n- [x] Done\n", "19f0ecaef16127"),
  ])
  func contentVersionsMatchTheDaemon(text: String, version: String) {
    #expect(ContentHash.version(of: text) == version)
  }

  @Test func momentFormatsMatchCoreDates() {
    let calendar = FakeCalendar(timeZone: TimeZone(identifier: "UTC")!)
    let date = LocalDate(year: 2026, month: 9, day: 3)
    #expect(calendar.format(date, "dddd, MMMM Do YYYY") == "Thursday, September 3rd 2026")
    #expect(calendar.format(date, "[Week] ww") == "Week 36")
    #expect(calendar.format(LocalDate(year: 2026, month: 1, day: 11), "Do") == "11th")
    #expect(calendar.format(LocalDate(year: 2026, month: 1, day: 22), "Do") == "22nd")
    #expect(calendar.format(LocalDate(year: 2026, month: 1, day: 1), "gggg-[W]ww") == "2026-W01")
    #expect(calendar.format(LocalDate(year: 2025, month: 12, day: 28), "gggg-[W]ww") == "2026-W01")
    #expect(calendar.format(LocalDate(year: 2026, month: 9, day: 23), "gggg-[W]ww") == "2026-W39")
    #expect(calendar.format(LocalDate(year: 2026, month: 9, day: 23), "YYYY/MM/YYYY-MM-DD") == "2026/09/2026-09-23")
    #expect(calendar.format(LocalDate(year: 2024, month: 2, day: 29), "DDD ddd E") == "60 Thu 4")
    #expect(calendar.format(Date(timeIntervalSince1970: 1_790_155_800), "YYYY-MM-DD HHmmss") == "2026-09-23 093000")
  }

  @Test func dailyNotePathsAndTemplates() throws {
    let calendar = FakeCalendar(timeZone: TimeZone(identifier: "UTC")!)
    let date = LocalDate(year: 2026, month: 9, day: 23)
    #expect(try calendar.dailyNotePath(date, .defaults) == "Daily/2026-09-23.md")
    #expect(try calendar.dailyNotePath(date, DailyNoteSettings(folder: "", format: "YYYY/MM/YYYY-MM-DD", template: "")) == "2026/09/2026-09-23.md")
    #expect(try calendar.dailyNotePath(date, DailyNoteSettings(folder: "/Journal//Daily/", format: "", template: "")) == "Journal/Daily/2026-09-23.md")
    #expect(throws: FakeVaultPaths.EscapeError.self) {
      try calendar.dailyNotePath(date, DailyNoteSettings(folder: "../outside", format: "YYYY", template: ""))
    }
    #expect(try FakeCalendar.templateNotePath(" Templates/Daily ") == "Templates/Daily.md")
    #expect(try FakeCalendar.templateNotePath("  ") == nil)
    let now = Date(timeIntervalSince1970: 1_790_155_800)
    let rendered = calendar.renderTemplate(
      "# {{title}}\n{{date:dddd}} {{ TIME }} {{date}} {{unknown}} {{time:HH}}", title: "2026-09-23", date: date, now: now)
    #expect(rendered == "# 2026-09-23\nWednesday 09:30 2026-09-23 {{unknown}} 09")
  }

  @Test func localDateCalendarMath() {
    #expect(LocalDate(iso: "2024-02-29") == LocalDate(year: 2024, month: 2, day: 29))
    #expect(LocalDate(iso: "2023-02-29") == nil)
    #expect(LocalDate(iso: "2026-9-23") == nil)
    #expect(LocalDate(year: 2026, month: 12, day: 31).adding(days: 1) == LocalDate(year: 2027, month: 1, day: 1))
    #expect(LocalDate(year: 2024, month: 3, day: 1).adding(days: -1) == LocalDate(year: 2024, month: 2, day: 29))
    #expect(LocalDate(year: 1970, month: 1, day: 1).weekday == 4)
    #expect(LocalDate(year: 1969, month: 12, day: 31).weekday == 3)
    #expect(LocalDate(year: 2026, month: 9, day: 23).weekday == 3)
  }

  @Test func taskParserFindsCheckboxLines() {
    let content = "# Title\n- [ ] Buy milk\n  * [x] Done thing\n1. [ ] Numbered\n- [ ]\n- [ ]x not a task\n-[ ] no space\r\n+ [/] in progress\n- [ ] "
    let tasks = FakeTaskParser.tasks(in: content)
    #expect(tasks == [
      .init(line: 1, text: "Buy milk", isOpen: true),
      .init(line: 2, text: "Done thing", isOpen: false),
      .init(line: 3, text: "Numbered", isOpen: true),
      .init(line: 4, text: "", isOpen: true),
      .init(line: 7, text: "in progress", isOpen: false),
      .init(line: 8, text: "", isOpen: true),
    ])
    #expect(FakeTaskParser.isBlank(" … - ."))
    #expect(FakeTaskParser.isBlank("a"))
    #expect(!FakeTaskParser.isBlank("Call mom"))
  }

  @Test func riskyVerbsAreWholeWords() {
    #expect(AgentScript.riskyVerb(in: "Book dentist appointment") == "book")
    #expect(AgentScript.riskyVerb(in: "Order a new kettle, then email Sam") == "order")
    #expect(AgentScript.riskyVerb(in: "Find a good notebook") == nil)
    #expect(AgentScript.riskyVerb(in: "Research payment apps") == nil)
    #expect(AgentScript.forTask("Send the invoice").risky?.categories == [.communication])
    #expect(AgentScript.forTask("Browse for standing desks").steps.contains { $0.page != nil })
    #expect("Hello big  world".streamingChunks == ["Hello ", "big ", " ", "world"])
  }

  @Test func trashCandidatesMirrorTheDaemon() {
    #expect(FakeVault.trashCandidate("Ideas.md", isFolder: false, stamp: "2026-09-23 093000", attempt: 0) == ".trash/Ideas.md")
    #expect(FakeVault.trashCandidate("A/Ideas.md", isFolder: false, stamp: "2026-09-23 093000", attempt: 1) == ".trash/A/Ideas (2026-09-23 093000).md")
    #expect(FakeVault.trashCandidate("A/Ideas.md", isFolder: false, stamp: "2026-09-23 093000", attempt: 2) == ".trash/A/Ideas (2026-09-23 093000 2).md")
    #expect(FakeVault.trashCandidate("Projects.v2", isFolder: true, stamp: "S", attempt: 1) == ".trash/Projects.v2 (S)")
    let long = String(repeating: "é", count: 200) + ".md"
    let candidate = FakeVault.trashCandidate(long, isFolder: false, stamp: "2026-09-23 093000", attempt: 1)
    #expect(FakeVaultPaths.basename(candidate).utf8.count <= 255)
  }

  @Test func searchPreviewsAreCentredWindows() {
    let line = String(repeating: "a", count: 200) + " needle " + String(repeating: "b", count: 200)
    let preview = FakeVaultSearch.preview(line, 201, 6)
    #expect(preview.hasPrefix("…") && preview.hasSuffix("…") && preview.contains("needle"))
    #expect(preview.utf16.count <= 162)
    #expect(FakeVaultSearch.preview("  short line  ", 2, 5) == "short line")
  }
}
