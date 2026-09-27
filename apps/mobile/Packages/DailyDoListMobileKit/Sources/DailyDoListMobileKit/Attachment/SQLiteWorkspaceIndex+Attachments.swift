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
