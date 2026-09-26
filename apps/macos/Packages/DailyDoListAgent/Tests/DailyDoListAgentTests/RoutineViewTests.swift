import AppKit
import DailyDoListModels
import DailyDoListUI
import DailyDoListUITestSupport
import SwiftUI
import Testing

@testable import DailyDoListAgent
@testable import DailyDoListAgentTestSupport

/// The Routines section: what each screen offers, read from its controls' tooltips.
@MainActor
@Suite("Routine views", .serialized)
struct RoutineViewTests {
  static let now = SnapshotTests.now
  let store = SampleData.makeStore(now: RoutineViewTests.now)
  static let shortcuts = AgentPanelShortcuts(
    hidePanel: KeyShortcut("\\"), inbox: KeyShortcut("a", [.shift, .command]),
    routines: .init(id: "routines.show", keys: KeyShortcut("r", [.shift, .command])),
    newRoutine: .init(id: "routine.new", keys: KeyShortcut("n", [.option, .command])))
  static let actions = AgentRoutineActions(newRoutine: { _ in }, edit: { _ in })

  private func panel(
    section: AgentPanelSection = .routines, routineId: String? = nil, threadId: String? = nil
  ) -> some View {
    AgentPanel(
      store: store, selectedThreadId: .constant(threadId), onShowInNote: { _ in }, onHide: {},
      shortcuts: Self.shortcuts, section: .constant(section),
      selectedRoutineId: .constant(routineId), routineActions: Self.actions
    ).agentReferenceDate(Self.now)
  }

  private func tooltips<V: View>(_ view: V, size: CGSize) -> [String: TooltipAnchorView] {
    var byLabel: [String: TooltipAnchorView] = [:]
    for anchor in tooltipAnchors(of: view, size: size) {
      if let label = anchor.tooltipContent()?.lines.first?.text { byLabel[label] = anchor }
    }
    return byLabel
  }

  // MARK: What each screen offers

  @Test func theHeaderSwitchesBetweenInboxAndRoutines() throws {
    let found = tooltips(panel(section: .inbox), size: CGSize(width: 400, height: 600))
    let routines = try #require(found["Routines"])
    #expect(routines.command == "routines.show")
    #expect(routines.tooltipContent()?.lines.first?.keys == Self.shortcuts.routines.keys)
    #expect(found["Agent inbox"]?.tooltipContent()?.lines.first?.keys == Self.shortcuts.inbox)

    let inboxOnly = tooltips(
      AgentPanel(store: store, selectedThreadId: .constant(nil)).agentReferenceDate(Self.now),
      size: CGSize(width: 400, height: 600))
    #expect(inboxOnly["Routines"] == nil, "hosts that don't keep a section get the inbox alone")
  }

  @Test func theListOffersNewRoutineWithItsCommand() throws {
    let found = tooltips(panel(), size: CGSize(width: 400, height: 640))
    let button = try #require(found["New routine"])
    #expect(button.command == "routine.new")
    #expect(button.tooltipContent()?.lines.first?.keys == Self.shortcuts.newRoutine.keys)
    for content in found.values.compactMap({ $0.tooltipContent() }) {
      #expect(!content.plainText.contains { "⌘⌥⌃⇧".contains($0) }, "\(content.plainText)")
    }
  }

  @Test func aRoutinesInboxHasItsActions() throws {
    let found = tooltips(
      panel(routineId: SampleRoutines.briefingId), size: CGSize(width: 400, height: 640))
    #expect(
      found["Back to routines"]?.tooltipContent()?.lines.first?.keys
        == Self.shortcuts.routines.keys)
    #expect(found["Pause routine"] != nil)
    #expect(found["Edit routine file"] != nil)
    #expect(found["Run now"]?.tooltipContent()?.detail == "5 extra runs left today")

