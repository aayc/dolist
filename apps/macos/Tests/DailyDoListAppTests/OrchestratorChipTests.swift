import DailyDoListEditor
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListApp

extension OrchestratorActivity {
  /// An activity about lines of a note.
  static func note(
    _ phase: OrchestratorPhase, _ path: String, _ lines: [(Int, String)], turn: String? = nil,
    outcome: OrchestratorOutcome? = nil
  ) -> OrchestratorActivity {
    OrchestratorActivity(
      phase: phase, turnId: turn,
      trigger: OrchestratorTrigger(
        kind: .note, notePath: path,
        lines: lines.map { OrchestratorTriggerLine(line: $0.0, text: $0.1) },
        summary: lines.count == 1 ? "“\(lines[0].1)”" : "your note"),
      outcome: outcome)
  }
}

/// The chips of every note, from `orchestrator.activity` events: which line each one is on and
/// what it says, the timers that fade them, and the turn under way.
@MainActor
@Suite("Orchestrator chips")
struct OrchestratorChipTests {
  let today = "Daily/2026-09-23.md"
  let other = "Daily/2026-09-22.md"

  // MARK: The board

  @Test func aNoticedLineKeepsOneChipFromNoticingToItsOutcome() throws {
    var board = OrchestratorChipBoard()
    var changes = board.apply(.note(.noticed, today, [(3, "find a la")]))
    #expect(changes.notes == [today])
    let id = try #require(board.chips.first?.id)
    #expect(changes.noticed == [id])
    // Still typing: the same chip, with the longer text.
    changes = board.apply(.note(.noticed, today, [(3, "find a lamp")]))
    #expect(board.chips.map(\.id) == [id])
    #expect(board.chips.first?.text == "find a lamp")
    for phase in [OrchestratorPhase.reading, .thinking, .acting] {
      _ = board.apply(.note(phase, today, [(3, "find a lamp")], turn: "msg_1"))
      #expect(board.chips.map(\.id) == [id])
      #expect(board.chips.first?.phase == phase && board.chips.first?.turnId == "msg_1")
    }
    let outcome = OrchestratorOutcome(kind: .tasksAdded, count: 1)
    changes = board.apply(
      .note(.idle, today, [(3, "find a lamp")], turn: "msg_1", outcome: outcome))
    #expect(changes.ended == [id])
    #expect(board.chips.first?.outcome == outcome && board.chips.first?.phase == .idle)
  }

  @Test func aLineNoticedWhileAnotherTurnRunsDoesNotDisturbIt() {
    var board = OrchestratorChipBoard()
    _ = board.apply(.note(.thinking, today, [(1, "What's a good desk height?")], turn: "msg_1"))
    _ = board.apply(.note(.noticed, other, [(0, "book the dentist")]))
    _ = board.apply(.note(.acting, today, [(1, "What's a good desk height?")], turn: "msg_1"))
    #expect(board.chips(for: today).map(\.phase) == [.acting])
    #expect(board.chips(for: other).map(\.phase) == [.noticed])
    let changes = board.apply(
      .note(
        .idle, today, [(1, "What's a good desk height?")], turn: "msg_1",
        outcome: OrchestratorOutcome(kind: .replied)))
    #expect(changes.notes == [today])
    #expect(board.chips(for: other).map(\.phase) == [.noticed])
  }

  @Test func aTurnWithoutAnOutcomeOrLinesThatWentAwayRemoveTheirChips() {
    var board = OrchestratorChipBoard()
    _ = board.apply(.note(.reading, today, [(1, "research lamps")], turn: "msg_1"))
    _ = board.apply(.note(.idle, today, [(1, "research lamps")], turn: "msg_1"))
    #expect(board.chips.isEmpty, "stopped")

    _ = board.apply(.note(.noticed, today, [(2, "find a lamp"), (4, "call Sam?")]))
    _ = board.apply(.note(.idle, today, [(2, "find a lamp")]))
    #expect(board.chips.map(\.text) == ["call Sam?"], "the line went away before it woke")
  }

  @Test func anOutcomeForATurnNeverSeenStillShows() {
    var board = OrchestratorChipBoard()
    let changes = board.apply(
      .note(
        .idle, today, [(5, "book the dentist")], turn: "msg_9",
        outcome: OrchestratorOutcome(kind: .askedApproval)))
    #expect(board.chips.map(\.text) == ["book the dentist"])
    #expect(changes.ended == board.chips.map(\.id))
  }

