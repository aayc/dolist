import DailyDoListAgentCore
import Foundation
import Testing

@testable import DailyDoListMobileKit

struct VerifiedRecoveryTests {
  @Test func onlyAnIntactCompletedCopyCanAuthorizeRetirement() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let note = try await repository.create(path: "Draft.md", content: "Protected draft")
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    let exported = try await recovery.export(to: fixture.directory)
    await #expect(throws: WorkspaceMaintenanceError.invalidExportDestination) {
      try await recovery.verifyExport(exported, at: exported.directory)
    }
    let copied = fixture.directory.appendingPathComponent("Files-copy")
    try FileManager.default.copyItem(at: exported.directory, to: copied)
    let proof = try await recovery.verifyExport(exported, at: copied)
    let entry = try #require(exported.manifest.entries.first)
    let target = copied.appendingPathComponent(entry.relativePath)
    try Data("Tampered draft".utf8).write(to: target)
    await #expect(throws: WorkspaceMaintenanceError.invalidExport) {
      try await recovery.forget(afterExport: proof)
    }
    #expect(try await repository.note("Draft.md")?.content == "Protected draft")
    try FileManager.default.removeItem(at: target)
    try FileManager.default.createSymbolicLink(at: target, withDestinationURL: note.workingFile)
    await #expect(throws: WorkspaceMaintenanceError.invalidExport) {
      try await recovery.verifyExport(exported, at: copied)
    }
    try FileManager.default.removeItem(at: target)
    try FileManager.default.copyItem(
      at: exported.directory.appendingPathComponent(entry.relativePath), to: target)
    try await recovery.forget(afterExport: proof)
    #expect(!FileManager.default.fileExists(atPath: note.workingFile.path))
    #expect(try String(contentsOf: target, encoding: .utf8) == "Protected draft")
    await #expect(throws: WorkspaceRepositoryError.workspaceForgotten) {
      try await repository.save(
        path: "Draft.md", content: "Late edit", expectedRevision: note.localRevision)
    }
  }

  @Test(arguments: ["capture", "note", "composer", "agent"])
  func newWorkFromAnotherHandleInvalidatesTheExport(_ kind: String) async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    _ = try await repository.create(path: "Draft.md", content: "Earlier draft")
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    let exported = try await recovery.export(to: fixture.directory)
    let copied = fixture.directory.appendingPathComponent("Files-copy")
    try FileManager.default.copyItem(at: exported.directory, to: copied)
    let proof = try await recovery.verifyExport(exported, at: copied)
    switch kind {
    case "capture":
      let outbox = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
      _ = try await outbox.enqueue(text: "New Siri capture", capturedAt: Date(), timeZone: .current)
    case "note":
      let second = try fixture.open()
      _ = try await second.create(path: "Another.md", content: "New local note")
    case "composer":
      let cache = try WorkspaceCache(rootDirectory: fixture.directory, scope: fixture.scope)
      _ = try await cache.saveComposer(.orchestrator, text: "New unsent reply", replacing: 0)
    default:
      let store = try index(fixture)
      let record = AgentMutationRecoveryRecord(
        scope: fixture.scope,
        intent: PendingAgentMutation(
          id: "new-action", command: .cancelThread("thread-test"), createdAt: Date()))
      try save(record, in: store)
    }
    await #expect(throws: WorkspaceMaintenanceError.exportChanged) {
      try await recovery.forget(afterExport: proof)
    }
    #expect(try await recovery.summary().requiresDecision)
    #expect(try await repository.note("Draft.md")?.content == "Earlier draft")
    let newer = try await recovery.export(to: fixture.directory)
    let copiedAgain = fixture.directory.appendingPathComponent("New-Files-copy")
    try FileManager.default.copyItem(at: newer.directory, to: copiedAgain)
    let newProof = try await recovery.verifyExport(newer, at: copiedAgain)
    try await recovery.forget(afterExport: newProof)
    #expect(throws: WorkspaceRepositoryError.workspaceForgotten) { try fixture.open() }
  }

  @Test(arguments: ["future", "orphan", "mismatch"])
  func unsupportedJournalDataStaysProtected(_ kind: String) async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let store = try index(fixture)
    var record = AgentMutationRecoveryRecord(
      scope: fixture.scope,
      intent: PendingAgentMutation(
        id: "action", command: .cancelThread("thread-test"), createdAt: Date()))
    if kind == "future" { record.version = 2 }
    try save(
      record, in: store, slotID: kind == "mismatch" ? "another-action" : "action",
      includeRecord: kind != "orphan")
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    let exported = try await recovery.export(to: fixture.directory)
    #expect(exported.manifest.agentOperations.isEmpty)
    #expect(exported.manifest.unsupportedRecordCount > 0)
    let copied = fixture.directory.appendingPathComponent("Files-copy")
    try FileManager.default.copyItem(at: exported.directory, to: copied)
    await #expect(throws: WorkspaceMaintenanceError.incompleteExport) {
      try await recovery.verifyExport(exported, at: copied)
    }
    await #expect(throws: WorkspaceMaintenanceError.unsyncedWork) { try await recovery.forget() }
  }

  private func index(_ fixture: RepositoryFixture) throws -> SQLiteWorkspaceIndex {
    try SQLiteWorkspaceIndex(
      url: WorkspaceDirectory.url(root: fixture.directory, scope: fixture.scope)
        .appendingPathComponent("index.sqlite"), scope: fixture.scope)
  }

  private func save(
    _ record: AgentMutationRecoveryRecord, in store: SQLiteWorkspaceIndex,
    slotID: String? = nil, includeRecord: Bool = true
  ) throws {
    let key = "agent-operation/" + record.intent.id
    let exclusion = try #require(record.intent.command.exclusionKey)
    let slot = "agent-operation-slot/" + MarkdownCheckpointStore.digest(Data(exclusion.utf8))
    var changes = [
      WorkspaceValueMutation(
        key: slot,
        value: WorkspaceStoredValue(
          key: slot, data: Data((slotID ?? record.intent.id).utf8),
          updatedAt: Date(), retention: .durable))
    ]
    if includeRecord {
      changes.append(
        WorkspaceValueMutation(
          key: key,
          value: WorkspaceStoredValue(
            key: key, data: try JSONEncoder().encode(record), updatedAt: Date(), retention: .durable
          )))
    }
    try store.commitValues(changes)
  }
}
