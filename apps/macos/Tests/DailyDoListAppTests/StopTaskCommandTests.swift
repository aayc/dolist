import DailyDoListAgent
import DailyDoListClientTestSupport
import DailyDoListModels
import Testing

@testable import DailyDoListApp

/// Stop Task (⌘., the Agent menu, the chat bar's Stop) stops the thread open in the agent panel,
/// and only while its agent works.
@MainActor
@Suite("Stop Task command", .serialized)
struct StopTaskCommandTests {
  private func summary(_ id: String, _ status: TaskAgentStatus) -> ThreadSummary {
    ThreadSummary(
      id: id, taskId: nil, notePath: nil, title: id, status: status, createdAt: 1, updatedAt: 2,
      messageCount: 0, artifactCount: 0, surfaces: [], pendingApprovals: 0)
  }

  @Test func stopsTheOpenThreadOnlyWhileItsAgentWorks() async throws {
    let client = FakeDaemonClient()
    let model = AppModel(environment: makeEnvironment(client: client))
    await model.boot()
    let agent = AgentStore(client: client)
    agent.apply(.threadUpsert(summary("thr_busy", .working)))
    agent.apply(.threadUpsert(summary("thr_done", .done)))
    model.agent = agent
    let catalog = CommandCatalog(model: model)
    let command = try #require(catalog.command(.stopTask))
    #expect(command.title == "Stop Task")
    #expect(command.shortcut == Shortcut("."))
    #expect(CommandID(vimCommandID: "agent:stop") == .stopTask)

    model.ui.inspectorPresented = true
    model.ui.selectedThreadId = "thr_done"
    #expect(!command.isEnabled(), "nothing to stop")
    #expect(!catalog.run(.stopTask))
    model.ui.selectedThreadId = "thr_busy"
    model.ui.inspectorPresented = false
    #expect(!command.isEnabled(), "the panel is hidden")
    model.ui.inspectorPresented = true
    #expect(command.isEnabled())
    #expect(catalog.run(.stopTask))
    try await eventually("the thread was stopped") { client.calls("cancelThread").count == 1 }
    await model.teardown()
  }
}