  @Test func turnsWithoutLinesMakeNoChips() {
    var board = OrchestratorChipBoard()
    let message = OrchestratorActivity(
      phase: .thinking, turnId: "msg_1",
      trigger: OrchestratorTrigger(kind: .message, summary: "your message"))
    #expect(board.apply(message).notes.isEmpty)
    #expect(board.chips.isEmpty)
  }

  // MARK: The store

  @Test func anOutcomeShowsForAFewSecondsThenFades() {
    let scheduler = ManualScheduler()
    let store = OrchestratorActivityStore(scheduler: scheduler)
    var notified: [Set<String>] = []
    store.onChipsChanged = { notified.append($0) }
    store.apply(.note(.reading, today, [(1, "find a lamp")], turn: "msg_1"))
    #expect(store.working?.turnId == "msg_1")
    #expect(store.working(on: today) != nil && store.working(on: other) == nil)
    store.apply(
      .note(
        .idle, today, [(1, "find a lamp")], turn: "msg_1",
        outcome: OrchestratorOutcome(kind: .tasksAdded, count: 1)))
    #expect(store.working == nil)
    scheduler.advance(by: OrchestratorActivityStore.outcomeHold - 0.1)
    #expect(store.chips.first?.isFading == false)
    scheduler.advance(by: 0.1)
    #expect(store.chips.first?.isFading == true)
    scheduler.advance(by: OrchestratorActivityStore.fadeDuration)
    #expect(store.chips.isEmpty)
    #expect(notified.count == 4 && notified.allSatisfy { $0 == [today] })
  }

  @Test func nothingToDoGoesSooner() {
    let scheduler = ManualScheduler()
    let store = OrchestratorActivityStore(scheduler: scheduler)
    store.apply(
      .note(
        .idle, today, [(0, "Had a long walk")], turn: "msg_2",
        outcome: OrchestratorOutcome(kind: .noAction)))
    scheduler.advance(by: OrchestratorActivityStore.nothingToDoHold)
    #expect(store.chips.first?.isFading == true)
    #expect(OrchestratorActivityStore.nothingToDoHold < OrchestratorActivityStore.outcomeHold)
  }

  @Test func aNoticedLineNothingFollowedIsLetGo() {
    let scheduler = ManualScheduler()
    let store = OrchestratorActivityStore(scheduler: scheduler)
    store.apply(.note(.noticed, today, [(0, "find a lamp")]))
    store.apply(.note(.noticed, today, [(4, "call Sam?")]))
    scheduler.advance(by: 30)
    store.apply(.note(.reading, today, [(4, "call Sam?")], turn: "msg_3"))
    scheduler.advance(by: OrchestratorActivityStore.noticedExpiry)
    #expect(store.chips.map(\.text) == ["call Sam?"], "the one its turn picked up stays")
  }

  @Test func aSnapshotAdoptsATurnUnderWayUnlessAnEventIsNewer() {
    let store = OrchestratorActivityStore(scheduler: ManualScheduler())
    let turn = OrchestratorActivity.note(.acting, today, [(2, "plan the offsite")], turn: "msg_4")
    store.adopt(turn, since: store.eventCount)
    #expect(store.working == turn)
    #expect(store.chips.map(\.phase) == [.acting])

    let mark = store.eventCount
    store.apply(.note(.thinking, today, [(2, "plan the offsite")], turn: "msg_4"))
    store.adopt(nil, since: mark)
    #expect(store.working?.phase == .thinking, "the event is newer than the snapshot")

    store.adopt(nil, since: store.eventCount)
    #expect(store.working == nil)
    #expect(store.chips.isEmpty, "nothing under way: unfinished chips go")
  }

  // MARK: Placing chips in the text

