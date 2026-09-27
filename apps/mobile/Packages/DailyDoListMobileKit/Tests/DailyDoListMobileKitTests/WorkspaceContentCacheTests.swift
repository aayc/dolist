import DailyDoListModels
import Foundation
import SQLite3
import Testing

@testable import DailyDoListMobileKit

struct WorkspaceContentCacheTests {
  @Test func threadSnapshotsSurviveRestartAndNewerStreamStateRejectsOldFetches() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try open(fixture)
    let first = try await cache.beginThreadFetch("thread-one")
    let initial = try await cache.storeThread(thread("Original"), fetch: first)
    let network = try await cache.beginThreadFetch("thread-one")
    let event = try await cache.beginThreadUpdate("thread-one", replacing: initial.generation)
    let saved = try await cache.storeThread(thread("New stream event"), fetch: event)
    await #expect(throws: WorkspaceContentCacheError.staleFetch) {
      try await cache.storeThread(thread("Old fetched state"), fetch: network)
    }
    await #expect(throws: WorkspaceContentCacheError.staleFetch) {
      try await cache.storeThread(thread("Repeated ticket"), fetch: event)
    }
    let reopened = try open(fixture)
    let cached = try #require(await reopened.thread("thread-one"))
    #expect(cached.response == thread("New stream event"))
    #expect(cached.metadata.generation == saved.generation)
    #expect(cached.metadata.isStale(at: Date(timeIntervalSince1970: 200), after: 50))
    #expect(!cached.metadata.isStale(at: Date(timeIntervalSince1970: 120), after: 50))
    await #expect(throws: WorkspaceRepositoryError.concurrentWrite) {
      try await reopened.beginThreadUpdate("thread-one", replacing: initial.generation)
    }
  }

  @Test func deletionEvictionAndRecreationNeverReuseFetchGenerations() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try open(fixture)
    let old = try await cache.beginThreadFetch("thread-one")
    try await cache.remove(.thread("thread-one"))
    let current = try await cache.beginThreadFetch("thread-one")
    #expect(current.generation > old.generation)
    _ = try await cache.storeThread(thread("Current"), fetch: current)
    await #expect(throws: WorkspaceContentCacheError.staleFetch) {
      try await cache.storeThread(thread("Deleted fetch"), fetch: old)
    }
    let pending = try await cache.beginThreadFetch("thread-one")
    let tiny = try open(fixture, limits: .init(totalBytes: 0))
    #expect(try await tiny.trim().entryCount == 0)
    let restarted = try open(fixture)
    let newest = try await restarted.beginThreadFetch("thread-one")
    _ = try await restarted.storeThread(thread("After eviction"), fetch: newest)
    await #expect(throws: WorkspaceContentCacheError.staleFetch) {
      try await restarted.storeThread(thread("Evicted fetch"), fetch: pending)
    }
    #expect(try await restarted.thread("thread-one")?.response.thread.title == "After eviction")
  }

  @Test func artifactsKeepExactBytesAndDescriptorAndRejectOversizedOrMismatchedContent()
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try open(fixture, limits: .init(artifactBytes: 5))
    let bytes = Data([0, 255, 254, 128, 10])
    let ticket = try await cache.beginArtifactFetch(threadID: "thread-one", artifactID: "file-one")
    _ = try await cache.storeArtifact(
      artifact(size: bytes.count), data: bytes, mimeType: "image/png", fetch: ticket)
    let reopened = try open(fixture)
    let loaded = try #require(
      await reopened.artifact(threadID: "thread-one", artifactID: "file-one"))
    #expect(loaded.data == bytes)
    #expect(loaded.descriptor.artifact == artifact(size: bytes.count))
    #expect(loaded.descriptor.mimeType == "image/png")
    #expect(loaded.metadata.sha256 == MarkdownCheckpointStore.digest(bytes))
    let replacement = try await cache.beginArtifactFetch(
      threadID: "thread-one", artifactID: "file-one")
    await #expect(throws: WorkspaceContentCacheError.payloadTooLarge(limit: 5)) {
      try await cache.storeArtifact(
        artifact(size: 6), data: Data(repeating: 1, count: 6), mimeType: "text/plain",
        fetch: replacement)
    }
    await #expect(throws: WorkspaceContentCacheError.invalidContent) {
      try await cache.storeArtifact(
        artifact(size: 4), data: bytes, mimeType: "text/plain", fetch: replacement)
    }
    #expect(try await cache.artifact(threadID: "thread-one", artifactID: "file-one")?.data == bytes)
    let smaller = try open(fixture, limits: .init(artifactBytes: 4))
    if case .tooLarge(let metadata, let limit) = try await smaller.availability(
      .artifact(threadID: "thread-one", artifactID: "file-one"))
    {
      #expect(metadata.byteCount == bytes.count)
      #expect(limit == 4)
    } else {
      Issue.record("Availability must explain the configured size limit")
    }
    await #expect(throws: WorkspaceContentCacheError.payloadTooLarge(limit: 4)) {
      try await smaller.artifact(threadID: "thread-one", artifactID: "file-one")
    }
    let empty = try await cache.beginArtifactFetch(threadID: "thread-one", artifactID: "file-one")
    _ = try await cache.storeArtifact(
      artifact(size: 0), data: Data(), mimeType: "application/octet-stream", fetch: empty)
    #expect(
      try await cache.artifact(threadID: "thread-one", artifactID: "file-one")?.data == Data())
  }

  @Test func pinnedEntriesSurviveBudgetTrimmingAndFailedInsertRollsBackAllEviction() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try open(fixture)
    let resource = CachedContentResource.artifact(threadID: "thread-one", artifactID: "file-one")
    try await cache.setPinned(resource, true)
    #expect(try await cache.entries(pinnedOnly: true).map(\.resource) == [resource])
    if case .missing(let pinned) = try await cache.availability(resource) {
      #expect(pinned)
    } else {
      Issue.record("Pinning must not claim the bytes exist")
    }
    let ticket = try await cache.beginArtifactFetch(threadID: "thread-one", artifactID: "file-one")
    _ = try await cache.storeArtifact(
      artifact(size: 5), data: Data(repeating: 0, count: 5), mimeType: "image/png", fetch: ticket)
    let threadTicket = try await cache.beginThreadFetch("thread-one")
    _ = try await cache.storeThread(thread("Disposable"), fetch: threadTicket)
    let before = try await cache.usage()
    #expect(before.pinnedBytes > 5)
    let tight = try open(fixture, limits: .init(totalBytes: before.pinnedBytes))
    let another = try await tight.beginThreadFetch("thread-two")
    await #expect(throws: WorkspaceContentCacheError.budgetExceeded) {
      try await tight.storeThread(thread("Cannot fit", id: "thread-two"), fetch: another)
    }
    // A failed insertion must not evict the previous disposable snapshot as a side effect.
    #expect(try await cache.thread("thread-one") != nil)
    #expect(try await cache.usage().entryCount == 2)
    let zero = try open(fixture, limits: .init(totalBytes: 0))
    let usage = try await zero.trim()
    #expect(usage.overBudget)
    #expect(usage.entryCount == 1)
    #expect(try await cache.thread("thread-one") == nil)
    #expect(try await cache.artifact(threadID: "thread-one", artifactID: "file-one") != nil)
    try await zero.setPinned(resource, false)
    #expect(try await zero.trim().totalBytes == 0)
    #expect(try await cache.artifact(threadID: "thread-one", artifactID: "file-one") == nil)
  }

  @Test func interruptedBlobTransactionKeepsPriorContentAndTicketCanRetry() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try open(fixture)
    let first = try await cache.beginThreadFetch("thread-one")
    _ = try await cache.storeThread(thread("Original"), fetch: first)
    let next = try await cache.beginThreadFetch("thread-one")
    try sql(
      fixture,
      "CREATE TRIGGER fail_cache BEFORE INSERT ON content_cache BEGIN SELECT RAISE(ABORT, 'injected'); END"
    )
    await #expect(throws: (any Error).self) {
      try await cache.storeThread(thread("Interrupted"), fetch: next)
    }
    #expect(try await cache.thread("thread-one")?.response.thread.title == "Original")
    try sql(fixture, "DROP TRIGGER fail_cache")
    _ = try await cache.storeThread(thread("Retried"), fetch: next)
    #expect(try await cache.thread("thread-one")?.response.thread.title == "Retried")
  }

  @Test func corruptBytesAreUnavailableAndCacheCannotCrossScopeOrReviveForgottenWorkspace()
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try open(fixture)
    let ticket = try await cache.beginThreadFetch("thread-one")
    _ = try await cache.storeThread(thread("Original"), fetch: ticket)
    try sql(fixture, "UPDATE content_cache SET data=zeroblob(length(data))")
    await #expect(throws: WorkspaceContentCacheError.corruptContent) {
      try await cache.thread("thread-one")
    }
    let other = try RepositoryFixture()
    defer { other.remove() }
    let otherCache = try open(other)
    await #expect(throws: WorkspaceContentCacheError.invalidContent) {
      try await otherCache.storeThread(thread("Wrong namespace"), fetch: ticket)
    }
    let pending = try await cache.beginThreadFetch("thread-one")
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    try await recovery.forget()
    await #expect(throws: WorkspaceRepositoryError.workspaceForgotten) {
      try await cache.storeThread(thread("Late response"), fetch: pending)
    }
  }

  private func open(_ fixture: RepositoryFixture, limits: ContentCacheLimits = .init()) throws
    -> WorkspaceContentCache
  {
    try WorkspaceContentCache(
      rootDirectory: fixture.directory, scope: fixture.scope, limits: limits,
      clock: { Date(timeIntervalSince1970: 100) })
  }

  private func thread(_ title: String, id: String = "thread-one") -> ThreadResponse {
    ThreadResponse(
      thread: AgentThread(
        id: id, taskId: nil, notePath: "Synthetic.md", title: title,
        status: .done, createdAt: 1, updatedAt: 2,
        sources: [
          CitedSource(
            url: "https://example.test/source", title: "Source", snippet: "Quoted evidence")
        ]), approvals: [])
  }

  private func artifact(size: Int) -> ArtifactMeta {
    ArtifactMeta(
      id: "file-one", threadId: "thread-one", title: "Synthetic image", kind: .image,
      mimeType: "image/png", path: ".daily-do-list/artifacts/file-one.png", size: size, createdAt: 1
    )
  }

  private func sql(_ fixture: RepositoryFixture, _ sql: String) throws {
    var database: OpaquePointer?
    let path = WorkspaceDirectory.url(root: fixture.directory, scope: fixture.scope)
      .appendingPathComponent("index.sqlite").path
    #expect(sqlite3_open(path, &database) == SQLITE_OK)
    defer { sqlite3_close(database) }
    #expect(sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK)
  }
}
