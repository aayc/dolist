import Foundation
import SQLite3

extension SQLiteWorkspaceIndex {
  /// Called only inside the same SQLite transaction which freezes a note/capture/upload write.
  func requireAcknowledgedAttachments(_ dependencies: [AttachmentDependency]) throws {
    guard !dependencies.isEmpty else { return }
    let scope = try attachmentScope()
    for dependency in dependencies {
      try dependency.validate()
      guard
        let value: WorkspaceStoredValue = try read(
          "workspace_values", keyColumn: "key",
          key: AttachmentUploadRecord.key(dependency.operationID))
      else { throw WorkspaceRepositoryError.pendingAttachmentDependencies }
      let record = try AttachmentUploadRecord.decode(value, scope: scope)
      guard record.upload.dependency == dependency, record.upload.state == .acknowledged else {
        throw WorkspaceRepositoryError.pendingAttachmentDependencies
      }
    }
  }

  func requireIdleAttachmentAttempts() throws {
    guard try !attachmentRecords().contains(where: { $0.upload.state == .attempting }) else {
      throw WorkspaceRepositoryError.pendingAttachmentDependencies
    }
  }

  func requireNoAffectedAttachmentUploads(_ action: WorkspaceStructuralAction) throws {
    guard
      try !attachmentRecords().contains(where: {
        $0.upload.state.unresolved && action.affects($0.upload.path)
      })
    else { throw WorkspaceRepositoryError.pendingAttachmentDependencies }
    let documents: [NoteIndexRecord] = try all("documents")
    guard
      !documents.contains(where: {
        ($0.requiredAttachments ?? []).contains(where: { action.affects($0.path) })
      })
    else { throw WorkspaceRepositoryError.pendingAttachmentDependencies }
  }

  func requireIdleCaptureWrites() throws {
    if try hasStructuralBarrier() { throw WorkspaceRepositoryError.pendingStructuralChange }
    let blocked = try statement("SELECT 1 FROM workspace_values WHERE blocks_note_writes=1 LIMIT 1")
    {
      switch sqlite3_step($0) {
      case SQLITE_ROW: return true
      case SQLITE_DONE: return false
      default: throw failure()
      }
    }
    guard !blocked else { throw WorkspaceRepositoryError.pendingCaptures }
  }

  /// Keep snapshot/export memory bounded without removing unresolved user work. Completed
  /// bytes are disposable, but their acknowledgement metadata remains for late note sends.
  func makeAttachmentOriginalSpace(adding count: Int, maximumBytes: Int) throws {
    guard count >= 0, count <= maximumBytes else {
      throw AttachmentUploadError.storageLimit(maxBytes: maximumBytes)
    }
    let rows: [(key: String, bytes: Int, disposable: Bool)] = try statement(
      "SELECT key, byte_count-length(key), retention FROM workspace_values WHERE instr(key, 'attachment-original/')=1 ORDER BY updated_at, key"
    ) { statement in
      var rows: [(String, Int, Bool)] = []
      while true {
        switch sqlite3_step(statement) {
        case SQLITE_ROW:
          guard let key = sqlite3_column_text(statement, 0),
            let retention = sqlite3_column_text(statement, 2)
          else {
            throw WorkspaceRepositoryError.corruptIndex
          }
          let bytes = sqlite3_column_int64(statement, 1)
          guard bytes >= 0, bytes <= Int.max else { throw WorkspaceRepositoryError.corruptIndex }
          rows.append(
            (String(cString: key), Int(bytes), String(cString: retention) == "disposable"))
        case SQLITE_DONE: return rows
        default: throw failure()
        }
      }
    }
    var retained = 0
    for row in rows {
      let sum = retained.addingReportingOverflow(row.bytes)
      guard !sum.overflow else { throw WorkspaceRepositoryError.corruptIndex }
      retained = sum.partialValue
    }
    var needed = retained - (maximumBytes - count)
    guard needed > 0 else { return }
    let scope = try attachmentScope()
    for row in rows where row.disposable && needed > 0 {
      guard let id = UUID(uuidString: String(row.key.dropFirst("attachment-original/".count))),
        row.key == AttachmentUploadRecord.originalKey(id),
        let metadata: WorkspaceStoredValue = try read(
          "workspace_values", keyColumn: "key", key: AttachmentUploadRecord.key(id)),
        let record = try? AttachmentUploadRecord.decode(metadata, scope: scope),
        !record.upload.state.unresolved, record.upload.byteCount == row.bytes,
        let original: WorkspaceStoredValue = try read(
          "workspace_values", keyColumn: "key", key: row.key),
        (try? record.validateOriginal(original)) != nil
      else { continue }
      try writeStoredValue(nil, key: row.key)
      needed -= row.bytes
    }
    guard needed <= 0 else { throw AttachmentUploadError.storageLimit(maxBytes: maximumBytes) }
  }

  private func attachmentScope() throws -> WorkspaceScope {
    guard let scope: WorkspaceScope = try read("metadata", keyColumn: "key", key: "scope") else {
      throw WorkspaceRepositoryError.corruptIndex
    }
    return scope
  }

  private func attachmentRecords() throws -> [AttachmentUploadRecord] {
    let scope = try attachmentScope()
    return try statement(
      "SELECT body FROM workspace_values WHERE instr(key, 'attachment-upload/')=1"
    ) {
      var records: [AttachmentUploadRecord] = []
      while true {
        switch sqlite3_step($0) {
        case SQLITE_ROW: records.append(try AttachmentUploadRecord.decode(decode($0), scope: scope))
        case SQLITE_DONE: return records
        default: throw failure()
        }
      }
    }
  }
}
