import Darwin
import Foundation
import Testing

@testable import DailyDoListMobileKit

struct RecoveryExportStagingTests {
  @Test func everyPickerOutcomeRemovesTheStagedOriginalsButKeepsTheVerifiedCopy() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.create(path: "Draft.md", content: "Protected draft")
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    let root = fixture.directory.appendingPathComponent("staging")
    let session = RecoveryExportSession(
      recovery: recovery, staging: RecoveryExportStaging(rootDirectory: root))

    let replaced = try await session.export()
    let cancelled = try await session.export()
    #expect(try containers(in: root).count == 1)
    #expect(!exists(replaced.directory))
    try await session.discard()
    #expect(!exists(cancelled.directory))

    let exported = try await session.export()
    let copied = fixture.directory.appendingPathComponent("Files-copy")
    try FileManager.default.copyItem(at: exported.directory, to: copied)
    let proof = try await recovery.verifyExport(exported, at: copied)
    try await session.discard()
    #expect(try containers(in: root).isEmpty)
    try await recovery.forget(afterExport: proof)
    #expect(try await recovery.isRetired())
    let entry = try #require(exported.manifest.entries.first { $0.kind == "working" })
    let saved = try String(
      contentsOf: copied.appendingPathComponent(entry.relativePath), encoding: .utf8)
    #expect(saved == "Protected draft")
  }

  @Test func restartCleanupRemovesAbandonedExportsButSkipsLiveLeases() async throws {
    let root = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let scope = try syntheticScope()
    let other = try syntheticScope()
    let live = try await RecoveryExportStaging(rootDirectory: root).begin(for: scope)
    _ = try await RecoveryExportStaging(rootDirectory: root).begin(for: scope)
    _ = try await RecoveryExportStaging(rootDirectory: root).begin(for: other)

    let restarted = RecoveryExportStaging(rootDirectory: root)
    #expect(
      try await restarted.removeAbandoned(for: scope.profileID)
        == RecoveryStagingCleanup(removed: 1, active: 1))
    #expect(try await restarted.removeAbandoned() == RecoveryStagingCleanup(removed: 1, active: 1))
    #expect(try containers(in: root) == [live.container.lastPathComponent])
  }

  @Test func cleanupNeverFollowsSymlinksOrTouchesEntriesItDidNotCreate() async throws {
    let base = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: base) }
    let scope = try syntheticScope()
    let root = base.appendingPathComponent("staging")
    let outside = base.appendingPathComponent("outside")
    let kept = outside.appendingPathComponent("Kept.md")
    try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
    try Data("Outside the staging root".utf8).write(to: kept)
    let staging = RecoveryExportStaging(rootDirectory: root)
    _ = try await staging.begin(for: scope)
    let lookalike = UUID().uuidString + "." + UUID().uuidString
    try FileManager.default.createSymbolicLink(
      at: root.appendingPathComponent(lookalike), withDestinationURL: outside)
    let tampered = scope.profileID.uuidString + "." + UUID().uuidString
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent(tampered), withIntermediateDirectories: false)
    try FileManager.default.createSymbolicLink(
      at: root.appendingPathComponent(tampered).appendingPathComponent("lease"),
      withDestinationURL: kept)
    let unknown = root.appendingPathComponent("Notes")
    try FileManager.default.createDirectory(at: unknown, withIntermediateDirectories: false)

    let result = try await staging.removeAbandoned()
    #expect(result == RecoveryStagingCleanup(removed: 1, rejected: [lookalike, tampered].sorted()))
    #expect(exists(root.appendingPathComponent(lookalike)))
    #expect(exists(root.appendingPathComponent(tampered)))
    #expect(exists(unknown))
    #expect(try String(contentsOf: kept, encoding: .utf8) == "Outside the staging root")

    let linkedRoot = base.appendingPathComponent("linked")
    try FileManager.default.createSymbolicLink(at: linkedRoot, withDestinationURL: outside)
    let linked = RecoveryExportStaging(rootDirectory: linkedRoot)
    await #expect(throws: RecoveryStagingError.invalidRoot) { try await linked.begin(for: scope) }
    await #expect(throws: RecoveryStagingError.invalidRoot) { try await linked.removeAbandoned() }
    #expect(try FileManager.default.contentsOfDirectory(atPath: outside.path) == ["Kept.md"])
  }

  @Test func aFailedCleanupIsReportedAndRetried() async throws {
    let root = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let fault = RemovalFault()
    let staging = RecoveryExportStaging(rootDirectory: root) { url in
      if fault.active { throw CocoaError(.fileWriteNoPermission) }
      try FileManager.default.removeItem(at: url)
    }
    _ = try await staging.begin(for: try syntheticScope())
    fault.active = true
    await #expect(throws: RecoveryStagingError.cleanupFailed(1)) {
      try await staging.removeAbandoned()
    }
    #expect(try containers(in: root).count == 1)
    fault.active = false
    #expect(try await staging.removeAbandoned().removed == 1)
    #expect(try containers(in: root).isEmpty)
  }

  private func containers(in root: URL) throws -> [String] {
    try FileManager.default.contentsOfDirectory(atPath: root.path).filter {
      RecoveryExportStaging.owner(ofContainerNamed: $0) != nil
    }
  }

  private func exists(_ url: URL) -> Bool {
    var info = stat()
    return lstat(url.path, &info) == 0
  }

  private func temporaryDirectory() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(
      "ddl-staging-test-" + UUID().uuidString)
  }

  private func syntheticScope() throws -> WorkspaceScope {
    WorkspaceScope(
      profileID: UUID(), workspaceID: "synthetic-workspace", hostID: "synthetic-host",
      origin: try ConnectionOrigin("https://notes.example.test"))
  }
}

private final class RemovalFault: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false
  var active: Bool {
    get { lock.withLock { value } }
    set { lock.withLock { value = newValue } }
  }
}
