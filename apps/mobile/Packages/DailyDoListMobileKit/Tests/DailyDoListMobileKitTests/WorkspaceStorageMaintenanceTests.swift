import DailyDoListAgentCore
import DailyDoListDrawingModel
import Foundation
import SQLite3
import Testing

@testable import DailyDoListMobileKit

struct WorkspaceStorageMaintenanceTests {
  @Test func trimmingKeepsPinsLiveEditorsAndEveryReconciliationReference() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let directory = WorkspaceDirectory.url(root: fixture.directory, scope: fixture.scope)
    let index = try SQLiteWorkspaceIndex(
      url: directory.appendingPathComponent("index.sqlite"), scope: fixture.scope)
    let files = try MarkdownCheckpointStore(directory: directory.appendingPathComponent("markdown"))
    let maintenance = try WorkspaceStorageMaintenance(
      rootDirectory: fixture.directory, scope: fixture.scope, budgetBytes: 0)
    for path in ["Clean.md", "Keep/Pinned.md", "Keeper/NotPinned.md", "Open.md", "Recovery.md"] {
      _ = try await repository.cache(
        RemoteNote(content: "Synthetic " + path, version: "v1"), path: path)
    }
    let recovery = try #require(try await repository.note("Recovery.md"))
    let review = try await repository.saveForReview(
      path: "Recovery.md", content: "Retained local conflict",
      expectedRevision: recovery.localRevision)
    _ = try await repository.useRemoteVersion(
      path: "Recovery.md", expectedRevision: review.localRevision)
    let operation = try index.prepareStructural(
      WorkspaceStructuralOperation(
        id: UUID(), scope: fixture.scope,
        action: .trash(path: "Recovery.md", isFolder: false), startedAt: Date(), state: .attempting,
        cachedNotes: [], revision: 0))
    _ = try index.resolveStructural(
      operation.id, revision: operation.revision, resolution: .applied)
    _ = try await repository.createRecoveryDraft(
      path: "Deleted.md", content: "Deleted while editing")
    let dirty = try await repository.cache(
      RemoteNote(content: "Immutable base", version: "base"), path: "Dirty.md")
    _ = try await repository.save(
      path: "Dirty.md", content: "Working dirty text", expectedRevision: dirty.localRevision)
    let attempted = try #require(try index.document("Dirty.md"))
    let attempt = NoteWriteAttempt(
      operationID: UUID(), checkpoint: attempted.working, revision: attempted.revision,
      baseVersion: attempted.baseVersion)
    try index.commit(attempted, pending: NoteOutboxRecord(path: attempted.path, attempt: attempt))
    _ = try await repository.save(
      path: "Dirty.md", content: "Newer typing than attempt", expectedRevision: attempted.revision)
    let drawings = try DrawingRepository(rootDirectory: fixture.directory, scope: fixture.scope)
    let scene = try ExcalidrawMarkdown.serialize(ExcalidrawScene(), previous: nil)
    _ = try await drawings.cache(
      RemoteNote(content: scene, version: "scene"), path: "Needed.excalidraw.md")
    _ = try await repository.create(
      path: "Embed.md", content: "![[Needed.excalidraw.md]]",
      requiringDrawings: ["Needed.excalidraw.md"])
    let capture = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await capture.enqueue(
      text: "A pending capture", capturedAt: Date(), timeZone: #require(TimeZone(identifier: "UTC"))
    )
    let cache = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await cache.saveComposer(.orchestrator, text: "Unsent composer", replacing: 0)
    let record = AgentMutationRecoveryRecord(
      scope: fixture.scope,
      intent: PendingAgentMutation(
        id: "pending-action", command: .cancelThread("thread-test"), createdAt: Date()))
    let operationKey = "agent-operation/" + record.intent.id
    let slotKey =
      "agent-operation-slot/"
      + MarkdownCheckpointStore.digest(
        Data(try #require(record.intent.command.exclusionKey).utf8))
    _ = try index.commitValues([
      WorkspaceValueMutation(
        key: operationKey,
        value: WorkspaceStoredValue(
          key: operationKey, data: try JSONEncoder().encode(record), updatedAt: Date(),
          retention: .durable)),
      WorkspaceValueMutation(
        key: slotKey,
        value: WorkspaceStoredValue(
          key: slotKey, data: Data(record.intent.id.utf8), updatedAt: Date(), retention: .durable)),
    ])
    let orphan = try files.put("Unpublished obsolete cache")
    try await maintenance.setPinned(.folder("Keep"), pinned: true)
    let beforeValues = try index.values(prefix: "").map { ($0.key, $0.data) }
    let before = try await maintenance.inventory(protecting: ["Open.md"])
    #expect(
      before.documents.first { $0.path == "Needed.excalidraw.md" }?.protections.contains(
        .drawingDependency) == true)
    let result = try await maintenance.trim(protecting: ["Open.md"])
    #expect(result.evictedPaths == ["Clean.md", "Keeper/NotPinned.md"])
    let collected = try await maintenance.collectGarbage()
    #expect(collected.removedFiles >= 3)
    #expect(!FileManager.default.fileExists(atPath: try files.fileURL(orphan).path))
    #expect(try await repository.note("Dirty.md")?.content == "Newer typing than attempt")
    #expect(try files.read(attempt.checkpoint) == "Working dirty text")
    #expect(try files.read(#require(attempted.base)) == "Immutable base")
    #expect(
      try files.read(MarkdownCheckpointStore.digest(Data("Retained local conflict".utf8)))
        == "Retained local conflict")
    #expect(try await repository.note("Deleted.md")?.content == "Deleted while editing")
    #expect(try await drawings.drawing("Needed.excalidraw.md") != nil)
    #expect(try await maintenance.inventory().usage.overBudget)
    for (key, data) in beforeValues { #expect(try index.value(key)?.data == data) }
  }

