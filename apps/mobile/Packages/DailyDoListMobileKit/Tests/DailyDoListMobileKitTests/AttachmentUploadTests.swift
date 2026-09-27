import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListMobileKit

struct AttachmentUploadTests {
  @Test func originalsAndIntentCommitAtomicallyAndNotesWaitForAcknowledgement() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let index = try index(fixture)
    let uploads = try repository(fixture)
    let original = Data([0, 255, 0, 128, 41])
    try index.execute(
      """
      CREATE TRIGGER fail_original BEFORE INSERT ON workspace_values
      WHEN instr(NEW.key, 'attachment-original/')=1 BEGIN SELECT RAISE(FAIL, 'Synthetic disk failure'); END
      """)
    await #expect(throws: WorkspaceRepositoryError.self) {
      try await uploads.prepare(data: original, originalFilename: "sample.png")
    }
    #expect(try index.values(prefix: "attachment-").isEmpty)
    try index.execute("DROP TRIGGER fail_original")
    let prepared = try await uploads.prepare(data: original, originalFilename: "sample.png")
    let restarted = try repository(fixture)
    #expect(try await restarted.bytes(prepared.id) == original)
    #expect(try await restarted.upload(prepared.id)?.path == prepared.path)
    let notes = try fixture.open()
    _ = try await notes.create(
      path: "A.md", content: "![[\(prepared.path)]]", requiringAttachments: [prepared.dependency])
    let host = AttachmentTestRemote(scope: fixture.scope)
    let noteHost = RepositoryRemote(scope: fixture.scope)
    _ = try await notes.synchronize(with: noteHost)
    #expect(await noteHost.writes.isEmpty)
    let cache = try WorkspaceCache(
      rootDirectory: fixture.directory, scope: fixture.scope, budgetBytes: 0)
    _ = try await cache.trim()
    #expect(try await restarted.bytes(prepared.id) == original)
    _ = try await restarted.synchronize(with: host)
    #expect(try await restarted.upload(prepared.id)?.state == .acknowledged)
    _ = try await cache.trim()
    await #expect(throws: AttachmentUploadError.missingOriginal) {
      try await restarted.bytes(prepared.id)
    }
    _ = try await notes.synchronize(with: noteHost)
    #expect(await noteHost.writes.count == 1)
    #expect(try await notes.note("A.md")?.state == .synced)
    #expect(await host.writes == [prepared.path])
    let recovery = RecoveryAttachmentUploads(
      values: try index.values(prefix: ""), scope: fixture.scope)
    #expect(recovery.uploads.isEmpty)
    #expect(recovery.recognizedKeys.contains(AttachmentUploadRecord.key(prepared.id)))
  }

  @Test(arguments: ["same", "deleted", "changed"])
  func lostReplyReconcilesExactBytesWithoutDuplicateCreateOrResurrection(_ result: String)
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let uploads = try repository(fixture)
    let original = Data([1, 2, 255, 0])
    let prepared = try await uploads.prepare(data: original, originalFilename: "archive.bin")
    let host = AttachmentTestRemote(scope: fixture.scope)
    await host.loseNextResponse()
    await #expect(throws: TestNetworkError.self) { try await uploads.synchronize(with: host) }
    let attempted = try #require(try await uploads.upload(prepared.id))
    #expect(attempted.state == .attempting)
    await #expect(throws: AttachmentUploadError.cannotCancelAttemptedUpload) {
      try await uploads.cancel(prepared.id, expectedRevision: attempted.revision)
    }
    if result == "deleted" { await host.replace(prepared.path, data: nil) }
    if result == "changed" { await host.replace(prepared.path, data: Data([9, 9])) }
    let restarted = try repository(fixture)
    _ = try await restarted.synchronize(with: host)
    _ = try await restarted.synchronize(with: host)
    #expect(await host.writes.count == 1)
    let current = try #require(try await restarted.upload(prepared.id))
    #expect(current.state == (result == "same" ? .acknowledged : .needsReview))
    #expect(try await restarted.bytes(prepared.id) == original)
    if result != "same" {
      let recovery = RecoveryAttachmentUploads(
        values: try index(fixture).values(prefix: ""), scope: fixture.scope)
      #expect(recovery.uploads.map(\.id) == [prepared.id])
      #expect(recovery.originals[prepared.id] == original)
    }
  }

  @Test func lateNoteAcknowledgementKeepsANewerAttachmentDependency() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let uploads = try repository(fixture)
    let host = AttachmentTestRemote(scope: fixture.scope)
    let first = try await uploads.prepare(data: Data([1]), originalFilename: "one.png")
    _ = try await uploads.synchronize(with: host)
    let notes = try fixture.open()
    let note = try await notes.create(
      path: "A.md", content: "![[\(first.path)]]", requiringAttachments: [first.dependency])
    let noteHost = RepositoryRemote(scope: fixture.scope)
    await noteHost.pauseNextWrite()
    let sending = Task { try await notes.synchronize(with: noteHost) }
    await noteHost.waitForPausedWrite()
    let second = try await uploads.prepare(data: Data([2]), originalFilename: "two.png")
    _ = try await notes.save(
      path: "A.md", content: "![[\(second.path)]]", expectedRevision: note.localRevision,
      requiringAttachments: [second.dependency])
    await noteHost.releaseWrite()
    _ = try await sending.value
    #expect(await noteHost.writes.count == 1)
    #expect(try index(fixture).document("A.md")?.requiredAttachments == [second.dependency])
    _ = try await uploads.synchronize(with: host)
    _ = try await notes.synchronize(with: noteHost)
    #expect(await noteHost.writes.count == 2)
    #expect(try index(fixture).document("A.md")?.requiredAttachments == nil)
  }

  @Test func identityCaptureStructuralAndDisconnectBarriersSurviveIndependentHandles() async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let uploads = try repository(fixture)
    let prepared = try await uploads.prepare(data: Data([5]), originalFilename: "safe.png")
    let host = AttachmentTestRemote(scope: fixture.scope)
    await host.setWorkspace("different-workspace")
    await #expect(throws: WorkspaceRepositoryError.workspaceMismatch) {
      try await uploads.synchronize(with: host)
    }
    #expect(await host.readCount == 0)
    await host.setWorkspace(fixture.scope.workspaceID)
    let capture = try CaptureOutbox(rootDirectory: fixture.directory, scope: fixture.scope)
    let queued = try await capture.enqueue(
      text: "Synthetic capture", capturedAt: Date(), timeZone: .current)
    _ = try await uploads.synchronize(with: host)
    #expect(await host.writes.isEmpty)
    _ = try await capture.cancel(queued.id, replacing: queued.revision)
    let index = try index(fixture)
    #expect(throws: WorkspaceRepositoryError.pendingAttachmentDependencies) {
      try index.prepareStructural(
        WorkspaceStructuralOperation(
          id: UUID(), scope: fixture.scope,
          action: .trash(path: "attachments", isFolder: true), startedAt: Date(),
          state: .attempting,
          cachedNotes: [], revision: 0))
    }
    let structural = try index.prepareStructural(
      WorkspaceStructuralOperation(
        id: UUID(), scope: fixture.scope,
        action: .trash(path: "Unrelated.md", isFolder: false), startedAt: Date(),
        state: .attempting,
        cachedNotes: [], revision: 0))
    _ = try await uploads.synchronize(with: host)
    #expect(await host.writes.isEmpty)
    await #expect(throws: WorkspaceRepositoryError.pendingStructuralChange) {
      try await uploads.prepare(data: Data([3]), originalFilename: "during-rename.png")
    }
    _ = try index.resolveStructural(
      structural.id, revision: structural.revision, resolution: .notApplied)
    await host.pauseNextWrite()
    let sending = Task { try await uploads.synchronize(with: host) }
    await host.waitForPausedWrite()
    let anotherCapture = try await capture.enqueue(
      text: "Later capture", capturedAt: Date(), timeZone: .current)
    let captureHost = CaptureTestRemote(scope: fixture.scope)
    await #expect(throws: WorkspaceRepositoryError.pendingAttachmentDependencies) {
      try await capture.synchronize(with: captureHost)
    }
    await uploads.invalidateConnection()
    await host.releaseWrite()
    await #expect(throws: WorkspaceRepositoryError.connectionChanged) { try await sending.value }
    #expect(try await uploads.upload(prepared.id)?.state == .attempting)
    let restarted = try repository(fixture)
    _ = try await restarted.synchronize(with: host)
    #expect(try await restarted.upload(prepared.id)?.state == .acknowledged)
    _ = try await capture.synchronize(with: captureHost)
    #expect(try await capture.capture(anotherCapture.id)?.state == .applied)
  }

  @Test func strictPairsLimitsAndCancellationPreserveRecoveryBoundaries() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let uploads = try repository(fixture)
    await #expect(
      throws: AttachmentUploadError.tooLarge(maxBytes: DaemonProtocol.attachmentMaxBytes)
    ) {
      try await uploads.prepare(
        data: Data(count: DaemonProtocol.attachmentMaxBytes + 1), originalFilename: "large.bin")
    }
    let first = try await uploads.prepare(data: Data([1, 2]), originalFilename: "same name.png")
    let second = try await uploads.prepare(data: Data([1, 2]), originalFilename: "same name.png")
    #expect(first.path != second.path)
    _ = try await uploads.cancel(second.id, expectedRevision: second.revision)
    let index = try index(fixture)
    let original = try #require(try index.value(AttachmentUploadRecord.originalKey(first.id)))
    var corrupted = original
    corrupted.data = Data([3, 4])
    _ = try index.commitValues([
      WorkspaceValueMutation(
        key: original.key, value: corrupted, expectedRevision: original.revision)
    ])
    let recovery = RecoveryAttachmentUploads(
      values: try index.values(prefix: ""), scope: fixture.scope)
    #expect(!recovery.recognizedKeys.contains(AttachmentUploadRecord.key(first.id)))
    #expect(!recovery.recognizedKeys.contains(original.key))
    #expect(recovery.recognizedKeys.contains(AttachmentUploadRecord.key(second.id)))
    let maintenance = try WorkspaceStorageMaintenance(
      rootDirectory: fixture.directory, scope: fixture.scope)
    #expect(try await maintenance.collectGarbage().unsupportedProtectedRecords == 2)
    let host = AttachmentTestRemote(scope: fixture.scope)
    await #expect(throws: AttachmentUploadError.corruptRecord) {
      try await uploads.synchronize(with: host)
    }
    #expect(await host.writes.isEmpty)
  }

  @Test func aggregateAdmissionOnlyEvictsCompletedOriginalsAndRollsBackOnInsufficientSpace()
    async throws
  {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let uploads = try repository(fixture)
    let first = try await uploads.prepare(data: Data([1, 2, 3]), originalFilename: "one.png")
    let host = AttachmentTestRemote(scope: fixture.scope)
    _ = try await uploads.synchronize(with: host)
    let second = try await uploads.prepare(data: Data([4, 5, 6]), originalFilename: "two.png")
    let index = try index(fixture)
    #expect(throws: AttachmentUploadError.storageLimit(maxBytes: 6)) {
      try index.transaction { try index.makeAttachmentOriginalSpace(adding: 4, maximumBytes: 6) }
    }
    #expect(try await uploads.bytes(first.id) == Data([1, 2, 3]))
    #expect(try await uploads.bytes(second.id) == Data([4, 5, 6]))
    try index.transaction { try index.makeAttachmentOriginalSpace(adding: 3, maximumBytes: 6) }
    await #expect(throws: AttachmentUploadError.missingOriginal) {
      try await uploads.bytes(first.id)
    }
    #expect(try await uploads.upload(first.id)?.state == .acknowledged)
    #expect(try await uploads.bytes(second.id) == Data([4, 5, 6]))
  }

  private func repository(_ fixture: RepositoryFixture) throws -> AttachmentUploadRepository {
    try AttachmentUploadRepository(rootDirectory: fixture.directory, scope: fixture.scope)
  }
  private func index(_ fixture: RepositoryFixture) throws -> SQLiteWorkspaceIndex {
    try SQLiteWorkspaceIndex(
      url: WorkspaceDirectory.url(root: fixture.directory, scope: fixture.scope)
        .appendingPathComponent("index.sqlite"), scope: fixture.scope)
  }
}

