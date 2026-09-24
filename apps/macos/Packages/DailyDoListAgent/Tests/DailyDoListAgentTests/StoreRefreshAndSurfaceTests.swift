import AppKit
import DailyDoListClient
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListAgent

@MainActor
@Suite("Store: resync")
struct StoreRefreshTests {
  let client = FakeDaemonClient()
  let store: AgentStore

  init() {
    store = AgentStore(client: client, now: { Date(epochMillis: 1_000) })
  }

  @Test func refreshReplacesStateWithTheDaemonsSnapshots() async {
    // Stale local state from before a disconnect.
    store.apply(.agentStatus(Fixture.status(running: 5)))
    store.apply(.approvalUpsert(Fixture.approval("apr_decided_elsewhere")))
    store.apply(.threadUpsert(Fixture.summary("thr_gone")))
    store.apply(.taskRecord(Fixture.record("tsk_gone")))
    client.script {
      $0.thread = { id in
        ThreadResponse(thread: Fixture.thread(id, status: .done, updatedAt: 30, messages: [Fixture.text("m", "Done", streaming: false)]), approvals: [])
      }
    }
    await store.loadThread("thr_1")
    await store.loadRecords(for: Fixture.note)

    client.script {
      $0.agentStatus = { Fixture.status(running: 0) }
      $0.approvals = { _ in [Fixture.approval("apr_new")] }
      $0.threads = { _, _ in [Fixture.summary("thr_1", status: .done, updatedAt: 30), Fixture.summary("thr_2")] }
      $0.taskRecords = { _ in [Fixture.record("tsk_1", status: .done, updatedAt: 30)] }
      $0.thread = { id in
        ThreadResponse(
          thread: Fixture.thread(id, status: .done, updatedAt: 30, messages: [Fixture.text("m", "Done", streaming: false), Fixture.text("m2", "Anything else?", streaming: false)]),
          approvals: [])
      }
    }
    await store.refresh()

    #expect(store.status?.running == 0)
    #expect(store.pendingApprovals.map(\.id) == ["apr_new"])
    #expect(store.threads.keys.sorted() == ["thr_1", "thr_2"])
    #expect(store.records(for: Fixture.note).map(\.taskId) == ["tsk_1"])
    #expect(store.thread("thr_1")?.messages.map(\.id) == ["m", "m2"])
    #expect(client.callLog.contains("approvals:pending"))
    #expect(client.callLog.contains("threads:*"))
    #expect(client.count("thread:thr_1") == 2)
    #expect(store.lastError == nil)
  }

  @Test func refreshFetchesTodaysThreadsAndKeepsOtherNotes() async {
    store.apply(.threadUpsert(Fixture.summary("thr_other", notePath: Fixture.otherNote)))
    store.apply(.threadUpsert(Fixture.summary("thr_stale_today")))
    client.script {
      $0.agentStatus = { Fixture.status() }
      $0.threads = { notePath, _ in notePath == Fixture.note ? [Fixture.summary("thr_today")] : [] }
      $0.taskRecords = { note in [Fixture.record(notePath: note)] }
    }
    await store.refresh(todayNotePath: Fixture.note)
    #expect(store.todayNotePath == Fixture.note)
    #expect(store.threads.keys.sorted() == ["thr_other", "thr_today"])
    #expect(client.callLog.contains("threads:\(Fixture.note)"))
    #expect(client.callLog.contains("taskRecords:\(Fixture.note)"))
    #expect(store.records(for: Fixture.note).count == 1)
  }

  @Test func eventsDuringARefreshAreNotOverwritten() async {
    let gate = Gate()
    client.script {
      $0.agentStatus = { Fixture.status() }
      $0.approvals = { _ in
        await gate.wait()
        return [Fixture.approval("apr_1")]
      }
      $0.threads = { _, _ in
        await gate.wait()
        return [Fixture.summary("thr_1", status: .working, updatedAt: 5)]
      }
    }
    let refresh = Task { await store.refresh() }
    #expect(await waitForArrivals(gate, 2))
    // Newer than the snapshots the daemon is about to return.
    store.apply(.threadUpsert(Fixture.summary("thr_1", status: .done, updatedAt: 9)))
    store.apply(.threadUpsert(Fixture.summary("thr_new", updatedAt: 9)))
    store.apply(.approvalUpsert(Fixture.approval("apr_1", status: .approved, decidedAt: 8)))
    store.apply(.approvalUpsert(Fixture.approval("apr_2")))
    await gate.open()
    await refresh.value
    #expect(store.threads["thr_1"]?.status == .done)
    #expect(store.threads["thr_new"] != nil)
    #expect(store.approvals["apr_1"]?.status == .approved)
    #expect(store.approvals["apr_2"]?.isPending == true)
  }

