import Foundation
import Testing

@testable import DailyDoListMobileKit

struct WorkspaceDurabilityTests {
  @Test func staleMetadataTransactionCannotOverwriteAnotherRepositoryInstance() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let files = try MarkdownCheckpointStore(
      directory: fixture.directory.appendingPathComponent("markdown"))
    let url = fixture.directory.appendingPathComponent("index.sqlite")
    let first = try SQLiteWorkspaceIndex(url: url, scope: fixture.scope)
    let repository = try WorkspaceRepository(scope: fixture.scope, index: first, checkpoints: files)
    _ = try await repository.create(path: "New.md", content: "Original")
    let second = try SQLiteWorkspaceIndex(url: url, scope: fixture.scope)
    var old = try #require(try first.document("New.md"))
    var newer = old
    newer.working = try files.put("Newer generation")
    try second.commit(newer, pending: NoteOutboxRecord(path: newer.path))
    old.working = try files.put("Stale generation")
    #expect(throws: WorkspaceRepositoryError.concurrentWrite) {
      try first.commit(old, pending: NoteOutboxRecord(path: old.path))
    }
    #expect(try await repository.note("New.md")?.content == "Newer generation")
  }

  @Test func corruptDatabaseIsNotSilentlyReplaced() throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    try FileManager.default.createDirectory(
      at: fixture.directory, withIntermediateDirectories: true)
    let url = fixture.directory.appendingPathComponent("index.sqlite")
    let broken = Data("A damaged database".utf8)
    try broken.write(to: url)
    #expect(throws: WorkspaceRepositoryError.self) {
      try SQLiteWorkspaceIndex(url: url, scope: fixture.scope)
    }
    #expect(try Data(contentsOf: url) == broken)
  }

  @Test func interruptedMetadataCommitLeavesTheLastDurableGenerationIntact() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let checkpoints = try MarkdownCheckpointStore(
      directory: fixture.directory.appendingPathComponent("markdown"))
    let database = try SQLiteWorkspaceIndex(
      url: fixture.directory.appendingPathComponent("index.sqlite"), scope: fixture.scope)
    let failures = FailingIndex(database)
    let repository = try WorkspaceRepository(
      scope: fixture.scope, index: failures, checkpoints: checkpoints)
    let original = try await repository.create(path: "New.md", content: "Durable")
    failures.rejectCommits = true
    await #expect(throws: WorkspaceRepositoryError.storage("Injected full disk")) {
      try await repository.save(
        path: "New.md", content: "Not acknowledged", expectedRevision: original.localRevision)
    }
    let reopened = try SQLiteWorkspaceIndex(
      url: fixture.directory.appendingPathComponent("index.sqlite"), scope: fixture.scope)
    let restarted = try WorkspaceRepository(
      scope: fixture.scope, index: reopened, checkpoints: checkpoints)
    let durable = try #require(await restarted.note("New.md"))
    #expect(durable.content == "Durable")
    #expect(durable.localRevision == original.localRevision)
    #expect(try reopened.outbox().count == 1)
  }

  @Test func checkpointFailureDoesNotAdvanceTheIndexOrPublishAnEmptyNote() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let files = try MarkdownCheckpointStore(
      directory: fixture.directory.appendingPathComponent("markdown"))
    let checkpoints = FailingCheckpointStore(files)
    let index = try SQLiteWorkspaceIndex(
      url: fixture.directory.appendingPathComponent("index.sqlite"), scope: fixture.scope)
    let repository = try WorkspaceRepository(
      scope: fixture.scope, index: index, checkpoints: checkpoints)
    let original = try await repository.create(path: "New.md", content: "Safe content")
    checkpoints.rejectWrites = true
    await #expect(throws: WorkspaceRepositoryError.storage("Injected protected data")) {
      try await repository.save(
        path: "New.md", content: "Next", expectedRevision: original.localRevision)
    }
    #expect(try await repository.note("New.md")?.content == "Safe content")
    #expect(try index.document("New.md")?.revision == original.localRevision)
  }

  @Test func corruptCheckpointFailsClosedAndPreservesItsBytesForRecovery() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let original = try await repository.create(path: "New.md", content: "Safe content")
    try Data("Damaged data".utf8).write(to: original.workingFile)
    await #expect(throws: WorkspaceRepositoryError.corruptCheckpoint) {
      try await repository.note("New.md")
    }
    #expect(try String(contentsOf: original.workingFile, encoding: .utf8) == "Damaged data")
  }

  @Test func aNamespaceCannotBeReopenedForAnotherServingHost() throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    _ = try fixture.open()
    let other = WorkspaceScope(
      profileID: fixture.scope.profileID, workspaceID: fixture.scope.workspaceID,
      hostID: "another-host", origin: fixture.scope.origin)
    #expect(throws: WorkspaceRepositoryError.workspaceMismatch) {
      try WorkspaceRepository(rootDirectory: fixture.directory, scope: other)
    }
  }

  @Test func cleanDeletedEntriesDisappearWithoutCreatingAnOutboxEntry() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.cache(RemoteNote(content: "Cached", version: "v1"), path: "Gone.md")
    let remote = RepositoryRemote(scope: fixture.scope)
    #expect(try await repository.refresh(path: "Gone.md", with: remote) == nil)
    _ = try await repository.synchronize(with: remote)
    #expect(await remote.writes.isEmpty)
  }

  @Test(arguments: [
    "../Escape.md", "/Root.md", "Folder//Note.md", ".daily-do-list/state.md", "Scene.excalidraw.md",
  ])
  func unsafePathsAndDrawingsNeverEnterTextMerge(_ path: String) async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    await #expect(throws: WorkspaceRepositoryError.invalidPath) {
      try await repository.create(path: path, content: "Draft")
    }
  }

  @Test func acceptingRemoteAfterAConflictKeepsAnExportableLocalRecoveryCopy() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.create(path: "Day.md", content: "Local draft")
    let remote = RepositoryRemote(
      scope: fixture.scope, note: RemoteNote(content: "Already there", version: "v1"))
    _ = try await repository.synchronize(with: remote)
    let conflict = try #require(await repository.note("Day.md"))
    let resolved = try await repository.useRemoteVersion(
      path: "Day.md", expectedRevision: conflict.localRevision)
    #expect(resolved.content == "Already there")
    #expect(resolved.state == .synced)
    let copies = try resolved.recoveryCopies.map { try String(contentsOf: $0, encoding: .utf8) }
    #expect(copies.contains("Local draft"))
    #expect(await remote.writes.isEmpty)
  }
}

