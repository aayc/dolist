import DailyDoListClient
import DailyDoListModels
import Foundation
import Observation
import Testing

@testable import DailyDoListAgent

@MainActor
@Suite("Store: events and commands")
struct StoreCommandTests {
  let client = FakeDaemonClient()
  let store: AgentStore

  init() {
    store = AgentStore(
      client: client, now: { Date(epochMillis: 1_000) }, artifactRefetchDelay: .milliseconds(10))
  }

  /// Loads thread_1 (with the given messages/approvals) through the store.
  private func loadThread(
    _ thread: AgentThread = Fixture.thread(), approvals: [ApprovalRequest] = []
  ) async {
    client.script { $0.thread = { _ in ThreadResponse(thread: thread, approvals: approvals) } }
    await store.loadThread(thread.id)
  }

  // MARK: Events & queries

  @Test func appliesEventsAndAnswersQueries() {
    store.apply(.taskRecord(Fixture.record(threadId: "thr_1", unread: 2)))
    store.apply(.threadUpsert(Fixture.summary(status: .waitingUser, updatedAt: Date().epochMillis)))
    store.apply(.approvalUpsert(Fixture.approval()))
    store.apply(.agentStatus(Fixture.status(running: 3)))
    #expect(store.records(for: Fixture.note).map(\.taskId) == ["tsk_1"])
    #expect(store.records(for: "Other.md").isEmpty)
    #expect(store.unreadCount(forThread: "thr_1") == 2)
    #expect(store.pendingApprovalCount == 1)
    #expect(store.pendingApprovals(forThread: "thr_1").count == 1)
    #expect(store.runningCount == 3)
    #expect(store.threadTitle("thr_1") == "Buy milk")
    #expect(store.threadStatus("thr_1") == .waitingUser)
    #expect(store.inboxSections().map(\.group) == [.needsYou])
  }

  /// Whether reading `read` registers an observation that `change` triggers.
  private func notifies(_ read: @escaping () -> Void, when change: () -> Void) -> Bool {
    let fired = Locked(false)
    withObservationTracking(read) { fired.mutate { $0 = true } }
    change()
    return fired.current
  }

  @Test func streamedTokensOnlyWakeThreadObservers() async {
    await loadThread(Fixture.thread(messages: [Fixture.text()]))
    let delta = ServerEvent.threadDelta(ThreadDeltaEvent(threadId: "thr_1", messageId: "msg_1", delta: "Hi"))
    #expect(!notifies({ _ = store.recordsByNote }, when: { store.apply(delta) }))
    #expect(!notifies({ _ = store.approvals }, when: { store.apply(delta) }))
    #expect(!notifies({ _ = store.threads }, when: { store.apply(delta) }))
    #expect(notifies({ _ = store.loadedThreads }, when: { store.apply(delta) }))
    #expect(notifies({ _ = store.records(for: Fixture.note) }, when: { store.apply(.taskRecord(Fixture.record())) }))
  }