  @Test func onlyTheLatestOverlappingRefreshApplies() async {
    let gate = Gate()
    let calls = Locked(0)
    client.script {
      $0.agentStatus = {
        let call = calls.mutate { value -> Int in
          value += 1
          return value
        }
        if call == 1 {
          await gate.wait()
          return Fixture.status(running: 1)
        }
        return Fixture.status(running: 2)
      }
    }
    let older = Task { await store.refresh() }
    #expect(await waitForArrivals(gate))
    await store.refresh()
    #expect(store.status?.running == 2)
    await gate.open()
    await older.value
    #expect(store.status?.running == 2)
  }

  @Test func aPartialFailureAppliesWhatSucceeded() async {
    client.script {
      $0.agentStatus = { throw DaemonClientError.unreachable("connection refused") }
      $0.approvals = { _ in [Fixture.approval()] }
    }
    await store.refresh()
    #expect(store.pendingApprovalCount == 1)
    #expect(store.lastError?.title == "Couldn't refresh the agent's state")
  }

  @Test func recordsLoadOncePerNoteAndRefreshRefetchesThem() async {
    client.script { $0.taskRecords = { note in [Fixture.record(notePath: note)] } }
    await store.loadRecords(for: Fixture.note)
    await store.loadRecords(for: Fixture.note)
    #expect(client.count("taskRecords:") == 1)
    client.script { $0.agentStatus = { Fixture.status() } }
    await store.refresh()
    #expect(client.count("taskRecords:") == 2)
    store.forgetRecords(for: Fixture.note)
    await store.refresh()
    #expect(client.count("taskRecords:") == 2)
  }

  @Test func aRecordsFetchNeverOverwritesANewerPush() async {
    let gate = Gate()
    client.script {
      $0.taskRecords = { note in
        await gate.wait()
        return [Fixture.record("tsk_old", notePath: note)]
      }
    }
    let load = Task { await store.loadRecords(for: Fixture.note) }
    #expect(await waitForArrivals(gate))
    store.apply(.taskRecords(TaskRecordsEvent(notePath: Fixture.note, records: [Fixture.record("tsk_pushed")])))
    await gate.open()
    await load.value
    #expect(store.records(for: Fixture.note).map(\.taskId) == ["tsk_pushed"])
  }
}

@MainActor
@Suite("Store: live surfaces")
struct StoreSurfaceTests {
  let client = FakeDaemonClient()
  let store: AgentStore

  init() {
    store = AgentStore(client: client, now: { Date(epochMillis: 1_000) })
  }

