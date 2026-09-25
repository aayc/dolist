import DailyDoListClient
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListAgent

/// The orchestrator's own chat in the store: pinned apart from the inbox's sections, loaded on
/// refresh, its decisions linked to their tasks, and talked to like any thread.
@MainActor
@Suite("Store: the orchestrator's chat")
struct OrchestratorChatTests {
  let client = FakeDaemonClient()
  let store: AgentStore

  init() {
    store = AgentStore(client: client, now: { Date(epochMillis: 1_000) })
  }

  private nonisolated static func spawn(_ id: String, taskId: String) -> ThreadMessage {
    .toolCall(
      ToolCallMessage(
        id: id, author: "orchestrator", createdAt: 1, toolCallId: "call_\(id)",
        toolName: "spawn_subagent", label: "Delegate to subagent",
        input: ["taskId": .string(taskId), "goal": "x", "capabilities": ["web"]], status: .ok))
  }

  private var orchestrator: ThreadSummary {
    Fixture.summary(
      OrchestratorThread.id, taskId: nil, notePath: nil, title: "Orchestrator", status: .working,
      createdAt: 1_000, updatedAt: 1_000)
  }

  @Test func isPinnedApartFromTheInboxSections() {
    store.apply(.threadUpsert(orchestrator))
    store.apply(.threadUpsert(Fixture.summary("thr_1", createdAt: 1_000, updatedAt: 1_000)))
    let sections = store.inboxSections(now: Date(epochMillis: 1_000))
    #expect(sections.flatMap(\.threads).map(\.id) == ["thr_1"])
    #expect(store.orchestratorSummary?.status == .working)
    // Its turn isn't a running subagent.
    #expect(store.runningCount == 1)
  }

  @Test func linksEachDecisionToItsTasksNewestThreadOrRecord() {
    store.apply(
      .threadUpsert(Fixture.summary("thr_old", taskId: "tsk_desk", title: "Old", updatedAt: 1)))
    store.apply(
      .threadUpsert(
        Fixture.summary("thr_new", taskId: "tsk_desk", title: "Research desks", updatedAt: 5)))
    store.apply(.taskRecord(Fixture.record("tsk_gym", text: "Go to the gym")))
    let messages = [
      Self.spawn("m1", taskId: "tsk_desk"), Self.spawn("m2", taskId: "tsk_gym"),
      Self.spawn("m3", taskId: "tsk_unknown"), Fixture.text("m4", "Hi", streaming: false),
    ]
    #expect(messages.map(\.orchestratorTaskId) == ["tsk_desk", "tsk_gym", "tsk_unknown", nil])
    #expect(
      store.taskLinks(for: messages) == [
        "tsk_desk": OrchestratorTaskLink(
          taskId: "tsk_desk", threadId: "thr_new", title: "Research desks"),
        "tsk_gym": OrchestratorTaskLink(taskId: "tsk_gym", threadId: nil, title: "Go to the gym"),
      ])
  }

  @Test func refreshLoadsItQuietlyEvenWithTodaysFilter() async {
    client.script {
      $0.agentStatus = { Fixture.status(running: 0) }
      $0.thread = { id in
        ThreadResponse(
          thread: Fixture.thread(
            id, taskId: nil, notePath: nil, title: "Orchestrator", status: .idle,
            messages: [Self.spawn("m1", taskId: "tsk_1")]), approvals: [])
      }
    }
    await store.refresh(todayNotePath: Fixture.note)
    #expect(client.callLog.contains("threads:\(Fixture.note)"))
    #expect(store.orchestratorThread?.messages.map(\.id) == ["m1"])
    #expect(store.orchestratorSummary?.title == "Orchestrator")
  }

  @Test func aDaemonWithoutOneIsNoError() async {
    client.script { $0.agentStatus = { Fixture.status(running: 0) } }
    await store.refresh(todayNotePath: Fixture.note)
    #expect(client.count("thread:\(OrchestratorThread.id)") == 1)
    #expect(store.orchestratorSummary == nil)
    #expect(store.failedThreadIds == [OrchestratorThread.id])
    #expect(store.lastError == nil)
  }

  @Test func aTurnToShowStaysAskedForUntilTheChatShowsIt() {
    #expect(store.orchestratorFocus == nil)
    store.focusOrchestratorMessage("msg_1")
    let first = store.orchestratorFocus
    #expect(first?.messageId == "msg_1")
    store.focusOrchestratorMessage("msg_2")
    let second = store.orchestratorFocus
    #expect(second?.messageId == "msg_2" && second?.serial != first?.serial)
    store.orchestratorFocusShown(first?.serial ?? 0)
    #expect(store.orchestratorFocus == second, "an older request's showing doesn't end a newer one")
    store.orchestratorFocusShown(second?.serial ?? 0)
    #expect(store.orchestratorFocus == nil)
  }

  @Test func writingAndStoppingGoThroughTheThreadRoutes() async {
    #expect(await store.postMessage(threadId: OrchestratorThread.id, text: "What are you doing?"))
    #expect(await store.cancelThread(OrchestratorThread.id))
    #expect(
      client.callLog.suffix(2) == [
        "postMessage:\(OrchestratorThread.id)", "cancelThread:\(OrchestratorThread.id)",
      ])
  }
}