  @Test func chipsSayWhatTheOrchestratorIsDoingInTheSpecsWords() {
    func chip(_ phase: OrchestratorPhase, _ outcome: OrchestratorOutcome? = nil)
      -> ChipBuilder.Presentation
    {
      ChipBuilder.presentation(
        of: OrchestratorChip(
          id: "orchestrator:1", notePath: today, line: 0, text: "x", phase: phase, turnId: "m",
          summary: "“x”", outcome: outcome))
    }
    typealias Status = EditorBadge.OrchestratorStatus
    #expect(chip(.noticed).status == Status.noticed && chip(.noticed).label.isEmpty)
    #expect(chip(.reading).label == "Orchestrator is looking…")
    #expect(chip(.thinking).label == "Orchestrator is looking…")
    #expect(chip(.acting).label == "Working…" && chip(.acting).status == Status.acting)
    let outcomes: [(OrchestratorOutcome, String, String)] = [
      (OrchestratorOutcome(kind: .tasksAdded, count: 1), "Added a task ↗", Status.done),
      (OrchestratorOutcome(kind: .tasksAdded, count: 3), "Added 3 tasks ↗", Status.done),
      (OrchestratorOutcome(kind: .replied), "Replied ↗", Status.done),
      (OrchestratorOutcome(kind: .delegated, threadId: "thr_1"), "Started a task ↗", Status.done),
      (OrchestratorOutcome(kind: .routineCreated), "Made a routine ↗", Status.done),
      (OrchestratorOutcome(kind: .askedApproval), "Needs your approval ↗", Status.needsYou),
      (OrchestratorOutcome(kind: .noAction), "Nothing to do", Status.nothing),
    ]
    for (outcome, label, status) in outcomes {
      #expect(chip(.idle, outcome).label == label)
      #expect(chip(.idle, outcome).status == status)
    }
    #expect(
      chip(.idle, OrchestratorOutcome(kind: .delegated, threadId: "thr_1")).tooltip
        == "Started a task — open thread")
    #expect(
      chip(.idle, OrchestratorOutcome(kind: .tasksAdded, count: 1, text: "Added “Call mom”"))
        .tooltip == "Added “Call mom” — open the orchestrator chat")
    #expect(chip(.thinking).tooltip.hasSuffix("— open the orchestrator chat"))
  }

  @Test func aLineIsFoundByItsTextNearWhereItWas() {
    let lines = ["# Thursday", "find a lamp", "- [ ] Renew the passport", "", "call Sam?"]
    #expect(ChipBuilder.resolve(1, text: "find a lamp", in: lines) == 1)
    #expect(ChipBuilder.resolve(3, text: "find a lamp", in: lines) == 1, "moved up")
    #expect(ChipBuilder.resolve(4, text: "find a lamp for the desk", in: lines) == 1, "similar")
    #expect(ChipBuilder.resolve(1, text: "book the dentist", in: lines) == nil, "gone")
    #expect(ChipBuilder.resolve(40, text: "call Sam", in: lines) == nil, "too far to guess")
    #expect(ChipBuilder.resolve(40, text: "call Sam?", in: lines) == 4, "the same text anywhere")
  }

  @Test func placedChipsFollowTheEditorAndStayOffTaskLines() {
    let document = "# Thursday\nfind a lamp\n- [ ] Renew the passport\ncall Sam?"
    let chips = [
      OrchestratorChip(
        id: "orchestrator:1", notePath: today, line: 1, text: "find a lamp", phase: .noticed,
        summary: ""),
      OrchestratorChip(
        id: "orchestrator:2", notePath: today, line: 2, text: "- [ ] Renew the passport",
        phase: .thinking, summary: ""),
      OrchestratorChip(
        id: "orchestrator:3", notePath: today, line: 3, text: "call Sam?", phase: .reading,
        summary: ""),
    ]
    var placed: Set<String> = []
    let first = ChipBuilder.badges(
      for: chips, in: document, current: [], placed: &placed, taken: [2])
    #expect(first.map(\.id) == ["orchestrator:1", "orchestrator:3"], "not on the task's line")
    #expect(first.map(\.line) == [1, 3])
    #expect(first.first?.anchorText == "find a lamp")

    // The editor moved the first down (a line typed above) and dropped the other.
    let mapped = [first[0]].map { badge -> EditorBadge in
      var moved = badge
      moved.line = 2
      return moved
    }
    let next = ChipBuilder.badges(
      for: chips, in: "whatever the text is now", current: mapped, placed: &placed, taken: [])
    #expect(next.map(\.id) == ["orchestrator:1"])
    #expect(next.map(\.line) == [2])
  }

  @Test func oneChipPerLineTheNewest() {
    let chips = [
      OrchestratorChip(
        id: "orchestrator:1", notePath: today, line: 0, text: "find a lamp", phase: .idle,
        summary: "", outcome: OrchestratorOutcome(kind: .tasksAdded), isFading: true),
      OrchestratorChip(
        id: "orchestrator:2", notePath: today, line: 0, text: "find a lamp", phase: .reading,
        summary: ""),
    ]
    var placed: Set<String> = []
    let badges = ChipBuilder.badges(
      for: chips, in: "find a lamp", current: [], placed: &placed, taken: [])
    #expect(badges.map(\.id) == ["orchestrator:2"])
  }
}
