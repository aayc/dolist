import DailyDoListModels
import Foundation
import SQLite3
import Testing

@testable import DailyDoListMobileKit

struct WorkspaceCacheTests {
  @Test func schemaOneMigratesWithoutLosingNoteOrOutboxData() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.create(path: "Draft.md", content: "Old schema draft")
    let path = WorkspaceDirectory.url(root: fixture.directory, scope: fixture.scope)
      .appendingPathComponent("index.sqlite").path
    var database: OpaquePointer?
    #expect(sqlite3_open(path, &database) == SQLITE_OK)
    defer { sqlite3_close(database) }
    #expect(
      sqlite3_exec(database, "DROP TABLE workspace_values; PRAGMA user_version=1", nil, nil, nil)
        == SQLITE_OK)
    let upgraded = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await upgraded.saveComposer(.orchestrator, text: "New schema draft", replacing: 0)
    let reopened = try fixture.open()
    #expect(try await reopened.note("Draft.md")?.content == "Old schema draft")
    let remote = RepositoryRemote(scope: fixture.scope)
    _ = try await reopened.synchronize(with: remote)
    #expect(await remote.notes["Draft.md"]?.content == "Old schema draft")
  }

  @Test func schemaThreeMigratesCurrentRevisionsAndPreservesPendingWork() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.create(path: "Pending.md", content: "Keep pending work")
    let cache = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
    let revision = try await cache.storeSettings(.defaults, replacing: nil)
    let path = WorkspaceDirectory.url(root: fixture.directory, scope: fixture.scope)
      .appendingPathComponent("index.sqlite").path
    var database: OpaquePointer?
    #expect(sqlite3_open(path, &database) == SQLITE_OK)
    defer { sqlite3_close(database) }
    #expect(
      sqlite3_exec(
        database,
        "DROP TABLE content_cache; DROP TABLE content_cache_keys; DROP TABLE workspace_value_revisions; PRAGMA user_version=3",
        nil, nil, nil) == SQLITE_OK)
    let reopened = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
    #expect(try await reopened.settings()?.revision == revision)
    let next = try await reopened.storeSettings(.defaults, replacing: revision)
    #expect(next > revision)
    #expect(try await repository.note("Pending.md")?.content == "Keep pending work")
    let remote = RepositoryRemote(scope: fixture.scope)
    _ = try await repository.synchronize(with: remote)
    #expect(await remote.notes["Pending.md"]?.content == "Keep pending work")
  }

  @Test func aBatchWithAStaleRevisionRollsBackEveryValue() throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let sqlite = try SQLiteWorkspaceIndex(
      url: fixture.directory.appendingPathComponent("index.sqlite"), scope: fixture.scope)
    let initial = WorkspaceStoredValue(
      key: "a", data: Data("Original".utf8), updatedAt: Date(), retention: .durable)
    try sqlite.commitValues([WorkspaceValueMutation(key: "a", value: initial)])
    var newer = initial
    newer.data = Data("Should roll back".utf8)
    let other = WorkspaceStoredValue(
      key: "b", data: Data("Another".utf8), updatedAt: Date(), retention: .durable)
    #expect(throws: WorkspaceRepositoryError.concurrentWrite) {
      try sqlite.commitValues([
        WorkspaceValueMutation(key: "a", value: newer, expectedRevision: 1),
        WorkspaceValueMutation(key: "b", value: other, expectedRevision: 99),
      ])
    }
    #expect(try sqlite.value("a")?.data == initial.data)
    #expect(try sqlite.value("b") == nil)
  }

  @Test func typedMetadataSurvivesRestartAndRejectsStaleResponses() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
    let revision = try await cache.storeSettings(.defaults, replacing: nil)
    let tree = VaultTreeResponse(vaultName: "Synthetic notes", entries: [])
    _ = try await cache.storeTree(tree, replacing: nil)
    _ = try await cache.storeRecentThreads([], replacing: nil)
    var settings = AppSettings.defaults
    settings.theme = .light
    _ = try await cache.storeSettings(settings, replacing: revision)
    await #expect(throws: WorkspaceRepositoryError.concurrentWrite) {
      try await cache.storeSettings(.defaults, replacing: revision)
    }
    let reopened = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
    #expect(try await reopened.settings()?.value == settings)
    #expect(try await reopened.tree()?.value == tree)
    #expect(try await reopened.recentThreads()?.value == [])
  }

  @Test func acknowledgedComposerClearCannotBeUndoneByADelayedCheckpoint() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
    let draft = try await cache.saveComposer(
      .thread("synthetic-thread"), text: "Unsent idea", replacing: 0)
    let cleared = try await cache.saveComposer(
      .thread("synthetic-thread"), text: "", replacing: draft.revision)
    await #expect(throws: WorkspaceRepositoryError.concurrentWrite) {
      try await cache.saveComposer(
        .thread("synthetic-thread"), text: "Unsent idea", replacing: draft.revision)
    }
    let reopened = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
    let current = try await reopened.composer(.thread("synthetic-thread"))
    #expect(current.text.isEmpty)
    #expect(current.revision == cleared.revision)
    #expect(try await reopened.composer(.orchestrator).revision == 0)
  }

  @Test func budgetEvictsDisposableMetadataButPreservesDraftsAndDirtyMarkdown() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.create(path: "Draft.md", content: "Never evict this draft")
    let cache = try WorkspaceCache(
      rootDirectory: fixture.directory, scope: fixture.scope, budgetBytes: 0)
    _ = try await cache.saveComposer(.orchestrator, text: "Unsent question", replacing: 0)
    _ = try await cache.storeSettings(.defaults, replacing: nil)
    _ = try await cache.storeTree(
      VaultTreeResponse(vaultName: "Synthetic", entries: []), replacing: nil)
    let usage = try await cache.trim()
    #expect(usage.disposableBytes == 0)
    #expect(usage.protectedBytes > 0)
    #expect(try await cache.settings() == nil)
    #expect(try await cache.composer(.orchestrator).text == "Unsent question")
    #expect(try await repository.note("Draft.md")?.content == "Never evict this draft")
  }

  @Test func evictionAndRecreationRejectsAnOldMatchingRevision() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
    let old = try await cache.storeSettings(.defaults, replacing: nil)
    let evictor = try WorkspaceCache(
      rootDirectory: fixture.directory, scope: fixture.scope, budgetBytes: 0)
    _ = try await evictor.trim()
    let reopened = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
    var changed = AppSettings.defaults
    changed.theme = .light
    let current = try await reopened.storeSettings(changed, replacing: nil)
    #expect(current > old)
    await #expect(throws: WorkspaceRepositoryError.concurrentWrite) {
      try await cache.storeSettings(.defaults, replacing: old)
    }
    #expect(try await reopened.settings()?.value == changed)
  }

  @Test func notificationCursorAndDeduplicationAdvanceTogetherAcrossRestart() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let cache = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
    let item = CachedNotification(
      id: "notification-1",
      notification: RoutineNotification(
        routineId: "routine-1", title: "Synthetic routine", body: "Done", threadId: "thread-1",
        status: .done, at: 1_000))
    let revision = try await cache.mergeNotifications([item], cursor: "cursor-1", replacing: nil)
    let delivered = try await cache.markNotificationsDelivered([item.id], replacing: revision)
    let reopened = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await reopened.mergeNotifications([item], cursor: "cursor-2", replacing: delivered)
    let current = try #require(await reopened.notifications())
    #expect(current.value.cursor == "cursor-2")
    #expect(current.value.items.count == 1)
    #expect(current.value.items.first?.delivered == true)
    await #expect(throws: WorkspaceRepositoryError.concurrentWrite) {
      try await reopened.mergeNotifications([], cursor: "stale", replacing: revision)
    }
    #expect(try await reopened.notifications()?.value.cursor == "cursor-2")
  }
}
