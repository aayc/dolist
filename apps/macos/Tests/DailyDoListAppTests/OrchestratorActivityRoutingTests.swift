import DailyDoListAgent
import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListEditor
import DailyDoListModels
import DailyDoListUI
import Foundation
import Testing

@testable import DailyDoListApp

/// `orchestrator.activity` through the app: events and status snapshots reach the store, chips
/// land on the lines that woke it and follow the editor, clicks open the turn or its thread.
@MainActor
@Suite("Orchestrator activity in the app")
struct OrchestratorActivityRoutingTests {
  typealias Status = EditorBadge.OrchestratorStatus

  let client = FakeDaemonClient(notes: ["Ideas.md": "ideas"])
  let scheduler = ManualScheduler()
  let model: AppModel
  let daily = "Daily/2026-09-23.md"

  init() async throws {
    model = AppModel(environment: makeEnvironment(client: client, scheduler: scheduler))
    await model.boot()
    try await eventually("event loop connected") { model.connection.isOnline }
  }

  private var workspace: Workspace { model.workspace! }
  private var controller: MarkdownEditorController { workspace.editor.controller }

  /// Emits `activity` and waits until the editor's badges were refreshed.
  private func emit(_ activity: OrchestratorActivity) async throws {
    let count = workspace.orchestrator.eventCount
    client.emit(.orchestratorActivity(activity))
    try await eventually("routed") { workspace.orchestrator.eventCount == count + 1 }
    scheduler.advance(by: 0)
  }

  @Test func aChipGoesFromTheNoticedDotToTheOutcomeThenFades() async throws {
    type("Groceries are done\nfind a quiet dishwasher", in: workspace)
    let line = [(1, "find a quiet dishwasher")]
    try await emit(.note(.noticed, daily, line))
    #expect(controller.badges.map(\.status) == [Status.noticed])
    #expect(controller.badges.first?.line == 1)
    #expect(controller.badges.first?.anchorText == "find a quiet dishwasher")
    #expect(workspace.orchestrator.working == nil, "noticing isn't a turn")

    try await emit(.note(.reading, daily, line, turn: "msg_1"))
    #expect(controller.badges.map(\.label) == ["Orchestrator is looking…"])
    #expect(workspace.orchestrator.working(on: daily)?.phase == .reading)
    try await emit(.note(.acting, daily, line, turn: "msg_1"))
    #expect(controller.badges.map(\.label) == ["Working…"])
    try await emit(
      .note(
        .idle, daily, line, turn: "msg_1",
        outcome: OrchestratorOutcome(kind: .tasksAdded, count: 1, text: "Added “Find a dishwasher”")
      ))
    #expect(controller.badges.map(\.label) == ["Added a task ↗"])
    #expect(
      controller.badges.first?.tooltip == "Added “Find a dishwasher” — open the orchestrator chat")
    #expect(workspace.orchestrator.working == nil)
    let id = try #require(controller.badges.first?.id)