  @Test func selectionsAndDownloadTicketsSurviveRestartWithoutFalselyCompletingStaleWork()
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let maintenance = try WorkspaceStorageMaintenance(
      rootDirectory: fixture.directory, scope: fixture.scope)
    let requests = try await maintenance.requestDownload(
      .folder("Folder"), paths: ["Folder/A.md", "Folder/Scene.excalidraw.md", "Folderish/B.md"],
      maxBytes: 20)
    #expect(requests.map(\.path) == ["Folder/A.md", "Folder/Scene.excalidraw.md"])
    let old = try await maintenance.beginDownload("Folder/A.md")
    let restarted = try WorkspaceStorageMaintenance(
      rootDirectory: fixture.directory, scope: fixture.scope)
    #expect(
      try await restarted.inventory().downloads.first { $0.path == old.path }?.state == .attempting)
    try await restarted.cancelDownload(old.path, id: old.id)
    _ = try await restarted.requestDownload(.folder("Folder"), paths: [old.path], maxBytes: 20)
    let next = try await restarted.beginDownload(old.path)
    let saved = try await repository.cache(
      RemoteNote(content: "Downloaded", version: "v1"), path: old.path)
    await #expect(throws: WorkspaceStorageError.staleDownload) {
      try await maintenance.completeDownload(old, expectedRevision: saved.localRevision)
    }
    let edited = try await repository.save(
      path: old.path, content: "Local typing", expectedRevision: saved.localRevision)
    await #expect(throws: WorkspaceStorageError.staleDownload) {
      try await restarted.completeDownload(next, expectedRevision: saved.localRevision)
    }
    try await restarted.completeDownload(next, expectedRevision: edited.localRevision)
    let complete = try #require(
      try await restarted.inventory().downloads.first { $0.path == old.path })
    #expect(complete.state == .available && complete.completedBytes == "Local typing".utf8.count)
    let cache = try WorkspaceCache(
      rootDirectory: fixture.directory, scope: fixture.scope, budgetBytes: 0)
    _ = try await cache.trim()
    #expect(try await restarted.inventory().selections == [.folder("Folder")])
    let failure = try await restarted.beginDownload("Folder/Scene.excalidraw.md")
    try await restarted.failDownload(failure, failure: .tooLarge)
    #expect(
      try await restarted.inventory().downloads.first { $0.path == failure.path }?.failure
        == .tooLarge)
  }

  @Test func forgettingCleanWorkspaceAlsoClearsPinsAndDownloadRequests() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let directory = WorkspaceDirectory.url(root: fixture.directory, scope: fixture.scope)
    let index = try SQLiteWorkspaceIndex(
      url: directory.appendingPathComponent("index.sqlite"), scope: fixture.scope)
    let maintenance = try WorkspaceStorageMaintenance(
      rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await maintenance.requestDownload(.allDocuments, paths: ["A.md"])
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    try await recovery.forget()
    for table in ["document_download_selections", "document_download_requests"] {
      let count = try index.statement("SELECT count(*) FROM " + table) { statement in
        #expect(sqlite3_step(statement) == SQLITE_ROW)
        return sqlite3_column_int(statement, 0)
      }
      #expect(count == 0)
    }
    await #expect(throws: WorkspaceRepositoryError.workspaceForgotten) {
      try await maintenance.setPinned(.allDocuments, pinned: true)
    }
  }

  @Test func staleEvictionCannotRemoveTypingAndEvictRefetchCannotAcceptAnOldEditor() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let directory = WorkspaceDirectory.url(root: fixture.directory, scope: fixture.scope)
    let index = try SQLiteWorkspaceIndex(
      url: directory.appendingPathComponent("index.sqlite"), scope: fixture.scope)
    let maintenance = try WorkspaceStorageMaintenance(
      rootDirectory: fixture.directory, scope: fixture.scope)
    let initial = try await repository.cache(
      RemoteNote(content: "Original", version: "v1"), path: "A.md")
    let generation = try #require(try index.document("A.md")).generation
    _ = try await repository.save(
      path: "A.md", content: "Typed", expectedRevision: initial.localRevision)
    #expect(try index.evictDocuments(["A.md": generation], protecting: []).skippedPaths == ["A.md"])
    #expect(try await repository.note("A.md")?.content == "Typed")
    let clean = try await repository.cache(
      RemoteNote(content: "Clean", version: "v1"), path: "B.md")
    #expect(try await maintenance.evict(["B.md"]).evictedPaths == ["B.md"])
    _ = try await maintenance.collectGarbage()
    let replacement = try await repository.cache(
      RemoteNote(content: "New", version: "v2"), path: "B.md")
    #expect(replacement.localRevision > clean.localRevision)
    await #expect(throws: WorkspaceRepositoryError.self) {
      try await repository.save(
        path: "B.md", content: "Old editor", expectedRevision: clean.localRevision)
    }
  }

  @Test func cleanupFailuresUnknownDurableRecordsAndSymlinksNeverDestroyReferencedContent()
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let directory = WorkspaceDirectory.url(root: fixture.directory, scope: fixture.scope)
    let index = try SQLiteWorkspaceIndex(
      url: directory.appendingPathComponent("index.sqlite"), scope: fixture.scope)
    let files = try MarkdownCheckpointStore(directory: directory.appendingPathComponent("markdown"))
    _ = try await repository.cache(RemoteNote(content: "Earlier", version: "v1"), path: "A.md")
    _ = try await repository.cache(RemoteNote(content: "Current", version: "v2"), path: "A.md")
    let disk = FailingCheckpointRemoval(directory: files.directory)
    let maintenance = WorkspaceStorageMaintenance(
      scope: fixture.scope, store: index, checkpoints: files,
      files: disk, budgetBytes: 0)
    let future = WorkspaceStoredValue(
      key: "future/protected", data: Data("opaque".utf8), updatedAt: Date(), retention: .durable)
    let revision = try #require(
      try index.commitValues([
        WorkspaceValueMutation(key: future.key, value: future, expectedRevision: nil)
      ])[future.key])
    #expect(try await maintenance.collectGarbage().unsupportedProtectedRecords == 1)
    #expect(try await maintenance.trim().evictedPaths.isEmpty)
    _ = try index.commitValues([WorkspaceValueMutation(key: future.key, expectedRevision: revision)]
    )
    await #expect(throws: WorkspaceRepositoryError.storage("Injected unlink failure")) {
      try await maintenance.collectGarbage()
    }
    #expect(try await repository.note("A.md")?.content == "Current")
    let outside = fixture.directory.appendingPathComponent("synthetic-outside.txt")
    try Data("Unrelated synthetic file".utf8).write(to: outside)
    let symlink = files.directory.appendingPathComponent(String(repeating: "a", count: 64) + ".md")
    try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: outside)
    let result = try await maintenance.collectGarbage(maximumFiles: 1)
    #expect(result.removedFiles == 1)
    #expect(try String(contentsOf: outside, encoding: .utf8) == "Unrelated synthetic file")
    #expect(FileManager.default.fileExists(atPath: symlink.path))
    #expect(try await repository.note("A.md")?.content == "Current")
  }
}

private final class FailingCheckpointRemoval: CheckpointFileSystem, @unchecked Sendable {
  let wrapped: FoundationCheckpointFileSystem
  private let lock = NSLock()
  private var fails = true
  init(directory: URL) { wrapped = FoundationCheckpointFileSystem(directory: directory) }
  func files() throws -> [CheckpointFile] { try wrapped.files() }
  func remove(_ reference: String) throws {
    lock.lock()
    let reject = fails
    fails = false
    lock.unlock()
    if reject { throw WorkspaceRepositoryError.storage("Injected unlink failure") }
    try wrapped.remove(reference)
  }
  func synchronize() throws { try wrapped.synchronize() }
}
