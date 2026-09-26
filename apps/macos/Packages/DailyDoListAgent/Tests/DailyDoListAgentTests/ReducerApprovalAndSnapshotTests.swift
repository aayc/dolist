import DailyDoListModels
import Testing

@testable import DailyDoListAgent

@Suite("Reducer: approvals, status, ignored events")
struct ReducerApprovalTests {
  @Test func upsertsApprovalsAndCountsPendingOnes() {
    var state = AgentState()
    #expect(state.apply(.approvalUpsert(Fixture.approval()), now: 0) == .approvals)
    #expect(state.pendingApprovals().map(\.id) == ["apr_1"])
    _ = state.apply(
      .approvalUpsert(Fixture.approval(status: .approved, scope: .once, decidedAt: 2)), now: 0)
    #expect(state.pendingApprovals().isEmpty)
  }

  @Test func aDecidedApprovalNeverTurnsPendingAgain() {
    var state = AgentState()
    _ = state.upsertApproval(Fixture.approval(status: .denied, decidedAt: 5))
    let decided = state
    #expect(state.apply(.approvalUpsert(Fixture.approval()), now: 0).isEmpty)
    #expect(state == decided)
    // A rollback or a 409 adopts it anyway.
    #expect(state.upsertApproval(Fixture.approval(), force: true) == .approvals)
    #expect(state.approvals["apr_1"]?.isPending == true)
  }

  @Test func approvalsConvergeWhateverTheOrder() {
    let pending = Fixture.approval()
    let approved = Fixture.approval(status: .approved, scope: .task, decidedAt: 3)
    var a = AgentState()
    _ = a.upsertApproval(pending)
    _ = a.upsertApproval(approved)
    var b = AgentState()
    _ = b.upsertApproval(approved)
    _ = b.upsertApproval(pending)
    #expect(a == b)
    #expect(a.approvals["apr_1"]?.status == .approved)
  }

  @Test func oneDecisionCanReplaceAnother() {
    var state = AgentState()
    _ = state.upsertApproval(Fixture.approval(status: .approved, decidedAt: 3))
    _ = state.upsertApproval(Fixture.approval(status: .expired, decidedAt: 4))
    #expect(state.approvals["apr_1"]?.status == .expired)
  }

  @Test func pendingApprovalsAreOldestFirst() {
    var state = AgentState()
    _ = state.upsertApproval(Fixture.approval("apr_b", createdAt: 9))
    _ = state.upsertApproval(Fixture.approval("apr_a", createdAt: 2))
    _ = state.upsertApproval(Fixture.approval("apr_c", status: .denied, createdAt: 1))
    #expect(state.pendingApprovals().map(\.id) == ["apr_a", "apr_b"])
    #expect(state.threadIdsWithPendingApprovals == ["thr_1"])
  }

  @Test func storesTheAgentStatusOnce() {
    var state = AgentState()
    #expect(state.apply(.agentStatus(Fixture.status()), now: 0) == .status)
    #expect(state.status == Fixture.status())
    #expect(state.apply(.agentStatus(Fixture.status()), now: 0).isEmpty)
  }

  @Test func ignoresEventsTheAgentStateDoesNotUse() {
    var state = Fixture.loaded()
    let before = state
    let events: [ServerEvent] = [
      .hello(HelloEvent(serverVersion: "1", apiVersion: 1)),
      .vaultChanged(
        VaultChangedEvent(
          changes: [VaultChange(path: Fixture.note, kind: .modified)], origin: .external)),
      .settingsChanged(.defaults),
      .error(ServerErrorEvent(message: "boom")),
      .surfaceFrame(Fixture.frame()),
      .unknown(type: "future.event", raw: ["type": "future.event", "x": 1]),
    ]
    for event in events { #expect(state.apply(event, now: 0).isEmpty) }
    #expect(state == before)
  }

  @Test func unknownMessageKindsAreKeptAndReplacedById() {
    var state = Fixture.loaded()
    let raw: JSONValue = [
      "kind": "poll", "id": "msg_poll", "author": "orchestrator", "createdAt": 3,
    ]
    _ = state.apply(
      .threadMessage(
        ThreadMessageEvent(
          threadId: "thr_1", message: .unknown(kind: "poll", id: "msg_poll", raw: raw))),
      now: 0)
    #expect(state.loadedThreads["thr_1"]?.messages.map(\.kind) == ["poll"])
    #expect(state.loadedThreads["thr_1"]?.messages.first?.author == "orchestrator")
  }
}

@Suite("Reducer: REST snapshots")
struct ReducerSnapshotTests {
  @Test func anUnfilteredThreadListReplacesEverySummary() {
    var state = AgentState()
    _ = state.upsertSummary(Fixture.summary("thr_gone"))
    _ = state.upsertSummary(Fixture.summary("thr_1", status: .working))
    #expect(
      state.applyThreadList([Fixture.summary("thr_1", status: .done, updatedAt: 5)], notePath: nil)
        == .threads)
    #expect(state.threads.keys.sorted() == ["thr_1"])
    #expect(state.threads["thr_1"]?.status == .done)
  }

  @Test func aFilteredListOnlyReplacesThatNotesSummaries() {
    var state = AgentState()
    _ = state.upsertSummary(Fixture.summary("thr_old_today"))
    _ = state.upsertSummary(Fixture.summary("thr_other", notePath: Fixture.otherNote))
    _ = state.applyThreadList([Fixture.summary("thr_new")], notePath: Fixture.note)
    #expect(state.threads.keys.sorted() == ["thr_new", "thr_other"])
  }