  @Test func duplicateEventsNotifyNobody() {
    store.apply(.approvalUpsert(Fixture.approval()))
    store.apply(.taskRecord(Fixture.record()))
    store.apply(.threadUpsert(Fixture.summary()))
    let read = {
      _ = store.approvals
      _ = store.recordsByNote
      _ = store.threads
      _ = store.status
    }
    #expect(!notifies(read) {
      store.apply(.approvalUpsert(Fixture.approval()))
      store.apply(.taskRecord(Fixture.record()))
      store.apply(.threadUpsert(Fixture.summary()))
      store.apply(.hello(HelloEvent(serverVersion: "1", apiVersion: 1)))
    })
  }

  @Test func runningCountFallsBackToThreadsUntilTheStatusIsKnown() {
    store.apply(.threadUpsert(Fixture.summary("thr_a", status: .working)))
    store.apply(.threadUpsert(Fixture.summary("thr_b", status: .done)))
    #expect(store.runningCount == 1)
  }

  @Test func availabilityFollowsTheStatus() {
    #expect(store.isAgentAvailable)
    store.apply(.agentStatus(Fixture.status(enabled: false)))
    #expect(store.unavailableReason == "The agent is paused.")
    store.apply(.agentStatus(Fixture.status(mode: .off)))
    #expect(store.unavailableReason == "The agent is off.")
    store.apply(.agentStatus(Fixture.status(problem: "Missing OPENROUTER_API_KEY")))
    #expect(store.unavailableReason == "Missing OPENROUTER_API_KEY")
    #expect(!store.isAgentAvailable)
  }

  @Test func handleRoutesStreamItems() async {
    store.handle(.state(.connected(serverVersion: "1.0")))
    #expect(store.connectionState == .connected(serverVersion: "1.0"))
    store.handle(.event(.approvalUpsert(Fixture.approval())))
    #expect(store.pendingApprovalCount == 1)
    client.script { $0.agentStatus = { Fixture.status(running: 7) } }
    store.handle(.resync)
    #expect(await eventually { store.status?.running == 7 })
  }

  // MARK: Threads

  @Test func concurrentLoadsShareOneRequestAndKeepMessagesThatArriveMeanwhile() async {
    let gate = Gate()
    client.script {
      $0.thread = { _ in
        await gate.wait()
        return ThreadResponse(thread: Fixture.thread(messages: [Fixture.text("m1", "Hi", streaming: false)]), approvals: [])
      }
    }
    async let first: Void = store.loadThread("thr_1")
    async let second: Void = store.loadThread("thr_1")
    #expect(await waitForArrivals(gate))
    #expect(store.loadingThreadIds == ["thr_1"])
    // Pushed while the fetch is in flight (after the daemon took its snapshot).
    store.apply(.threadMessage(ThreadMessageEvent(threadId: "thr_1", message: Fixture.toolCall("m2"))))
    await gate.open()
    _ = await (first, second)
    #expect(client.count("thread:") == 1)
    #expect(store.thread("thr_1")?.messages.map(\.id) == ["m1", "m2"])
    #expect(store.loadingThreadIds.isEmpty)
    // Loaded threads aren't refetched unless forced.
    await store.loadThread("thr_1")
    #expect(client.count("thread:") == 1)
  }

  @Test func aFailedLoadIsReportedAndCanBeRetried() async {
    await store.loadThread("thr_1")
    #expect(store.failedThreadIds == ["thr_1"])
    #expect(store.lastError?.title == "Couldn't load the thread")
    await loadThread()
    #expect(store.failedThreadIds.isEmpty)
    #expect(store.thread("thr_1") != nil)
  }

  @Test func anArtifactMessageForAnUnknownArtifactRefetchesTheThread() async {
    await loadThread()
    let artifact = ArtifactMeta(
      id: "art_1", threadId: "thr_1", title: "Draft", kind: .markdown, mimeType: "text/markdown",
      path: ".daily-do-list/artifacts/thr_1/art_1.md", size: 10, createdAt: 2)
    client.script {
      $0.thread = { _ in
        ThreadResponse(
          thread: Fixture.thread(
            updatedAt: 3,
            messages: [.artifact(ArtifactMessage(id: "m_art", author: "subagent:writer", createdAt: 2, artifactId: "art_1"))],
            artifacts: [artifact]),
          approvals: [])
      }
    }
    store.apply(
      .threadMessage(
        ThreadMessageEvent(
          threadId: "thr_1",
          message: .artifact(ArtifactMessage(id: "m_art", author: "subagent:writer", createdAt: 2, artifactId: "art_1")))))
    #expect(await eventually { store.artifactMeta(threadId: "thr_1", artifactId: "art_1") == artifact })
    #expect(client.count("thread:") == 2)
  }

  @Test func markReadTellsTheDaemonAndClearsTheBadge() async {
    store.apply(.taskRecord(Fixture.record(threadId: "thr_1", unread: 4)))
    store.markRead("thr_1")
    #expect(store.unreadCount(forThread: "thr_1") == 0)
    await store.flushClientEvents()
    #expect(client.sent == [.threadRead(threadId: "thr_1")])
  }

  @Test func cancelAndRetryReportFailures() async {
    #expect(await store.cancelThread("thr_1"))
    #expect(await store.retryThread("thr_1"))
    client.script {
      $0.cancelThread = { _ in throw DaemonClientError.http(status: 503, body: ApiErrorBody(error: .agentUnavailable, message: "The agent is off")) }
      $0.retryThread = { _ in throw DaemonClientError.unreachable("connection refused") }
    }
    #expect(await store.cancelThread("thr_1") == false)
    #expect(store.lastError == AgentAlert(id: store.lastError?.id ?? UUID(), title: "Couldn't stop the task", message: "The agent is off"))
    #expect(await store.retryThread("thr_1") == false)
    #expect(store.lastError?.title == "Couldn't retry the task")
    store.dismissError(UUID())
    #expect(store.lastError != nil, "only the given toast is dismissed")
    store.dismissError()
    #expect(store.lastError == nil)
  }

  // MARK: Decisions

  @Test func anApprovalFlipsImmediatelyAndAdoptsTheDaemonsCopy() async {
    let gate = Gate()
    store.apply(.approvalUpsert(Fixture.approval()))
    client.script {
      $0.decideApproval = { id, request in
        await gate.wait()
        return Fixture.approval(id, status: .approved, scope: request.scope, decidedAt: 1_234)
      }
    }
    let decision = Task { await store.decide("apr_1", .approve, scope: .task) }
    #expect(await waitForArrivals(gate))
    let optimistic = store.approvals["apr_1"]
    #expect(optimistic?.status == .approved)
    #expect(optimistic?.scope == .task)
    #expect(optimistic?.decidedAt == 1_000)
    #expect(store.decidingApprovalIds == ["apr_1"])
    #expect(store.pendingApprovalCount == 0)
    await gate.open()
    #expect(await decision.value)
    #expect(store.approvals["apr_1"]?.decidedAt == 1_234)
    #expect(store.decidingApprovalIds.isEmpty)
    #expect(client.callLog.contains("decideApproval:apr_1:approve:task"))
  }

  @Test func aFailedDecisionRollsBack() async {
    let original = Fixture.approval(expiresAt: 99_000)
    store.apply(.approvalUpsert(original))
    client.script { $0.decideApproval = { _, _ in throw DaemonClientError.unreachable("offline") } }
    #expect(await store.decide("apr_1", .deny, note: "  not now ") == false)
    #expect(store.approvals["apr_1"] == original)
    #expect(store.lastError?.title == "Couldn't send your decision")
    #expect(store.decidingApprovalIds.isEmpty)
  }

  @Test func aDenialSendsTheTrimmedNoteAndNoScope() async {
    store.apply(.approvalUpsert(Fixture.approval()))
    let received = Locked<ApprovalDecisionRequest?>(nil)
    client.script {
      $0.decideApproval = { id, request in
        received.mutate { $0 = request }
        return Fixture.approval(id, status: .denied, decidedAt: 2)
      }
    }
    #expect(await store.decide("apr_1", .deny, scope: .task, note: "  Too pricey \n"))
    #expect(received.current == ApprovalDecisionRequest(decision: .deny, scope: nil, note: "Too pricey"))
  }

  @Test func aConflictAdoptsTheDaemonsState() async {
    store.apply(.approvalUpsert(Fixture.approval()))
    let expired = Fixture.approval(status: .expired, decidedAt: 500)
    client.script {
      $0.decideApproval = { _, _ in throw DaemonClientError.approvalConflict(ApprovalConflictResponse(approval: expired)) }
    }
    #expect(await store.decide("apr_1", .approve) == false)
    #expect(store.approvals["apr_1"] == expired)
    #expect(store.lastError?.title == "Already decided")
    #expect(store.lastError?.message == "This approval expired before your decision arrived.")
  }

  @Test func noRollbackWhenAnEventAlreadyDeliveredTheDecision() async {
    let gate = Gate()
    store.apply(.approvalUpsert(Fixture.approval()))
    client.script {
      $0.decideApproval = { _, _ in
        await gate.wait()
        throw DaemonClientError.unreachable("response lost")
      }
    }
    let decision = Task { await store.decide("apr_1", .approve) }
    #expect(await waitForArrivals(gate))
    let fromDaemon = Fixture.approval(status: .approved, scope: .once, decidedAt: 777)
    store.apply(.approvalUpsert(fromDaemon))
    await gate.open()
    #expect(await decision.value == false)
    #expect(store.approvals["apr_1"] == fromDaemon)
  }

  @Test func alreadyDecidedApprovalsAreNotSentAgain() async {
    store.apply(.approvalUpsert(Fixture.approval(status: .denied, decidedAt: 3)))
    #expect(await store.decide("apr_1", .approve) == false)
    #expect(client.count("decideApproval") == 0)
  }

  @Test func anApprovalWeDontKnowIsStillDecided() async {
    client.script { $0.decideApproval = { id, _ in Fixture.approval(id, status: .approved, scope: .once, decidedAt: 4) } }
    #expect(await store.decide("apr_remote", .approve))
    #expect(store.approvals["apr_remote"]?.status == .approved)
  }

  // MARK: Replies

  @Test func aReplyShowsAtOnceAndIsReplacedByTheDaemonsCopy() async {
    await loadThread()
    let gate = Gate()
    client.script {
      $0.postMessage = { _, _ in
        await gate.wait()
        return ThreadActionResponse(ok: true, pending: true)
      }
    }
    let reply = Task { await store.postMessage(threadId: "thr_1", text: "  Patio please \n") }
    #expect(await waitForArrivals(gate))
    guard case .text(let local) = store.thread("thr_1")?.messages.last else {
      Issue.record("expected the optimistic message")
      return
    }
    #expect(local.text == "Patio please")
    #expect(local.author == "you")
    #expect(local.role == .user)
    #expect(store.sendingMessageIds == [local.id])
    // The daemon echoes the message (it trims it too) before answering the request.
    store.apply(
      .threadMessage(
        ThreadMessageEvent(threadId: "thr_1", message: Fixture.text("msg_srv", "Patio please", streaming: nil, role: .user, author: "you"))))
    #expect(store.thread("thr_1")?.messages.map(\.id) == ["msg_srv"])
    await gate.open()
    #expect(await reply.value)
    #expect(store.sendingMessageIds.isEmpty)
  }

  @Test func aFailedReplyIsRemovedAndReported() async {
    await loadThread()
    client.script { $0.postMessage = { _, _ in throw DaemonClientError.http(status: 503, body: nil) } }
    #expect(await store.postMessage(threadId: "thr_1", text: "Hello") == false)
    #expect(store.thread("thr_1")?.messages.isEmpty == true)
    #expect(store.lastError?.title == "Couldn't send your message")
    #expect(store.lastError?.message == "The daemon answered HTTP 503.")
  }

  @Test func blankRepliesAreNotSent() async {
    #expect(await store.postMessage(threadId: "thr_1", text: " \n ") == false)
    #expect(client.count("postMessage") == 0)
  }

  // MARK: Pause / resume

  @Test func pausingIsOptimisticAndAdoptsTheDaemonsStatus() async {
    store.apply(.agentStatus(Fixture.status(enabled: true)))
    let gate = Gate()
    client.script {
      $0.setAgentEnabled = { enabled in
        await gate.wait()
        return Fixture.status(enabled: enabled, running: 0)
      }
    }
    let pause = Task { await store.setEnabled(false) }
    #expect(await waitForArrivals(gate))
    #expect(store.status?.enabled == false)
    #expect(store.status?.running == 1)
    await gate.open()
    await pause.value
    #expect(store.status == Fixture.status(enabled: false, running: 0))
  }

  @Test func aFailedPauseRollsBack() async {
    store.apply(.agentStatus(Fixture.status(enabled: true)))
    client.script { $0.setAgentEnabled = { _ in throw DaemonClientError.unreachable("offline") } }
    await store.setEnabled(false)
    #expect(store.status?.enabled == true)
    #expect(store.lastError?.title == "Couldn't pause the agent")
  }

  // MARK: Artifacts

  @Test func fetchesArtifactBytes() async throws {
    client.script { $0.artifact = { _, _ in ArtifactPayload(data: Data("# Hi".utf8), mimeType: "text/markdown") } }
    let payload = try await store.fetchArtifact(threadId: "thr_1", artifactId: "art_1")
    #expect(payload.mimeType == "text/markdown")
    #expect(client.callLog == ["artifact:thr_1/art_1"])
  }
}
