import AppKit
import DailyDoListEditor
import DailyDoListModels
import DailyDoListUI
import DailyDoListUITestSupport
import SwiftUI
import Testing

@testable import DailyDoListApp

extension SnapshotTests {
  static let activityNote = """
    # Wednesday
    - [ ] Renew passport
    find a quiet dishwasher
    What's a good desk height?
    call mom tomorrow
    Had a long walk by the river
    """

  /// While the orchestrator works on the open note: the header says so, and each line that woke
  /// it has its chip (noticed, looking, an outcome, nothing to do); the task keeps its badge.
  /// Then a turn on another note, in the status bar.
  @Test func orchestratorActivity() async throws {
    let daily = "Daily/2026-09-23.md"
    let client = FakeDaemonClient(notes: [daily: Self.activityNote, "Ideas.md": "Garden"])
    client.withState {
      $0.records[daily] = [
        .sample("t1", note: daily, text: "Renew passport", line: 1, status: .triaging)
      ]
    }
    let scheduler = ManualScheduler()
    let model = AppModel(environment: makeEnvironment(client: client, scheduler: scheduler))
    await model.boot()
    let workspace = try #require(model.workspace)
    try await eventually("records") { model.agent?.records(for: daily).count == 1 }
    let orchestrator = workspace.orchestrator
    orchestrator.apply(.note(.noticed, daily, [(2, "find a quiet dishwasher")]))
    orchestrator.apply(.note(.thinking, daily, [(3, "What's a good desk height?")], turn: "msg_1"))
    orchestrator.apply(
      .note(
        .idle, daily, [(4, "call mom tomorrow")], turn: "msg_0",
        outcome: OrchestratorOutcome(kind: .tasksAdded, count: 1, text: "Added “Call mom”")))
    orchestrator.apply(
      .note(
        .idle, daily, [(5, "Had a long walk by the river")], turn: "msg_00",
        outcome: OrchestratorOutcome(kind: .noAction)))
    scheduler.advance(by: 0)
    let controller = workspace.editor.controller
    #expect(
      controller.badges.map(\.label) == [
        "Triaging…", "", "Orchestrator is looking…", "Added a task ↗", "Nothing to do",
      ])
    let repaint = { controller.setBadges(controller.badges) }
    for dark in [false, true] {
      try await render(
        MainWindowView(model: model), size: CGSize(width: 1100, height: 520), dark: dark,
        name: "orchestrator-activity", afterDisplay: repaint)
      try await render(
        NoteHeaderView(workspace: workspace, path: daily).frame(width: 760)
          .background(Theme.background),
        size: CGSize(width: 760, height: 90), dark: dark, name: "orchestrator-header")
    }

    // The indicator's tooltip, where the app shows it.
    for dark in [false, true] {
      var found = false
      try await render(
        NoteHeaderView(workspace: workspace, path: daily).frame(width: 760)
          .background(Theme.background),
        size: CGSize(width: 760, height: 150), dark: dark, name: "orchestrator-header-tooltip",
        tooltip: { hosting in
          let snapshot = TooltipSnapshot.of(
            "Woken by “What's a good desk height?” — open the orchestrator chat", in: hosting)
          found = snapshot != nil
          return snapshot
        })
      #expect(found, "the header indicator has its tooltip")
    }

    // A turn about another note: the status bar says where.
    orchestrator.apply(.note(.acting, "Ideas.md", [(0, "Garden")], turn: "msg_2"))
    for dark in [false, true] {
      try await render(
        StatusBar(model: model, workspace: workspace).frame(width: 760)
          .background(Theme.background),
        size: CGSize(width: 760, height: Theme.statusBarHeight), dark: dark,
        name: "orchestrator-status-bar")
    }
    await model.teardown()
  }
}
