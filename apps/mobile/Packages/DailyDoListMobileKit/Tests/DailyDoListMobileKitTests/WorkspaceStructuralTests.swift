import Foundation
import SQLite3
import Testing

@testable import DailyDoListMobileKit

struct WorkspaceStructuralTests {
  @Test func folderRenamePreservesTypingDuringRequestAndRespectsPathBoundaries() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let original = try await repository.cache(
      RemoteNote(content: "Original", version: "v1"), path: "Ideas/One.md")
    _ = try await repository.cache(
      RemoteNote(content: "Sibling", version: "v2"), path: "Ideas Extra/Two.md")
    let coordinator = try WorkspaceStructuralCoordinator(
      rootDirectory: fixture.directory, scope: fixture.scope)
    let remote = StructuralTestRemote(scope: fixture.scope, paused: true)
    let request = Task {
      try await coordinator.perform(
        .rename(from: "Ideas", to: "Archive", isFolder: true), with: remote)
    }
    await remote.waitUntilRequested()
    _ = try await repository.save(
      path: "Ideas/One.md", content: "New typing", expectedRevision: original.localRevision)
    let writer = RepositoryRemote(scope: fixture.scope)
    await writer.replace("Ideas/One.md", with: RemoteNote(content: "Original", version: "v1"))
    _ = try await repository.synchronize(with: writer)
    #expect(await writer.writes.isEmpty)
    await remote.release()
    #expect(try await request.value.state == .applied)
    #expect(try await repository.note("Ideas/One.md") == nil)
    #expect(try await repository.note("Archive/One.md")?.content == "New typing")
    #expect(try await repository.note("Archive/One.md")?.state == .waitingToSync)
    #expect(try await repository.note("Ideas Extra/Two.md")?.content == "Sibling")
    await writer.replace("Archive/One.md", with: RemoteNote(content: "Original", version: "v1"))
    _ = try await repository.synchronize(with: writer)
    #expect(await writer.notes["Archive/One.md"]?.content == "New typing")
  }

  @Test func dirtyAffectedNotesAndPendingCapturesPreventAnyStructuralRequest() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.create(path: "Draft.md", content: "Unsent")
    let coordinator = try WorkspaceStructuralCoordinator(
      rootDirectory: fixture.directory, scope: fixture.scope)
    let remote = StructuralTestRemote(scope: fixture.scope)
    await #expect(throws: WorkspaceMaintenanceError.dirtyAffectedNotes) {
      try await coordinator.perform(.trash(path: "Draft.md", isFolder: false), with: remote)
    }
    let captures = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await captures.enqueue(
      text: "Capture", capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
      timeZone: #require(TimeZone(identifier: "UTC")))
    await #expect(throws: WorkspaceRepositoryError.pendingCaptures) {
      try await coordinator.perform(.trash(path: "Other.md", isFolder: false), with: remote)
    }
    #expect(await remote.requests.isEmpty)
  }

  @Test(arguments: ["taken.md", "Taken.md/Child.md", "TAKEN.md"])
  func destinationCollisionsAreRejectedEvenAcrossFileDirectoryAndCaseVariants(_ destination: String)
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.cache(RemoteNote(content: "Source", version: "v1"), path: "Source.md")
    _ = try await repository.cache(
      RemoteNote(content: "Destination", version: "v2"), path: destination)
    let coordinator = try WorkspaceStructuralCoordinator(
      rootDirectory: fixture.directory, scope: fixture.scope)
    let remote = StructuralTestRemote(scope: fixture.scope)
    await #expect(throws: WorkspaceMaintenanceError.destinationCollision) {
      try await coordinator.perform(
        .rename(from: "Source.md", to: "Taken.md", isFolder: false), with: remote)
    }
    #expect(await remote.requests.isEmpty)
  }

  @Test func lostResponseRequiresExplicitResolutionAcrossRestartWithoutResending() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.cache(RemoteNote(content: "Original", version: "v1"), path: "Old.md")
    let coordinator = try WorkspaceStructuralCoordinator(
      rootDirectory: fixture.directory, scope: fixture.scope)
    let remote = StructuralTestRemote(scope: fixture.scope, failure: .unknown)
    let operation = try await coordinator.perform(
      .rename(from: "Old.md", to: "New.md", isFolder: false), with: remote)
    #expect(operation.state == .needsReview)
    let restarted = try WorkspaceStructuralCoordinator(
      rootDirectory: fixture.directory, scope: fixture.scope)
    #expect(try await restarted.unresolved().first?.id == operation.id)
    await #expect(throws: WorkspaceRepositoryError.pendingStructuralChange) {
      try await restarted.perform(.trash(path: "Another.md", isFolder: false), with: remote)
    }
    await remote.setHost("wrong-host")
    await #expect(throws: WorkspaceRepositoryError.hostMismatch) {
      try await restarted.resolve(
        operation.id, revision: operation.revision, as: .applied, with: remote)
    }
    await remote.setHost(fixture.scope.hostID)
    let resolved = try await restarted.resolve(
      operation.id, revision: operation.revision, as: .applied, with: remote)
    #expect(resolved.state == .applied)
    #expect(try await restarted.unresolved().isEmpty)
    #expect(try await repository.note("New.md")?.content == "Original")
    #expect(await remote.requests.count == 1)
    await #expect(throws: WorkspaceRepositoryError.concurrentWrite) {
      try await restarted.resolve(
        operation.id, revision: operation.revision, as: .notApplied, with: remote)
    }
  }

  @Test func definiteRejectionReleasesBarrierWithoutRemappingAnything() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.cache(RemoteNote(content: "Original", version: "v1"), path: "Old.md")
    let coordinator = try WorkspaceStructuralCoordinator(
      rootDirectory: fixture.directory, scope: fixture.scope)
    let result = try await coordinator.perform(
      .trash(path: "Old.md", isFolder: false),
      with: StructuralTestRemote(scope: fixture.scope, failure: .rejected))
    #expect(result.state == .notApplied)
    #expect(try await coordinator.unresolved().isEmpty)
    #expect(try await repository.note("Old.md")?.content == "Original")
  }

  @Test func trashRetainsNewTypingAsRecoveryAndNeverResurrectsItsOldPath() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let original = try await repository.cache(
      RemoteNote(content: "Original", version: "v1"), path: "Folder/Old.md")
    _ = try await repository.cache(
      RemoteNote(content: "Clean", version: "v2"), path: "Folder/Clean.md")
    let coordinator = try WorkspaceStructuralCoordinator(
      rootDirectory: fixture.directory, scope: fixture.scope)
    let remote = StructuralTestRemote(scope: fixture.scope, paused: true)
    let request = Task {
      try await coordinator.perform(.trash(path: "Folder", isFolder: true), with: remote)
    }
    await remote.waitUntilRequested()
    _ = try await repository.save(
      path: "Folder/Old.md", content: "Typing after trash began",
      expectedRevision: original.localRevision)
    await remote.release()
    #expect(try await request.value.state == .applied)
    #expect(try await repository.note("Folder/Clean.md") == nil)
    #expect(try await repository.note("Folder/Old.md")?.state == .recoveryDraft)
    let writer = RepositoryRemote(scope: fixture.scope)
    _ = try await repository.synchronize(with: writer)
    #expect(await writer.writes.isEmpty)
  }

  @Test func lateDestinationCollisionLeavesEveryOriginalPathAndAnActionableIntent() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.cache(RemoteNote(content: "One", version: "v1"), path: "Old/A.md")
    _ = try await repository.cache(RemoteNote(content: "Two", version: "v2"), path: "Old/B.md")
    let coordinator = try WorkspaceStructuralCoordinator(
      rootDirectory: fixture.directory, scope: fixture.scope)
    let remote = StructuralTestRemote(scope: fixture.scope, paused: true)
    let request = Task {
      try await coordinator.perform(.rename(from: "Old", to: "New", isFolder: true), with: remote)
    }
    await remote.waitUntilRequested()
    _ = try await repository.create(
      path: "New/B.md", content: "Local destination created during request")
    await remote.release()
    let operation = try await request.value
    #expect(operation.state == .needsReview)
    #expect(try await repository.note("Old/A.md")?.content == "One")
    #expect(try await repository.note("Old/B.md")?.content == "Two")
    #expect(try await repository.note("New/A.md") == nil)
    #expect(
      try await repository.note("New/B.md")?.content == "Local destination created during request")
    let captures = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    let capture = try await captures.enqueue(
      text: "Captured separately", capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
      timeZone: #require(TimeZone(identifier: "UTC")))
    await #expect(throws: WorkspaceRepositoryError.pendingStructuralChange) {
      try await captures.synchronize(with: CaptureTestRemote(scope: fixture.scope))
    }
    #expect(try await captures.capture(capture.id)?.operation == capture.operation)
    #expect(try await captures.capture(capture.id)?.state == .queued)
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await recovery.export(to: fixture.directory)
    let collision = try #require(await repository.note("New/B.md"))
    try await recovery.discardLocalNote(path: "New/B.md", expectedRevision: collision.localRevision)
    #expect(
      try await coordinator.resolve(
        operation.id, revision: operation.revision, as: .applied, with: remote
      ).state == .applied)
    #expect(try await repository.note("New/B.md")?.content == "Two")
    #expect(try await captures.capture(capture.id)?.operation == capture.operation)
  }

  @Test func failedRemapTransactionCannotPublishAHalfMovedFolder() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.cache(RemoteNote(content: "One", version: "v1"), path: "Old/A.md")
    _ = try await repository.cache(RemoteNote(content: "Two", version: "v2"), path: "Old/B.md")
    let databaseURL = WorkspaceDirectory.url(root: fixture.directory, scope: fixture.scope)
      .appendingPathComponent("index.sqlite")
    var database: OpaquePointer?
    #expect(sqlite3_open(databaseURL.path, &database) == SQLITE_OK)
    defer { sqlite3_close(database) }
    #expect(
      sqlite3_exec(
        database,
        "CREATE TRIGGER fail_remap BEFORE INSERT ON documents WHEN NEW.path='New/B.md' BEGIN SELECT RAISE(ABORT, 'Injected remap interruption'); END",
        nil, nil, nil) == SQLITE_OK)
    let coordinator = try WorkspaceStructuralCoordinator(
      rootDirectory: fixture.directory, scope: fixture.scope)
    let remote = StructuralTestRemote(scope: fixture.scope)
    let operation = try await coordinator.perform(
      .rename(from: "Old", to: "New", isFolder: true), with: remote)
    #expect(operation.state == .needsReview)
    #expect(try await repository.notes().map(\.path).sorted() == ["Old/A.md", "Old/B.md"])
    #expect(sqlite3_exec(database, "DROP TRIGGER fail_remap", nil, nil, nil) == SQLITE_OK)
    _ = try await coordinator.resolve(
      operation.id, revision: operation.revision, as: .applied, with: remote)
    #expect(try await repository.notes().map(\.path).sorted() == ["New/A.md", "New/B.md"])
    #expect(await remote.requests.count == 1)
  }
}