    let paused = tooltips(
      panel(routineId: SampleRoutines.priceWatchId), size: CGSize(width: 400, height: 640))
    #expect(paused["Resume routine"] != nil && paused["Pause routine"] == nil)
  }

  @Test func aRunGoesBackToItsRoutineAndHasNoTaskActions() {
    let found = tooltips(
      panel(routineId: SampleRoutines.briefingId, threadId: SampleRoutines.latestBriefingRunId),
      size: CGSize(width: 400, height: 640))
    #expect(found["Back to “Morning briefing”"] != nil)
    #expect(found["Retry"] != nil)
    #expect(found["Show task in note"] == nil && found["Repeat this"] == nil)
  }

  @Test func finishedTasksOfferRepeatThis() throws {
    var drafts: [RoutineDraft] = []
    let view = AgentPanel(
      store: store, selectedThreadId: .constant(SampleData.desksThreadId),
      routineActions: AgentRoutineActions(newRoutine: { drafts.append($0) })
    ).agentReferenceDate(Self.now)
    let found = tooltips(view, size: CGSize(width: 440, height: 800))
    let repeatThis = try #require(found["Repeat this"])
    #expect(repeatThis.tooltipContent()?.detail == "Make it a routine")
    #expect(found["Back to inbox"] != nil)

    let working = tooltips(
      AgentPanel(
        store: store, selectedThreadId: .constant(SampleData.coffeeThreadId),
        routineActions: Self.actions
      ).agentReferenceDate(Self.now), size: CGSize(width: 440, height: 800))
    #expect(working["Repeat this"] == nil, "only finished tasks")
  }

  @Test func theListShowsEveryRoutinesState() {
    let routines = store.routines
    #expect(
      routines.map(\.name) == ["Morning briefing", "Price watch", "Someday", "Weekly review"])
    // The sample's slots are on this Mac's clock, like the app's.
    let locale = Locale(identifier: "en_US")
    let words = routines.map {
      (
        RoutineFormat.schedule($0), RoutineFormat.lastRunStatus($0),
        RoutineFormat.nextRun($0, now: Self.now, locale: locale),
        RoutineFormat.subtitle($0, now: Self.now, locale: locale)
      )
    }
    #expect(words[0].0 == "Every weekday at 7:30 AM" && words[0].1 == "Done")
    #expect(words[0].2.hasPrefix("Next run ") && words[0].2.contains("7:30"))
    #expect(words[0].3 == words[0].2)
    #expect(words[1].1 == "Nothing new" && words[1].2 == "Paused")
    #expect(words[1].3 == "Last result: Still $89", "the chip already says it's paused")
    #expect(words[2].0 == "“whenever”" && words[2].1 == "Never run" && words[2].2 == "Can't run")
    #expect(words[2].3 == nil, "the problem shows below")
    #expect(words[3].1 == "Working" && words[3].2.hasPrefix("Next run on "))
    #expect(words[3].2.contains("6:00"))
  }
}

/// Words of the Routines section.
struct RoutineFormatTests {
  static let calendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
  }()
  static let locale = Locale(identifier: "en_US")
  /// Wednesday, September 23, 2026, 9:30 AM UTC.
  static let now = Date(epochMillis: 1_790_155_800_000)

  @Test func whenSaysTheDay() {
    func when(_ hours: Double) -> String {
      RoutineFormat.when(
        Self.now.addingTimeInterval(hours * 3600), now: Self.now, calendar: Self.calendar,
        locale: Self.locale
      ).replacingOccurrences(of: "\u{202F}", with: " ")
    }
    #expect(when(2) == "today at 11:30 AM")
    #expect(when(22) == "tomorrow at 7:30 AM")
    #expect(when(-12) == "yesterday at 9:30 PM")
    #expect(when(3 * 24) == "on Saturday at 9:30 AM")
    #expect(when(9 * 24) == "on Oct 2 at 9:30 AM")
  }

  @Test func runsAreTitledByWhenTheyRan() {
    func title(_ hours: Double) -> String {
      RoutineFormat.runTitle(
        Self.now.addingTimeInterval(hours * 3600).epochMillis, now: Self.now,
        calendar: Self.calendar, locale: Self.locale
      ).replacingOccurrences(of: "\u{202F}", with: " ")
    }
    #expect(title(-2) == "Today, 7:30 AM")
    #expect(title(-26) == "Yesterday, 7:30 AM")
    #expect(title(-50) == "Mon, Sep 21, 7:30 AM")
  }
}