  @Test func theListKeepsSummariesThatEventsChangedWhileItWasInFlight() {
    var state = AgentState()
    _ = state.upsertSummary(Fixture.summary("thr_created", updatedAt: 50))
    _ = state.upsertSummary(Fixture.summary("thr_1", status: .done, updatedAt: 40))
    _ = state.applyThreadList(
      [Fixture.summary("thr_1", status: .working, updatedAt: 30)], notePath: nil,
      preserving: ["thr_created", "thr_1"])
    #expect(state.threads["thr_created"] != nil)
    #expect(state.threads["thr_1"]?.status == .done)
  }

  @Test func theListUpdatesLoadedThreadHeaders() {
    var state = Fixture.loaded(Fixture.thread(status: .working, updatedAt: 1))
    let changes = state.applyThreadList(
      [Fixture.summary(status: .done, updatedAt: 9)], notePath: nil)
    #expect(changes.contains(.loadedThreads))
    #expect(state.loadedThreads["thr_1"]?.status == .done)
  }

  @Test func pendingApprovalsReplaceTheLocalPendingSet() {
    var state = AgentState()
    _ = state.upsertApproval(Fixture.approval("apr_gone"))
    _ = state.upsertApproval(Fixture.approval("apr_new_during_fetch"))
    _ = state.upsertApproval(Fixture.approval("apr_decided", status: .approved, decidedAt: 2))
    _ = state.upsertApproval(Fixture.approval("apr_optimistic", status: .denied, decidedAt: 3))
    _ = state.applyPendingApprovals(
      [Fixture.approval("apr_listed"), Fixture.approval("apr_optimistic")],
      preserving: ["apr_new_during_fetch"])
    #expect(state.approvals["apr_gone"] == nil)
    #expect(state.approvals["apr_new_during_fetch"]?.isPending == true)
    #expect(state.approvals["apr_listed"]?.isPending == true)
    #expect(state.approvals["apr_decided"]?.status == .approved)
    // Our (optimistic) decision isn't undone by an older pending copy.
    #expect(state.approvals["apr_optimistic"]?.status == .denied)
  }

  @Test func aThreadResponseMergesApprovalsAndComputesTheSummary() {
    var state = AgentState()
    let thread = Fixture.thread(
      updatedAt: 7,
      messages: [
        Fixture.text("m1", "First", streaming: false), Fixture.toolCall("t"),
        Fixture.text("m2", "Latest **news**", streaming: false),
      ],
      surfaces: [.browser])
    let changes = state.applyThreadResponse(
      ThreadResponse(
        thread: thread, approvals: [Fixture.approval(), Fixture.approval("apr_2", status: .denied)])
    )
    #expect(changes == [.approvals, .threads, .loadedThreads])
    #expect(state.approvals["apr_1"]?.isPending == true)
    let summary = state.threads["thr_1"]
    #expect(summary?.pendingApprovals == 1)
    #expect(summary?.messageCount == 3)
    #expect(summary?.lastMessagePreview == "Latest **news**")
    #expect(summary?.surfaces == [.browser])
    #expect(state.loadedThreads["thr_1"] == thread)
  }

  @Test func aNewerSummaryWinsOverAnOlderThreadResponse() {
    var state = AgentState()
    _ = state.upsertSummary(
      Fixture.summary(title: "Renamed", status: .done, updatedAt: 20, surfaces: [.computer]))
    _ = state.applyThreadResponse(
      ThreadResponse(thread: Fixture.thread(status: .working, updatedAt: 10), approvals: []))
    let thread = state.loadedThreads["thr_1"]
    #expect(thread?.status == .done)
    #expect(thread?.title == "Renamed")
    #expect(thread?.surfaces == [.computer])
    #expect(state.threads["thr_1"]?.updatedAt == 20)
  }

  @Test func aThreadResponseKeepsInFlightOptimisticMessagesOnly() {
    var state = Fixture.loaded()
    _ = state.insertOptimisticMessage(
      TextMessage(id: "local-a", author: "you", createdAt: 1, role: .user, text: "A"),
      threadId: "thr_1")
    _ = state.insertOptimisticMessage(
      TextMessage(id: "local-b", author: "you", createdAt: 2, role: .user, text: "B"),
      threadId: "thr_1")
    _ = state.insertOptimisticMessage(
      TextMessage(id: "local-c", author: "you", createdAt: 3, role: .user, text: "C"),
      threadId: "thr_1")
    let response = Fixture.thread(
      updatedAt: 5,
      messages: [Fixture.text("srv_a", "A", streaming: nil, role: .user, author: "you")])
    _ = state.applyThreadResponse(
      ThreadResponse(thread: response, approvals: []), inFlight: ["local-a", "local-b"])
    // A arrived with the response, B is still being sent, C's request already finished.
    #expect(state.loadedThreads["thr_1"]?.messages.map(\.id) == ["srv_a", "local-b"])
    #expect(state.optimisticMessages["thr_1"] == ["local-b"])
  }

  @Test func aThreadResponseClearsDeltaPlaceholders() {
    var state = Fixture.loaded()
    _ = state.appendDelta("partial", messageId: "msg_x", threadId: "thr_1", now: 0)
    #expect(state.deltaPlaceholders.count == 1)
    _ = state.applyThreadResponse(
      ThreadResponse(thread: Fixture.thread(updatedAt: 3), approvals: []))
    #expect(state.deltaPlaceholders.isEmpty)
    #expect(state.loadedThreads["thr_1"]?.messages.isEmpty == true)
  }
}
