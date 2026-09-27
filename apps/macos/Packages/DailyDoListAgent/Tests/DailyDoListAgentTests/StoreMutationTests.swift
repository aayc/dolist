import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListAgentCore

@MainActor
struct StoreMutationTests {
  @Test func cancelledMessageRetainsItsOptimisticIDAndRetryUsesTheReceipt() async throws {
    let client = FakeDaemonClient()
    client.script { $0.thread = { _ in ThreadResponse(thread: Fixture.thread(), approvals: []) } }
    let journal = MutationJournalFixture()
    let store = AgentStore(client: client, mutationJournal: journal)
    await store.loadThread("thr_1")
    #expect(await !store.postMessage(threadId: "thr_1", text: "Synthetic reply"))
    let id = try #require(store.unsentMessages.keys.first)
    #expect(store.pendingMutations.map(\.id) == [id])
    #expect(await store.retryMessage(id, threadId: "thr_1"))
    #expect(await journal.ids == [id, id])
    #expect(client.calls("postMessage").isEmpty)
    #expect(store.thread("thr_1")?.messages.count == 1)
  }

  @Test func restoredMessageRemainsVisibleWithoutAutomaticDispatchOrDuplicateRows() async throws {
    let client = FakeDaemonClient()
    client.script { $0.thread = { _ in ThreadResponse(thread: Fixture.thread(), approvals: []) } }
    let journal = MutationJournalFixture()
    await journal.restore(
      PendingAgentMutation(
        id: "local-restored", command: .message(threadID: "thr_1", text: "Saved reply"),
        createdAt: Date()))
    let store = AgentStore(client: client, mutationJournal: journal)
    await store.refreshPendingMutations()
    await store.loadThread("thr_1")
    await store.loadThread("thr_1", force: true)
    #expect(store.thread("thr_1")?.messages.map(\.id) == ["local-restored"])
    #expect(store.unsentMessages["local-restored"] != nil)
    #expect(await journal.ids.isEmpty)
    #expect(client.calls("postMessage").isEmpty)
  }

  @Test func approvalChangedDuringDurablePreparationCannotBeSent() async throws {
    let client = FakeDaemonClient()
    let gate = Gate()
    let journal = MutationJournalFixture(gate: gate)
    let store = AgentStore(
      client: client, now: { Date(epochMillis: 1_000) }, mutationJournal: journal)
    let reviewed = Fixture.approval(expiresAt: 2_000)
    store.apply(.approvalUpsert(reviewed))
    let decision = Task {
      await store.decideReviewedApproval(
        reviewed, decision: .approve,
        reviewedRunner: nil, authorizationAvailable: true)
    }
    #expect(await waitForArrivals(gate))
    var changed = reviewed
    changed.summary = "A different action"
    store.apply(.approvalUpsert(changed))
    await gate.open()
    #expect(await !decision.value)
    #expect(await journal.authorized == false)
    #expect(client.calls("decideApproval").isEmpty)
    #expect(store.approvals[reviewed.id] == changed)
  }
}

private actor MutationJournalFixture: AgentMutationJournal {
  let gate: Gate?
  var ids: [String] = []
  var waiting: [PendingAgentMutation] = []
  var authorized = false

  init(gate: Gate? = nil) { self.gate = gate }
  func restore(_ record: PendingAgentMutation) { waiting = [record] }
  func pending() -> [PendingAgentMutation] { waiting }
  func resolve(_ operationID: String) -> AgentMutationResult { .thread(ThreadActionResponse()) }
  func perform(
    _ command: AgentMutationCommand, operationID: String?,
    authorize: @escaping @MainActor @Sendable () -> Bool
  ) async throws -> AgentMutationResult {
    let id = operationID ?? "control-id"
    ids.append(id)
    await gate?.wait()
    authorized = await authorize()
    guard authorized else { throw AgentMutationError.authorizationChanged }
    if waiting.isEmpty {
      waiting = [PendingAgentMutation(id: id, command: command, createdAt: Date())]
      throw DaemonClientError.cancelled
    }
    waiting = []
    return .thread(ThreadActionResponse())
  }
}
