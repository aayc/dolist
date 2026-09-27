import DailyDoListModels
import Foundation

/// Original bytes and the immutable destination commit before the editor receives its embed.
/// This actor has no UI/input-path work; call it after file/photo loading away from typing.
public actor AttachmentUploadRepository {
  public nonisolated let scope: WorkspaceScope
  let store: any WorkspaceStateStore
  let clock: @Sendable () -> Date
  var connectionGeneration: UInt64 = 0
  var synchronizing = false

  public init(
    rootDirectory: URL, scope: WorkspaceScope, clock: @escaping @Sendable () -> Date = { Date() }
  ) throws {
    self.scope = scope
    self.clock = clock
    store = try SQLiteWorkspaceIndex(
      url: WorkspaceDirectory.url(root: rootDirectory, scope: scope).appendingPathComponent(
        "index.sqlite"),
      scope: scope)
  }

  public init(
    scope: WorkspaceScope, store: any WorkspaceStateStore,
    clock: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.scope = scope
    self.store = store
    self.clock = clock
  }

  public func invalidateConnection() { connectionGeneration &+= 1 }

  public func uploads() throws -> [AttachmentUpload] {
    try store.values(prefix: "attachment-upload/").map {
      try AttachmentUploadRecord.decode($0, scope: scope).upload
    }.sorted { $0.createdAt == $1.createdAt ? $0.path < $1.path : $0.createdAt < $1.createdAt }
  }

  public func upload(_ id: UUID) throws -> AttachmentUpload? {
    guard let value = try store.value(AttachmentUploadRecord.key(id)) else { return nil }
    return try AttachmentUploadRecord.decode(value, scope: scope).upload
  }

  public func bytes(_ id: UUID) throws -> Data {
    let record = try require(id)
    let original = try store.value(AttachmentUploadRecord.originalKey(id))
    try record.validateOriginal(original)
    guard let original else { throw AttachmentUploadError.missingOriginal }
    return original.data
  }

  @discardableResult
  public func prepare(data: Data, originalFilename: String) throws -> AttachmentUpload {
    guard data.count <= DaemonProtocol.attachmentMaxBytes else {
      throw AttachmentUploadError.tooLarge(maxBytes: DaemonProtocol.attachmentMaxBytes)
    }
    guard !originalFilename.isEmpty, originalFilename.utf8.count <= 255,
      !originalFilename.contains("/"), !originalFilename.contains("\\"),
      !originalFilename.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    else { throw AttachmentUploadError.invalidFilename }
    let proposedExtension = (originalFilename as NSString).pathExtension.lowercased()
    let suffix =
      (1...12).contains(proposedExtension.utf8.count) && proposedExtension != "md"
        && proposedExtension.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) })
      ? proposedExtension : "bin"
    let id = UUID()
    let upload = AttachmentUpload(
      id: id, scope: scope, path: "attachments/" + id.uuidString.lowercased() + "." + suffix,
      originalFilename: originalFilename, sha256: MarkdownCheckpointStore.digest(data),
      byteCount: data.count, createdAt: clock(), state: .queued, attemptCount: 0, revision: 0)
    let record = AttachmentUploadRecord(upload: upload)
    let originalKey = AttachmentUploadRecord.originalKey(id)
    let original = WorkspaceStoredValue(
      key: originalKey, data: data, updatedAt: clock(), retention: .durable)
    return try commit(record, original: original, creating: true)
  }

  @discardableResult
  public func cancel(_ id: UUID, expectedRevision: Int64) throws -> AttachmentUpload {
    var record = try require(id)
    guard record.upload.revision == expectedRevision else {
      throw WorkspaceRepositoryError.concurrentWrite
    }
    guard record.upload.attemptCount == 0, record.upload.state.unresolved else {
      throw AttachmentUploadError.cannotCancelAttemptedUpload
    }
    let original = try requireOriginal(record)
    record.upload.state = .cancelled
    record.upload.reviewReason = nil
    return try commit(record, original: original)
  }

  func require(_ id: UUID) throws -> AttachmentUploadRecord {
    guard let value = try store.value(AttachmentUploadRecord.key(id)) else {
      throw AttachmentUploadError.missingUpload
    }
    return try AttachmentUploadRecord.decode(value, scope: scope)
  }

  func requireOriginal(_ record: AttachmentUploadRecord) throws -> WorkspaceStoredValue {
    let original = try store.value(AttachmentUploadRecord.originalKey(record.upload.id))
    try record.validateOriginal(original)
    guard let original else { throw AttachmentUploadError.missingOriginal }
    return original
  }

  @discardableResult
  func commit(
    _ record: AttachmentUploadRecord, original: WorkspaceStoredValue, creating: Bool = false,
    preparingAttempt: Bool = false
  ) throws -> AttachmentUpload {
    let key = AttachmentUploadRecord.key(record.upload.id)
    let metadata = WorkspaceStoredValue(
      key: key, data: try JSONEncoder().encode(record), updatedAt: clock(), retention: .durable)
    var bytes = original
    bytes.retention = record.upload.state.unresolved ? .durable : .disposable
    let changes = [
      WorkspaceValueMutation(
        key: key, value: metadata, expectedRevision: creating ? nil : record.upload.revision,
        requiresIdleNoteWrites: preparingAttempt, requiresIdleCaptureWrites: preparingAttempt,
        requiresNoStructuralChange: creating),
      WorkspaceValueMutation(
        key: bytes.key, value: bytes, expectedRevision: creating ? nil : original.revision),
    ]
    let revisions = try store.commitValues(changes)
    guard let revision = revisions[key] else { throw WorkspaceRepositoryError.corruptIndex }
    var result = record.upload
    result.revision = revision
    return result
  }
}
