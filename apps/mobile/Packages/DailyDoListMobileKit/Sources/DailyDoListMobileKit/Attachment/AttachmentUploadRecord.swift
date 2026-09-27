import DailyDoListModels
import Foundation

/// Both rows commit atomically. Originals remain durable until acknowledged or explicitly
/// cancelled; completed metadata remains so a late note can prove its dependency was uploaded.
struct AttachmentUploadRecord: Codable {
  var version = 1
  var upload: AttachmentUpload

  static func key(_ id: UUID) -> String { "attachment-upload/" + id.uuidString }
  static func originalKey(_ id: UUID) -> String { "attachment-original/" + id.uuidString }

  static func decode(_ stored: WorkspaceStoredValue, scope: WorkspaceScope) throws -> Self {
    guard var record = try? JSONDecoder().decode(Self.self, from: stored.data),
      record.version == 1, record.upload.scope == scope,
      stored.key == key(record.upload.id), stored.retention == .durable, !stored.blocksNoteWrites,
      stored.revision > 0, record.upload.byteCount >= 0,
      record.upload.byteCount <= DaemonProtocol.attachmentMaxBytes,
      record.upload.attemptCount >= 0,
      (try? record.upload.dependency.validate()) != nil
    else { throw AttachmentUploadError.corruptRecord }
    switch record.upload.state {
    case .queued, .cancelled:
      guard record.upload.attemptCount == 0, record.upload.receipt == nil else {
        throw AttachmentUploadError.corruptRecord
      }
    case .attempting:
      guard record.upload.attemptCount > 0, record.upload.receipt == nil else {
        throw AttachmentUploadError.corruptRecord
      }
    case .acknowledged:
      guard let receipt = record.upload.receipt, receipt.path == record.upload.path,
        receipt.size == record.upload.byteCount, !receipt.version.isEmpty
      else { throw AttachmentUploadError.corruptRecord }
    case .needsReview:
      guard record.upload.reviewReason != nil, record.upload.receipt == nil else {
        throw AttachmentUploadError.corruptRecord
      }
    }
    record.upload.revision = stored.revision
    return record
  }

  func validateOriginal(_ original: WorkspaceStoredValue?) throws {
    guard let original else {
      guard !upload.state.unresolved else { throw AttachmentUploadError.missingOriginal }
      return
    }
    guard original.key == Self.originalKey(upload.id), original.revision > 0,
      !original.blocksNoteWrites,
      original.data.count == upload.byteCount,
      MarkdownCheckpointStore.digest(original.data) == upload.sha256,
      original.retention == (upload.state.unresolved ? .durable : .disposable)
    else { throw AttachmentUploadError.corruptRecord }
  }
}

struct RecoveryAttachmentUploads {
  var uploads: [AttachmentUpload] = []
  var originals: [UUID: Data] = [:]
  var recognizedKeys: Set<String> = []

  init(values: [WorkspaceStoredValue], scope: WorkspaceScope) {
    let rows = Dictionary(uniqueKeysWithValues: values.map { ($0.key, $0) })
    for value in values where value.key.hasPrefix("attachment-upload/") {
      guard let record = try? AttachmentUploadRecord.decode(value, scope: scope) else { continue }
      let key = AttachmentUploadRecord.originalKey(record.upload.id)
      let original = rows[key]
      guard (try? record.validateOriginal(original)) != nil else { continue }
      recognizedKeys.insert(value.key)
      if original != nil { recognizedKeys.insert(key) }
      if record.upload.state.unresolved {
        uploads.append(record.upload)
        originals[record.upload.id] = original?.data
      }
    }
    uploads.sort { $0.id.uuidString < $1.id.uuidString }
  }
}