private final class FailingIndex: WorkspaceIndex, @unchecked Sendable {
  let wrapped: any WorkspaceIndex
  let lock = NSLock()
  var rejecting = false
  var rejectCommits: Bool {
    get { lock.withLock { rejecting } }
    set { lock.withLock { rejecting = newValue } }
  }
  init(_ wrapped: any WorkspaceIndex) { self.wrapped = wrapped }
  func documents() throws -> [NoteIndexRecord] { try wrapped.documents() }
  func document(_ path: String) throws -> NoteIndexRecord? { try wrapped.document(path) }
  func outbox() throws -> [NoteOutboxRecord] { try wrapped.outbox() }
  func pending(_ path: String) throws -> NoteOutboxRecord? { try wrapped.pending(path) }
  func commit(
    path: String, document: NoteIndexRecord?, pending: NoteOutboxRecord?, expectedGeneration: Int64?
  ) throws {
    if rejectCommits { throw WorkspaceRepositoryError.storage("Injected full disk") }
    try wrapped.commit(
      path: path, document: document, pending: pending, expectedGeneration: expectedGeneration)
  }
}

private final class FailingCheckpointStore: NoteCheckpointStore, @unchecked Sendable {
  let wrapped: any NoteCheckpointStore
  let lock = NSLock()
  var rejecting = false
  var rejectWrites: Bool {
    get { lock.withLock { rejecting } }
    set { lock.withLock { rejecting = newValue } }
  }
  init(_ wrapped: any NoteCheckpointStore) { self.wrapped = wrapped }
  func put(_ content: String) throws -> String {
    if rejectWrites { throw WorkspaceRepositoryError.storage("Injected protected data") }
    return try wrapped.put(content)
  }
  func read(_ reference: String) throws -> String { try wrapped.read(reference) }
  func fileURL(_ reference: String) throws -> URL { try wrapped.fileURL(reference) }
}
