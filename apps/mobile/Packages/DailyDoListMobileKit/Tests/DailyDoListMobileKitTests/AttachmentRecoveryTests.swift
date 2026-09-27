import Foundation
import Testing

@testable import DailyDoListMobileKit

struct AttachmentRecoveryTests {
  @Test func verifiedExportRetainsExactPendingOriginalAndInvalidatesAfterAnotherUpload()
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let uploads = try AttachmentUploadRepository(
      rootDirectory: fixture.directory, scope: fixture.scope)
    let original = Data([0, 255, 12, 128, 0])
    let upload = try await uploads.prepare(data: original, originalFilename: "Synthetic scan.png")
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    let summary = try await recovery.summary()
    #expect(summary.attachments == 1 && summary.unknownRecords == 0)
    await #expect(throws: WorkspaceMaintenanceError.unsyncedWork) { try await recovery.forget() }
    let exported = try await recovery.export(to: fixture.directory)
    #expect(exported.manifest.attachmentUploads.first?.id == upload.id)
    #expect(exported.manifest.attachmentUploads.first?.originalFilename == "Synthetic scan.png")
    let entry = try #require(exported.manifest.entries.first { $0.kind == "attachment-original" })
    #expect(
      try Data(contentsOf: exported.directory.appendingPathComponent(entry.relativePath))
        == original)
    let copied = fixture.directory.appendingPathComponent("Files-copy")
    try FileManager.default.copyItem(at: exported.directory, to: copied)
    let proof = try await recovery.verifyExport(exported, at: copied)
    try Data([99]).write(to: copied.appendingPathComponent(entry.relativePath))
    await #expect(throws: WorkspaceMaintenanceError.invalidExport) {
      try await recovery.forget(afterExport: proof)
    }
    try original.write(to: copied.appendingPathComponent(entry.relativePath))
    let second = try AttachmentUploadRepository(
      rootDirectory: fixture.directory, scope: fixture.scope)
    _ = try await second.prepare(data: Data([1]), originalFilename: "Later.png")
    await #expect(throws: WorkspaceMaintenanceError.exportChanged) {
      try await recovery.forget(afterExport: proof)
    }
    let newer = try await recovery.export(to: fixture.directory)
    let copiedAgain = fixture.directory.appendingPathComponent("Files-copy-new")
    try FileManager.default.copyItem(at: newer.directory, to: copiedAgain)
    let newProof = try await recovery.verifyExport(newer, at: copiedAgain)
    try await recovery.forget(afterExport: newProof)
    await #expect(throws: WorkspaceRepositoryError.workspaceForgotten) {
      try await uploads.bytes(upload.id)
    }
  }

  @Test func cancelledUploadMetadataDoesNotRequireExportButMissingPendingBytesStayProtected()
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let uploads = try AttachmentUploadRepository(
      rootDirectory: fixture.directory, scope: fixture.scope)
    let first = try await uploads.prepare(data: Data([1, 2]), originalFilename: "Cancelled.png")
    _ = try await uploads.cancel(first.id, expectedRevision: first.revision)
    let recovery = try WorkspaceRecovery(rootDirectory: fixture.directory, scope: fixture.scope)
    #expect(try await recovery.summary().requiresDecision == false)
    let pending = try await uploads.prepare(data: Data([3, 4]), originalFilename: "Protected.png")
    let index = try SQLiteWorkspaceIndex(
      url: WorkspaceDirectory.url(root: fixture.directory, scope: fixture.scope)
        .appendingPathComponent("index.sqlite"), scope: fixture.scope)
    let key = AttachmentUploadRecord.originalKey(pending.id)
    let value = try #require(try index.value(key))
    try index.commitValues([WorkspaceValueMutation(key: key, expectedRevision: value.revision)])
    let exported = try await recovery.export(to: fixture.directory)
    #expect(exported.manifest.unsupportedRecordCount == 1)
    #expect(exported.manifest.attachmentUploads.isEmpty)
    await #expect(throws: WorkspaceMaintenanceError.incompleteExport) {
      try await recovery.verifyExport(
        exported, at: fixture.directory.appendingPathComponent("unused"))
    }
  }
}