actor StructuralTestRemote: StructuralRemote {
  enum Failure { case unknown, rejected }
  nonisolated let profileID: UUID
  nonisolated let origin: ConnectionOrigin
  var identityValue: RemoteWorkspaceIdentity
  var requests: [WorkspaceStructuralAction] = []
  let paused: Bool
  let failure: Failure?
  var continuation: CheckedContinuation<Void, Never>?
  var observers: [CheckedContinuation<Void, Never>] = []

  init(scope: WorkspaceScope, paused: Bool = false, failure: Failure? = nil) {
    profileID = scope.profileID
    origin = scope.origin
    identityValue = RemoteWorkspaceIdentity(
      workspaceID: scope.workspaceID, hostID: scope.hostID, supportsConditionalWorkspaceWrites: true
    )
    self.paused = paused
    self.failure = failure
  }

  func identity() -> RemoteWorkspaceIdentity { identityValue }
  func setHost(_ value: String) { identityValue.hostID = value }
  func perform(_ action: WorkspaceStructuralAction, workspaceID: String) async throws {
    #expect(workspaceID == identityValue.workspaceID)
    requests.append(action)
    if paused {
      await withCheckedContinuation { continuation in
        self.continuation = continuation
        for observer in observers { observer.resume() }
        observers = []
      }
    }
    if let failure {
      switch failure {
      case .unknown: throw TestNetworkError.disconnected
      case .rejected: throw StructuralRemoteError.rejected
      }
    }
  }
  func waitUntilRequested() async {
    if continuation != nil { return }
    await withCheckedContinuation { observers.append($0) }
  }
  func release() {
    continuation?.resume()
    continuation = nil
  }
}