  @Test func subscriptionsAreRefCounted() async {
    store.subscribe(threadId: "thr_1", surface: .browser)
    store.subscribe(threadId: "thr_1", surface: .browser)
    store.subscribe(threadId: "thr_1", surface: .computer)
    store.unsubscribe(threadId: "thr_1", surface: .browser)
    #expect(store.subscribedSurfaces == [SurfaceKey(threadId: "thr_1", surface: .browser), SurfaceKey(threadId: "thr_1", surface: .computer)])
    store.unsubscribe(threadId: "thr_1", surface: .browser)
    store.unsubscribe(threadId: "thr_1", surface: .browser)
    store.unsubscribe(threadId: "thr_2", surface: .computer)
    await store.flushClientEvents()
    #expect(client.sent == [
      .surfaceSubscribe(threadId: "thr_1", surface: .browser),
      .surfaceSubscribe(threadId: "thr_1", surface: .computer),
      .surfaceUnsubscribe(threadId: "thr_1", surface: .browser),
    ])
  }

  @Test func subscribeAndUnsubscribeReachTheDaemonInOrder() async {
    for _ in 0..<20 {
      store.subscribe(threadId: "thr_1", surface: .browser)
      store.unsubscribe(threadId: "thr_1", surface: .browser)
    }
    await store.flushClientEvents()
    let expected = Array(
      repeating: [ClientEvent.surfaceSubscribe(threadId: "thr_1", surface: .browser), .surfaceUnsubscribe(threadId: "thr_1", surface: .browser)],
      count: 20
    ).flatMap { $0 }
    #expect(client.sent == expected)
    // A resync doesn't re-send them: the client re-subscribes after reconnecting.
    client.script { $0.agentStatus = { Fixture.status() } }
    await store.refresh()
    await store.flushClientEvents()
    #expect(client.sent.count == 40)
  }

  @Test func keepsTheLatestFrameAndIgnoresLateOnes() {
    store.apply(.surfaceFrame(Fixture.frame(ts: 5)))
    store.apply(.surfaceFrame(Fixture.frame(ts: 3)))
    #expect(store.latestFrame(threadId: "thr_1", surface: .browser)?.ts == 5)
    store.apply(.surfaceFrame(Fixture.frame(ts: 8)))
    #expect(store.latestFrame(threadId: "thr_1", surface: .browser)?.ts == 8)
    #expect(store.latestFrame(threadId: "thr_1", surface: .computer) == nil)
  }

  @Test func logsActionsWithoutConsecutiveRepeats() {
    let click = SurfaceFrameAction(kind: "click", x: 10, y: 20)
    store.apply(.surfaceFrame(Fixture.frame(surface: .computer, ts: 1, action: click)))
    store.apply(.surfaceFrame(Fixture.frame(surface: .computer, ts: 2, action: click)))
    store.apply(.surfaceFrame(Fixture.frame(surface: .computer, ts: 3, action: SurfaceFrameAction(kind: "type", text: "beans"))))
    store.apply(.surfaceFrame(Fixture.frame(surface: .computer, ts: 4, action: click)))
    let actions = store.recentActions(threadId: "thr_1", surface: .computer)
    #expect(actions.map(\.kind) == ["click", "type", "click"])
    #expect(actions.map(\.ts) == [1, 3, 4])
    #expect(actions[1].summary == "type “beans”")
    #expect(actions[0].summary == "click at 10, 20")
  }

  @Test func theActionLogIsCapped() {
    for index in 0..<60 {
      store.apply(
        .surfaceFrame(Fixture.frame(surface: .computer, ts: EpochMillis(index), action: SurfaceFrameAction(kind: "click", x: Double(index), y: 1))))
    }
    let actions = store.recentActions(threadId: "thr_1", surface: .computer)
    #expect(actions.count == SurfaceFeed.maxActions)
    #expect(actions.last?.x == 59)
  }

  @Test func decodesFramesOncePerTimestamp() throws {
    let first = Fixture.frame(ts: 1)
    store.apply(.surfaceFrame(first))
    let image = try #require(store.image(for: first))
    #expect(store.image(for: first) === image)
    let second = Fixture.frame(ts: 2)
    store.apply(.surfaceFrame(second))
    #expect(store.image(for: second) !== image)
    #expect(store.image(for: Fixture.frame(ts: 3, data: "not base64!")) == nil)
  }

  @Test func framesOfUnwatchedSurfacesAreDroppedBeyondALimit() {
    store.subscribe(threadId: "thr_watched", surface: .browser)
    store.apply(.surfaceFrame(Fixture.frame(threadId: "thr_watched", ts: 0)))
    for index in 1...20 {
      store.apply(.surfaceFrame(Fixture.frame(threadId: "thr_\(index)", ts: EpochMillis(index))))
    }
    #expect(store.frames.count == AgentStore.maxIdleFrames + 1)
    #expect(store.latestFrame(threadId: "thr_watched", surface: .browser) != nil)
    #expect(store.latestFrame(threadId: "thr_1", surface: .browser) == nil)
    #expect(store.latestFrame(threadId: "thr_20", surface: .browser) != nil)
  }

  @Test func livenessLastsThreeSeconds() {
    let now = Date(epochMillis: 10_000)
    #expect(SurfaceFeed.isLive(lastFrameAt: 8_000, now: now))
    #expect(!SurfaceFeed.isLive(lastFrameAt: 6_500, now: now))
    #expect(!SurfaceFeed.isLive(lastFrameAt: nil, now: now))
  }

  @Test func markersMapFramePixelsIntoTheView() {
    let point = SurfaceGeometry.point(x: 640, y: 200, frameWidth: 1280, frameHeight: 800, viewSize: CGSize(width: 320, height: 200))
    #expect(point == CGPoint(x: 160, y: 50))
    let clamped = SurfaceGeometry.point(x: 5_000, y: -3, frameWidth: 1280, frameHeight: 800, viewSize: CGSize(width: 100, height: 50))
    #expect(clamped == CGPoint(x: 100, y: 0))
    let degenerate = SurfaceGeometry.point(x: 1, y: 1, frameWidth: 0, frameHeight: 0, viewSize: CGSize(width: 10, height: 10))
    #expect(degenerate == CGPoint(x: 10, y: 10))
  }

  @Test func computerMarkersFadeAndOnlyTheLatestIsLabeled() {
    let actions = (1...7).map { SurfaceAction(kind: "click", x: Double($0), y: 1, ts: EpochMillis($0)) }
      + [SurfaceAction(kind: "type", text: "hi", ts: 8)]
    let markers = ComputerSurfaceView.markers(for: actions)
    #expect(markers.count == 5)
    #expect(markers.map(\.x) == [3, 4, 5, 6, 7])
    #expect(markers.last?.label == "click")
    #expect(markers.dropLast().allSatisfy { $0.label == nil })
    #expect(markers.first?.opacity == 0.2)
    #expect(BrowserSurfaceView.markers(for: Fixture.frame(action: SurfaceFrameAction(kind: "click", x: 1, y: 2, text: "Buy"))).first?.label == "Buy")
    #expect(BrowserSurfaceView.markers(for: Fixture.frame(action: SurfaceFrameAction(kind: "scroll"))).isEmpty)
  }
}
