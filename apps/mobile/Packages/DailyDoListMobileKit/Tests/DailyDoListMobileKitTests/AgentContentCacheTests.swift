import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListAgentCore
@testable import DailyDoListMobileKit

@MainActor
struct AgentContentCacheTests {
  @Test func coldOfflineInboxAndThreadNeverSendActionsOrReadReceipts() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try makeCache(fixture)
    try await seed(cache)
    let client = FakeDaemonClient()
    let store = AgentStore(client: client, contentCache: cache)
    await store.hydrateCachedContent()
    await store.loadThread("thread-one")
    await store.refresh()
    await store.loadRoutines()
    await store.loadRuns(ofRoutine: "routine-one")
    await store.loadRecords(for: "Synthetic.md")
    store.markRead("thread-one")
    store.subscribe(threadId: "thread-one", surface: .browser)
    await store.setEnabled(false)
    #expect(await store.postMessage(threadId: "thread-one", text: "Do not queue this") == false)
    #expect(await store.cancelThread("thread-one") == false)
    #expect(await store.decide("approval-one", .approve) == false)
    await store.flushClientEvents()
    #expect(client.calls.isEmpty)
    #expect(client.sent.isEmpty)
    #expect(store.pendingApprovalCount == 1)
    #expect(store.threads["thread-one"]?.title == "Synthetic conversation")
    #expect(store.thread("thread-one")?.messages.count == 1)
    #expect(store.cachedThreadIDs == ["thread-one"])
    #expect(store.unsentMessages.isEmpty)
    #expect(store.cachedContentReadOnly)
    store.handle(.state(.connected(serverVersion: "test")))
    store.subscribe(threadId: "thread-one", surface: .browser)
    await store.flushClientEvents()
    store.handle(.state(.disconnected))
    store.unsubscribe(threadId: "thread-one", surface: .browser)
    await store.flushClientEvents()
    #expect(
      client.sent == [
        .surfaceSubscribe(threadId: "thread-one", surface: .browser),
        .surfaceUnsubscribe(threadId: "thread-one", surface: .browser),
      ])
  }

  @Test func disconnectedRefreshCannotGrantAuthorityOrReplaceCachedInbox() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try makeCache(fixture)
    try await seed(cache)
    let client = FakeDaemonClient()
    let gate = CacheTestGate()
    client.script {
      $0.agentStatus = {
        await gate.pause()
        return client.withState { $0.agentStatus }
      }
    }
    let store = AgentStore(client: client, contentCache: cache)
    await store.hydrateCachedContent()
    store.handle(.state(.connected(serverVersion: "test")))
    let refresh = Task { await store.refresh() }
    await gate.entered()
    store.handle(.state(.disconnected))
    await gate.release()
    await refresh.value
    #expect(store.pendingApprovalCount == 1)
    #expect(store.cachedContentReadOnly)
    #expect(store.threads["thread-one"] != nil)
    let eventFirst = AgentStore(client: client, contentCache: cache)
    var decided = approval()
    decided.status = .approved
    eventFirst.apply(.approvalUpsert(decided))
    await eventFirst.hydrateCachedContent()
    #expect(eventFirst.approvals["approval-one"]?.status == .approved)
  }

  @Test func persistedThreadContainsBufferedServerMessagesButNoOptimisticReply() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try makeCache(fixture)
    let client = FakeDaemonClient()
    let gate = CacheTestGate()
    let original = thread()
    client.script {
      $0.thread = { id in
        guard id == "thread-one" else { throw DaemonClientError.http(status: 404, body: nil) }
        await gate.pause()
        return original
      }
    }
    let store = AgentStore(client: client, contentCache: cache)
    store.handle(.state(.connected(serverVersion: "test")))
    await store.refresh()
    let load = Task { await store.loadThread("thread-one") }
    await gate.entered()
    let newer = ThreadMessage.text(
      TextMessage(
        id: "message-new", author: "agent", createdAt: 3,
        role: .agent, text: "Arrived during refresh"))
    store.apply(.threadMessage(ThreadMessageEvent(threadId: "thread-one", message: newer)))
    await gate.release()
    await load.value
    client.fail("postMessage", with: .unreachable("synthetic offline"))
    #expect(await store.postMessage(threadId: "thread-one", text: "Unacknowledged reply") == false)
    store.apply(.approvalUpsert(approval()))
    store.handle(.state(.disconnected))
    await store.flushContentCache()
    let reopened = try makeCache(fixture)
    let saved = try #require(await reopened.thread("thread-one"))
    #expect(saved.value.thread.messages == original.thread.messages + [newer])
    #expect(saved.value.approvals.count == 1)
    #expect(try await reopened.inbox()?.value.approvalsFetchedAt != nil)
    #expect(store.thread("thread-one")?.messages.count == 3)
  }

  @Test func cachedThreadDoesNotMarkReadUntilFreshThreadResponseArrives() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try makeCache(fixture)
    try await seed(cache)
    let client = FakeDaemonClient()
    let store = AgentStore(client: client, contentCache: cache)
    await store.hydrateCachedContent()
    await store.loadThread("thread-one")
    store.handle(.state(.connected(serverVersion: "test")))
    await store.refresh()  // Thread fetch fails; cached thread remains available, but stale.
    store.markRead("thread-one")
    await store.flushClientEvents()
    #expect(client.sent.isEmpty)
    let fresh = thread()
    client.script { $0.thread = { _ in fresh } }
    await store.loadThread("thread-one", force: true)
    store.markRead("thread-one")
    await store.flushClientEvents()
    #expect(client.sent == [.threadRead(threadId: "thread-one")])
  }

  @Test func boundedArtifactDownloadsAndOfflineFallbackDoNotClaimAnUnpersistedReplacement()
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try makeCache(fixture)
    try await seed(cache)
    let bytes = Data([0, 255, 128, 10, 0])
    let ticket = try await cache.begin(
      .artifact(threadID: "thread-one", artifactID: "artifact-one"))
    _ = try await cache.storeArtifact(
      artifact(), payload: ArtifactPayload(data: bytes, mimeType: "image/png"), ticket: ticket)
    let client = FakeDaemonClient()
    let store = AgentStore(client: client, contentCache: cache)
    await store.hydrateCachedContent()
    await store.loadThread("thread-one")
    let offline = try await store.loadArtifact(threadID: "thread-one", artifactID: "artifact-one")
    #expect(offline.fromCache && offline.savedOffline)
    #expect(offline.value.payload.data == bytes)
    #expect(client.calls.isEmpty)
    let response = thread()
    client.script {
      $0.thread = { _ in response }
      // Metadata says 5 bytes; a short response must not replace the complete cached artifact.
      $0.artifact = { _, _ in ArtifactPayload(data: Data([1, 2, 3, 4]), mimeType: "image/png") }
    }
    store.handle(.state(.connected(serverVersion: "test")))
    await store.refresh()
    #expect(
      await store.downloadArtifact(threadID: "thread-one", artifactID: "artifact-one") == false)
    let preserved = try #require(
      await cache.artifact(threadID: "thread-one", artifactID: "artifact-one"))
    #expect(preserved.value.payload.data == bytes)
    #expect(preserved.metadata.pinned)
    store.handle(.state(.disconnected))
    #expect(
      try await store.loadArtifact(threadID: "thread-one", artifactID: "artifact-one").value.payload
        .data == bytes)
    let small = try makeCache(fixture, limits: .init(artifactBytes: 4))
    let limited = AgentStore(client: client, contentCache: small)
    limited.handle(.state(.connected(serverVersion: "test")))
    await limited.loadThread("thread-one")
    let before = client.calls("artifact:").count
    await #expect(throws: AgentContentError.self) {
      try await limited.loadArtifact(
        threadID: "thread-one", artifactID: "artifact-one", refresh: true)
    }
    #expect(client.calls("artifact:").count == before)
  }

  @Test func backgroundApprovalsUseCASAndDoNotRefreshUnrelatedContent() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try makeCache(fixture)
    try await seed(cache)
    let foreign = try makeCache(fixture)
    let foreignTicket = try await foreign.begin(.inbox)
    let foreignInbox = try #require(await foreign.inbox())
    await #expect(throws: WorkspaceRepositoryError.invalidScope) {
      try await cache.storeInbox(foreignInbox.value, ticket: foreignTicket)
    }
    let old = try #require(await cache.inbox())
    let replacement = try await cache.replacePendingApprovals(
      [], replacing: old.metadata.generation)
    let current = try #require(await cache.inbox())
    #expect(current.value.approvals.isEmpty)
    #expect(current.value.threads == old.value.threads)
    #expect(current.value.approvalsFetchedAt != nil)
    #expect(current.metadata.generation == replacement.generation)
    await #expect(throws: WorkspaceRepositoryError.concurrentWrite) {
      try await cache.replacePendingApprovals([approval()], replacing: old.metadata.generation)
    }
    #expect(try await cache.inbox()?.value.approvals.isEmpty == true)
  }

  private func makeCache(_ fixture: RepositoryFixture, limits: ContentCacheLimits = .init()) throws
    -> MobileAgentContentCache
  {
    try MobileAgentContentCache(
      rootDirectory: fixture.directory, scope: fixture.scope, limits: limits)
  }

  private func seed(_ cache: MobileAgentContentCache) async throws {
    let response = thread()
    let summary = AgentState.summarize(response.thread, pendingApprovals: 1)
    let inbox = AgentInboxSnapshot(
      status: nil, threads: [summary], approvals: [approval()],
      recordsByNote: [:], routines: [], routineTemplates: [])
    let inboxTicket = try await cache.begin(.inbox)
    _ = try await cache.storeInbox(inbox, ticket: inboxTicket)
    let threadTicket = try await cache.begin(.thread("thread-one"))
    _ = try await cache.storeThread(response, ticket: threadTicket)
  }

  private func thread() -> ThreadResponse {
    ThreadResponse(
      thread: AgentThread(
        id: "thread-one", taskId: nil, notePath: "Synthetic.md",
        title: "Synthetic conversation", status: .done, createdAt: 1, updatedAt: 2,
        messages: [
          .text(
            TextMessage(
              id: "message-one", author: "agent", createdAt: 2, role: .agent,
              text: "Saved result"))
        ],
        artifacts: [artifact()]), approvals: [approval()])
  }

  private func artifact() -> ArtifactMeta {
    ArtifactMeta(
      id: "artifact-one", threadId: "thread-one", title: "Synthetic bytes", kind: .image,
      mimeType: "image/png", path: ".daily-do-list/artifacts/one.png", size: 5, createdAt: 2)
  }

  private func approval() -> ApprovalRequest {
    ApprovalRequest(
      id: "approval-one", threadId: "thread-one", taskId: nil, toolName: "synthetic_tool",
      input: .object([:]), summary: "Synthetic action", risk: .medium, categories: [],
      reason: "Review",
      status: .pending, createdAt: 1)
  }
}

private actor CacheTestGate {
  var didEnter = false
  var observer: CheckedContinuation<Void, Never>?
  var waiting: CheckedContinuation<Void, Never>?
  func pause() async {
    didEnter = true
    observer?.resume()
    observer = nil
    await withCheckedContinuation { waiting = $0 }
  }
  func entered() async {
    if didEnter { return }
    await withCheckedContinuation { observer = $0 }
  }
  func release() {
    waiting?.resume()
    waiting = nil
  }
}