    scheduler.advance(by: OrchestratorActivityStore.outcomeHold)
    #expect(controller.badges.first { $0.id == id }?.isFading == true)
    scheduler.advance(by: OrchestratorActivityStore.fadeDuration)
    #expect(controller.badges.isEmpty)
  }

  @Test func chipsOfAnotherNoteWaitUntilItIsOpen() async throws {
    try await emit(.note(.noticed, "Ideas.md", [(0, "ideas")]))
    #expect(controller.badges.isEmpty)
    await workspace.openNote("Ideas.md", OpenOptions(newTab: true))
    #expect(controller.badges.map(\.status) == [Status.noticed])
  }

  @Test func clickingAChipOpensItsTurnOrTheThreadItStarted() async throws {
    type("find a lamp\nbook the dentist", in: workspace)
    try await emit(
      .note(
        .idle, daily, [(0, "find a lamp")], turn: "msg_7",
        outcome: OrchestratorOutcome(kind: .replied)))
    try await emit(
      .note(
        .idle, daily, [(1, "book the dentist")], turn: "msg_8",
        outcome: OrchestratorOutcome(kind: .delegated, threadId: "thr_dentist")))
    let badges = controller.badges
    #expect(badges.map(\.label) == ["Replied ↗", "Started a task ↗"])

    workspace.editorDidClickBadge(badges[0])
    #expect(model.agent?.orchestratorFocus?.messageId == "msg_7", "the chat opens at the turn")
    #expect(model.ui.selectedThreadId == nil)
    workspace.editorDidClickBadge(badges[1])
    #expect(model.ui.selectedThreadId == "thr_dentist")
  }

  /// The daemon keeps a finished turn's outcome in its status for a while: a pushed status
  /// (running counts changing as the turn's subagent starts) must not bring a faded chip back.
  @Test func aPushedStatusDoesNotReplayTheActivity() async throws {
    type("find a lamp", in: workspace)
    let ended = OrchestratorActivity.note(
      .idle, daily, [(0, "find a lamp")], turn: "msg_3",
      outcome: OrchestratorOutcome(kind: .delegated, count: 1, threadId: "thr_lamp"))
    try await emit(ended)
    scheduler.advance(by: OrchestratorActivityStore.outcomeHold + 1)
    #expect(controller.badges.isEmpty)
    var status = try await client.agentStatus()
    status.running = 1
    status.orchestrator = ended
    client.emit(.agentStatus(status))
    try await eventually { model.agent?.status?.running == 1 }
    scheduler.advance(by: 0)
    #expect(controller.badges.isEmpty)
    #expect(workspace.orchestrator.chips.isEmpty)
  }

  /// A snapshot fetched after a reconnect may still carry the outcome of a turn already shown.
  @Test func aSnapshotOfATurnAlreadyShownChangesNothing() async throws {
    type("find a lamp", in: workspace)
    let ended = OrchestratorActivity.note(
      .idle, daily, [(0, "find a lamp")], turn: "msg_6",
      outcome: OrchestratorOutcome(kind: .tasksAdded, count: 1))
    try await emit(ended)
    scheduler.advance(by: OrchestratorActivityStore.outcomeHold + 1)
    client.withState { $0.agentStatus.orchestrator = ended }
    await model.refreshAgent()
    scheduler.advance(by: 0)
    #expect(workspace.orchestrator.chips.isEmpty)
    #expect(controller.badges.isEmpty)
  }

  @Test func aClientJoiningMidTurnSeesItAndAReconnectClearsWhatItMissed() async throws {
    let joining = FakeDaemonClient()
    joining.withState {
      $0.agentStatus.orchestrator = .note(.acting, daily, [(0, "- [ ] ")], turn: "msg_5")
    }
    let model = AppModel(environment: makeEnvironment(client: joining))
    await model.boot()
    let workspace = try #require(model.workspace)
    try await eventually("adopted") { workspace.orchestrator.working?.turnId == "msg_5" }
    #expect(workspace.orchestrator.working(on: daily)?.phase == .acting)

    joining.withState { $0.agentStatus.orchestrator = nil }
    joining.emit(.resync)
    try await eventually("idle again") { workspace.orchestrator.working == nil }
    #expect(workspace.orchestrator.chips.isEmpty)
    await model.teardown()
  }

  @Test func theHeaderAndTheStatusBarSayWhatItIsDoing() {
    func presentation(_ phase: OrchestratorPhase, trigger: OrchestratorTrigger)
      -> OrchestratorActivityPresentation
    {
      OrchestratorActivityPresentation(
        activity: OrchestratorActivity(phase: phase, turnId: "m", trigger: trigger))
    }
    let note = OrchestratorTrigger(
      kind: .note, notePath: "Daily/2026-09-24.md", summary: "“find a lamp”")
    #expect(presentation(.reading, trigger: note).headerText == "Orchestrator: reading this note…")
    #expect(presentation(.thinking, trigger: note).headerText == "Orchestrator: thinking…")
    #expect(presentation(.acting, trigger: note).headerText == "Orchestrator: working…")
    #expect(
      presentation(.acting, trigger: note).statusText == "Orchestrator: working on 2026-09-24")
    #expect(
      presentation(.thinking, trigger: note).tooltip
        == "Woken by “find a lamp” — open the orchestrator chat")
    let message = OrchestratorTrigger(kind: .message, summary: "your message")
    #expect(
      presentation(.thinking, trigger: message).statusText
        == "Orchestrator: working on your message")
  }

}
