import Foundation
import Testing

@testable import DailyDoListMobileKit

struct WorkspaceRecoveryTests {
  @Test func recoveryCopiesCreatedDuringTrashRemainExportableAfterTheNoteDisappears() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let original = try await repository.cache(
      RemoteNote(content: "Remote original", version: "v1"), path: "Old.md")
    let coordinator = try WorkspaceStructuralCoordinator(
      rootDirectory: fixture.directory, scope: fixture.scope)
    let remote = StructuralTestRemote(scope: fixture.scope, paused: true)
    let request = Task {
      try await coordinator.perform(.trash(path: "Old.md", isFolder: false), with: remote)
    }
    await remote.waitUntilRequested()
    let conflict = try await repository.saveForReview(
      path: "Old.md", content: "Recovered local typing", expectedRevision: original.localRevision)
    _ = try await repository.useRemoteVersion(
      path: "Old.md", expectedRevision: conflict.localRevision)
    await remote.release()
    #expect(try await request.value.state == .applied)
    #expect(try await repository.note("Old.md") == nil)
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    let exported = try await recovery.export(to: fixture.directory)
    let copies = try exported.manifest.entries.filter { $0.kind == "recovery" }.map {
      try String(
        contentsOf: exported.directory.appendingPathComponent($0.relativePath), encoding: .utf8)
    }
    #expect(copies.contains("Recovered local typing"))
    await #expect(throws: WorkspaceMaintenanceError.unsyncedWork) { try await recovery.forget() }
  }

  @Test func localDiscardRejectsStaleEditsAndAttemptedWrites() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let draft = try await repository.create(path: "Draft.md", content: "One")
    let newer = try await repository.save(
      path: "Draft.md", content: "Two", expectedRevision: draft.localRevision)
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    await #expect(
      throws: WorkspaceRepositoryError.staleRevision(
        expected: draft.localRevision, actual: newer.localRevision)
    ) {
      try await recovery.discardLocalNote(path: "Draft.md", expectedRevision: draft.localRevision)
    }
    let remote = RepositoryRemote(scope: fixture.scope)
    await remote.loseNextResponse()
    await #expect(throws: TestNetworkError.self) { try await repository.synchronize(with: remote) }
    await #expect(throws: WorkspaceRepositoryError.pendingNoteWrites) {
      try await recovery.discardLocalNote(path: "Draft.md", expectedRevision: newer.localRevision)
    }
    _ = try await repository.synchronize(with: remote)
    try await recovery.discardLocalNote(path: "Draft.md", expectedRevision: newer.localRevision)
    #expect(try await repository.note("Draft.md") == nil)
    #expect(await remote.notes["Draft.md"]?.content == "Two")
  }

  @Test func exportKeepsAllMarkdownWithCollisionSafePathsAndFrozenCaptureRouting() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let paths = [
      "Case.md", "case.md", "Caf\u{e9}.md", "Cafe\u{301}.md", "Folder.md", "Folder.md/Child.md",
    ]
    for (offset, path) in paths.enumerated() {
      _ = try await repository.create(path: path, content: "Synthetic draft \(offset)")
    }
    let original = try await repository.cache(
      RemoteNote(content: "Authoritative original", version: "v1"), path: "Review.md")
    _ = try await repository.saveForReview(
      path: "Review.md", content: "My review text", expectedRevision: original.localRevision)
    let cache = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await cache.saveComposer(
      .thread("synthetic-thread"), text: "Unsent reply", replacing: 0)
    let outbox = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    let capture = try await outbox.enqueue(
      text: "Captured task", capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
      timeZone: #require(TimeZone(identifier: "America/Los_Angeles")))
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    let exported = try await recovery.export(to: fixture.directory)
    let manifestData = try Data(
      contentsOf: exported.directory.appendingPathComponent("manifest.json"))
    let manifest = try JSONDecoder().decode(RecoveryExportManifest.self, from: manifestData)
    #expect(manifest.captures.first?.operation == capture.operation)
    #expect(manifest.unsupportedRecordCount == 0)
    #expect(manifest.entries.filter { $0.kind == "working" }.count == paths.count + 1)
    #expect(
      Set(manifest.entries.map { $0.relativePath.lowercased() }).count == manifest.entries.count)
    var contents: [String] = []
    for entry in manifest.entries {
      let data = try Data(contentsOf: exported.directory.appendingPathComponent(entry.relativePath))
      #expect(MarkdownCheckpointStore.digest(data) == entry.contentHash)
      #expect(entry.relativePath.split(separator: "/").count == 2)
      contents.append(try #require(String(data: data, encoding: .utf8)))
    }
    #expect(contents.contains("Authoritative original"))
    #expect(contents.contains("My review text"))
    #expect(contents.contains("Unsent reply"))
    #expect(contents.contains("Captured task"))
    let json = try #require(JSONSerialization.jsonObject(with: manifestData) as? [String: Any])
    #expect(
      Set(json.keys) == [
        "formatVersion", "scope", "createdAt", "entries", "captures", "structuralOperations",
        "unsupportedRecordCount", "agentOperations", "snapshotFingerprint",
      ])
    #expect(try await repository.note("Review.md")?.state == .needsReview)
    let summary = try await recovery.summary()
    #expect(summary.notes == 7 && summary.composers == 1 && summary.captures == 1)
    await #expect(throws: WorkspaceMaintenanceError.invalidExportDestination) {
      try await recovery.export(
        to: WorkspaceDirectory.url(root: fixture.directory, scope: fixture.scope))
    }
  }

  @Test func forgetRefusesLocalWorkUntilExplicitDiscardAndFencesExistingWriters() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let draft = try await repository.create(path: "Unsent.md", content: "Export before forgetting")
    let cache = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
    let composer = try await cache.saveComposer(
      .orchestrator, text: "An unsent question", replacing: 0)
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    await #expect(throws: WorkspaceMaintenanceError.unsyncedWork) { try await recovery.forget() }
    let export = try await recovery.export(to: fixture.directory)
    try await recovery.forget(discardUnsyncedWork: true)
    #expect(!FileManager.default.fileExists(atPath: draft.workingFile.path))
    #expect(
      FileManager.default.fileExists(
        atPath: export.directory.appendingPathComponent("manifest.json").path))
    await #expect(throws: WorkspaceRepositoryError.workspaceForgotten) {
      try await repository.save(
        path: "Unsent.md", content: "Late typing", expectedRevision: draft.localRevision)
    }
    await #expect(throws: WorkspaceRepositoryError.workspaceForgotten) {
      try await cache.saveComposer(
        .orchestrator, text: "Late composer", replacing: composer.revision)
    }
    #expect(throws: WorkspaceRepositoryError.workspaceForgotten) { try fixture.open() }
    try await recovery.forget()
  }

  @Test func cleanCacheAndClearedComposerCanBeForgottenWithoutDiscardConfirmation() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.cache(
      RemoteNote(content: "Server-owned text", version: "v1"), path: "Clean.md")
    let cache = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await cache.saveComposer(.orchestrator, text: "", replacing: 0)
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    #expect(try await recovery.summary().requiresDecision == false)
    try await recovery.forget()
    await #expect(throws: WorkspaceRepositoryError.workspaceForgotten) {
      try await repository.notes()
    }
  }

  @Test func interruptedExportLeavesOriginalWorkAndPublishesNoPartialDirectory() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let draft = try await repository.create(path: "Draft.md", content: "Preserve me")
    let recovery = try WorkspaceRecovery(
      rootDirectory: fixture.directory, scope: fixture.scope,
      files: FailedRecoveryFileSystem(failure: .manifest))
    await #expect(throws: TestNetworkError.self) {
      try await recovery.export(to: fixture.directory)
    }
    #expect(try String(contentsOf: draft.workingFile, encoding: .utf8) == "Preserve me")
    let directories = try FileManager.default.contentsOfDirectory(atPath: fixture.directory.path)
    #expect(
      !directories.contains {
        $0.hasPrefix("DailyDoList-Recovery-") || $0.hasPrefix(".ddl-export-")
      })
    await #expect(throws: WorkspaceMaintenanceError.unsyncedWork) { try await recovery.forget() }
  }

  @Test func checkpointCleanupFailureCanBeRetriedAfterTheNamespaceIsRetired() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let draft = try await repository.create(path: "Draft.md", content: "Explicitly discarded")
    let files = FailedRecoveryFileSystem(failure: .cleanupOnce)
    let recovery = try WorkspaceRecovery(
      rootDirectory: fixture.directory, scope: fixture.scope, files: files)
    await #expect(throws: TestNetworkError.self) {
      try await recovery.forget(discardUnsyncedWork: true)
    }
    #expect(FileManager.default.fileExists(atPath: draft.workingFile.path))
    await #expect(throws: WorkspaceRepositoryError.workspaceForgotten) {
      try await repository.notes()
    }
    let restarted = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    try await restarted.forget()
    #expect(!FileManager.default.fileExists(atPath: draft.workingFile.path))
  }

  @Test func anUnresolvedStructuralIntentExportsItsOriginalFilesAndBlocksForget() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.cache(
      RemoteNote(content: "Before rename", version: "v1"), path: "Old.md")
    let coordinator = try WorkspaceStructuralCoordinator(
      rootDirectory: fixture.directory, scope: fixture.scope)
    let operation = try await coordinator.perform(
      .rename(from: "Old.md", to: "New.md", isFolder: false),
      with: StructuralTestRemote(scope: fixture.scope, failure: .unknown))
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    await #expect(throws: WorkspaceMaintenanceError.unsyncedWork) { try await recovery.forget() }
    let exported = try await recovery.export(to: fixture.directory)
    #expect(exported.manifest.structuralOperations.first?.id == operation.id)
    let entry = try #require(exported.manifest.entries.first { $0.kind == "structural-original" })
    #expect(
      try String(
        contentsOf: exported.directory.appendingPathComponent(entry.relativePath), encoding: .utf8)
        == "Before rename")
  }
}

private final class FailedRecoveryFileSystem: RecoveryFileSystem, @unchecked Sendable {
  enum Failure { case manifest, cleanupOnce }
  let failure: Failure
  let lock = NSLock()
  var cleanupFailed = false
  let base = FoundationRecoveryFileSystem()
  init(failure: Failure) { self.failure = failure }
  func beginExport(in parent: URL, id: UUID) throws -> RecoveryExportLocation {
    try base.beginExport(in: parent, id: id)
  }
  func write(_ data: Data, relativePath: String, to location: RecoveryExportLocation) throws {
    if failure == .manifest && relativePath == "manifest.json" {
      throw TestNetworkError.disconnected
    }
    try base.write(data, relativePath: relativePath, to: location)
  }
  func finishExport(_ location: RecoveryExportLocation) throws -> URL {
    try base.finishExport(location)
  }
  func abandonExport(_ location: RecoveryExportLocation) { base.abandonExport(location) }
  func removeCheckpoints(at directory: URL) throws {
    lock.lock()
    defer { lock.unlock() }
    if failure == .cleanupOnce && !cleanupFailed {
      cleanupFailed = true
      throw TestNetworkError.disconnected
    }
    try base.removeCheckpoints(at: directory)
  }
}
