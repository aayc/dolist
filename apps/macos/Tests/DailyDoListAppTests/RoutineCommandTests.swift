import DailyDoListAgent
import DailyDoListModels
import Testing

@testable import DailyDoListApp

/// Show Routines and New Routine… (menu, palette, `:obcommand`), and opening routines' runs.
@MainActor
@Suite("Routine commands", .serialized)
struct RoutineCommandTests {
  let client = FakeDaemonClient()
  let model: AppModel

  init() async {
    model = AppModel(environment: makeEnvironment(client: client))
    await model.boot()
  }

  private func run(_ id: String, routineId: String) -> ThreadSummary {
    ThreadSummary(
      id: id, taskId: "run_\(id)", notePath: "Routines/Morning briefing.md",
      title: "Morning briefing", status: .done, createdAt: 1, updatedAt: 2, messageCount: 0,
      artifactCount: 0, surfaces: [], pendingApprovals: 0, routineId: routineId)
  }

  @Test func theCommandsHaveTheirShortcutsAndNames() throws {
    let catalog = CommandCatalog(model: model)
    let show = try #require(catalog.command(.showRoutines))
    #expect(show.title == "Show Routines" && show.paletteTitle == "Show routines")
    #expect(show.shortcut == Shortcut("r", [.command, .shift]))
    let new = try #require(catalog.command(.newRoutine))
    #expect(new.title == "New Routine…" && new.paletteTitle == "Create new routine")
    #expect(new.shortcut == Shortcut("n", [.command, .option]))
    let palette = catalog.paletteCommands.map(\.id)
    #expect(palette.contains(.showRoutines) && palette.contains(.newRoutine))
    #expect(CommandID(vimCommandID: "routines:show") == .showRoutines)
    #expect(CommandID(vimCommandID: "routine:new") == .newRoutine)
  }

  @Test func showRoutinesOpensTheListInTheAgentPanel() {
    model.ui.inspectorPresented = false
    model.ui.selectedRoutineId = "rtn_1"
    model.ui.selectedThreadId = "thr_1"
    #expect(CommandCatalog(model: model).run(.showRoutines))
    #expect(model.ui.inspectorPresented && model.ui.agentSection == .routines)
    #expect(model.ui.selectedRoutineId == nil && model.ui.selectedThreadId == nil)

    // ⌘⇧A from the routines shows the inbox instead of hiding the panel.
    model.ui.toggleInbox()
    #expect(model.ui.inspectorPresented && model.ui.agentSection == .inbox)
    model.ui.toggleInbox()
    #expect(!model.ui.inspectorPresented)
  }

  @Test func newRoutineOpensTheSheetWhileTheAgentIsConnected() throws {
    let catalog = CommandCatalog(model: model)
    #expect(model.agent != nil)
    #expect(catalog.run(.newRoutine))
    let sheet = try #require(model.ui.routineSheet)
    #expect(sheet.draft == RoutineDraft())

    model.ui.routineSheet = nil
    model.agent = nil
    #expect(!catalog.run(.newRoutine), "no agent store to create it with")
    #expect(model.ui.routineSheet == nil)
  }

  @Test func repeatThisOpensTheSheetWithTheTask() throws {
    let draft = RoutineDraft(repeating: "Check the price of the kettle", threadId: "thr_1")
    model.ui.newRoutine(draft)
    #expect(model.ui.routineSheet?.draft == draft)
  }

  @Test func aRunOpensWithItsRoutineBehindIt() throws {
    let agent = try #require(model.agent)
    agent.apply(.threadUpsert(run("thr_r1", routineId: "rtn_1")))
    model.openThread("thr_r1")
    #expect(model.ui.agentSection == .routines && model.ui.selectedRoutineId == "rtn_1")
    #expect(model.ui.selectedThreadId == "thr_r1" && model.ui.inspectorPresented)

    model.openThread("thr_task")
    #expect(model.ui.agentSection == .inbox && model.ui.selectedThreadId == "thr_task")

    model.openRoutineRun(routineId: "rtn_2", threadId: "thr_r2")
    #expect(model.ui.agentSection == .routines && model.ui.selectedRoutineId == "rtn_2")
    #expect(model.ui.selectedThreadId == "thr_r2")
  }

  @Test func theRoutinesAreFetchedWithTheAgentsState() async throws {
    client.withState {
      $0.routines = [
        Routine(
          id: "rtn_1", path: "Routines/Morning briefing.md", name: "Morning briefing",
          schedule: "every weekday at 7:30", instructions: "Brief me.")
      ]
    }
    let agent = try #require(model.agent)
    // The boot's own refresh may still be running; the latest one applies.
    await agent.refresh()
    try await eventually("routines fetched") {
      agent.routinesLoaded && agent.routines.map(\.name) == ["Morning briefing"]
    }
  }
}