private actor AttachmentTestRemote: AttachmentUploadRemote {
  nonisolated let profileID: UUID
  nonisolated let origin: ConnectionOrigin
  var reportedIdentity: RemoteWorkspaceIdentity
  var files: [String: VaultFilePayload] = [:]
  var writes: [String] = []
  var readCount = 0
  var loseResponse = false
  var pauseNext = false
  var continuation: CheckedContinuation<Void, Never>?
  var observers: [CheckedContinuation<Void, Never>] = []
  init(scope: WorkspaceScope) {
    profileID = scope.profileID
    origin = scope.origin
    reportedIdentity = RemoteWorkspaceIdentity(
      workspaceID: scope.workspaceID, hostID: scope.hostID,
      supportsConditionalWorkspaceWrites: true, supportsAttachmentUploads: true)
  }
  func identity() -> RemoteWorkspaceIdentity { reportedIdentity }
  func setWorkspace(_ id: String) { reportedIdentity.workspaceID = id }
  func loseNextResponse() { loseResponse = true }
  func pauseNextWrite() { pauseNext = true }
  func waitForPausedWrite() async {
    if continuation != nil { return }
    await withCheckedContinuation { observers.append($0) }
  }
  func releaseWrite() {
    continuation?.resume()
    continuation = nil
  }
  func replace(_ path: String, data: Data?) {
    files[path] = data.map { VaultFilePayload(data: $0, metadata: metadata(path, $0)) }
  }
  func readAttachment(_ path: String) -> VaultFilePayload? {
    readCount += 1
    return files[path]
  }
  func createAttachment(_ path: String, data: Data, workspaceID: String) async throws
    -> VaultFileMetadata
  {
    guard reportedIdentity.workspaceID == workspaceID else {
      throw WorkspaceRepositoryError.workspaceMismatch
    }
    guard files[path] == nil else { throw WorkspaceRemoteError.conflict }
    writes.append(path)
    if pauseNext {
      pauseNext = false
      await withCheckedContinuation { continuation in
        self.continuation = continuation
        for observer in observers { observer.resume() }
        observers = []
      }
    }
    let value = metadata(path, data)
    files[path] = VaultFilePayload(data: data, metadata: value)
    if loseResponse {
      loseResponse = false
      throw TestNetworkError.disconnected
    }
    return value
  }
  private func metadata(_ path: String, _ data: Data) -> VaultFileMetadata {
    VaultFileMetadata(
      path: path, version: "v\(writes.count)", mtime: 0, size: data.count,
      mimeType: "application/octet-stream")
  }
}
