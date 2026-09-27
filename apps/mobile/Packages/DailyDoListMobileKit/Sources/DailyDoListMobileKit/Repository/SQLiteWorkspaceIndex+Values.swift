import Foundation
import SQLite3

extension SQLiteWorkspaceIndex {
  public func value(_ key: String) throws -> WorkspaceStoredValue? {
    try locked { try read("workspace_values", keyColumn: "key", key: key) }
  }

  public func values(prefix: String) throws -> [WorkspaceStoredValue] {
    try locked {
      try statement(
        "SELECT body FROM workspace_values WHERE instr(key, ?)=1 ORDER BY key", key: prefix
      ) { statement in
        var result: [WorkspaceStoredValue] = []
        while true {
          switch sqlite3_step(statement) {
          case SQLITE_ROW: result.append(try decode(statement))
          case SQLITE_DONE: return result
          default: throw failure()
          }
        }
      }
    }
  }

  public func valueSummaries() throws -> [WorkspaceValueSummary] {
    try locked {
      try statement(
        "SELECT key, revision, updated_at, retention, byte_count, blocks_note_writes FROM workspace_values"
      ) { statement in
        var result: [WorkspaceValueSummary] = []
        while true {
          switch sqlite3_step(statement) {
          case SQLITE_ROW:
            guard let key = sqlite3_column_text(statement, 0),
              let raw = sqlite3_column_text(statement, 3),
              let retention = WorkspaceValueRetention(rawValue: String(cString: raw))
            else { throw WorkspaceRepositoryError.corruptIndex }
            result.append(
              WorkspaceValueSummary(
                key: String(cString: key), revision: sqlite3_column_int64(statement, 1),
                updatedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 2)),
                retention: retention,
                byteCount: Int(sqlite3_column_int64(statement, 4)),
                blocksNoteWrites: sqlite3_column_int(statement, 5) != 0))
          case SQLITE_DONE: return result
          default: throw failure()
          }
        }
      }
    }
  }

  @discardableResult
  public func commitValues(_ changes: [WorkspaceValueMutation]) throws -> [String: Int64] {
    try locked {
      guard Set(changes.map(\.key)).count == changes.count else {
        throw WorkspaceRepositoryError.corruptIndex
      }
      try beginTransaction()
      do {
        if changes.contains(where: \.requiresNoStructuralChange), try hasStructuralBarrier() {
          throw WorkspaceRepositoryError.pendingStructuralChange
        }
        if changes.contains(where: \.requiresIdleNoteWrites) {
          guard try !hasStructuralBarrier() else {
            throw WorkspaceRepositoryError.pendingStructuralChange
          }
          try requireIdleAttachmentAttempts()
          let attempts: [NoteOutboxRecord] = try all("outbox")
          guard !attempts.contains(where: { $0.attempt != nil }) else {
            throw WorkspaceRepositoryError.pendingNoteWrites
          }
        }
        if changes.contains(where: \.requiresIdleCaptureWrites) {
          try requireIdleCaptureWrites()
        }
        let importedBytes = changes.compactMap(\.attachmentImportBytes)
        guard importedBytes.count <= 1 else { throw WorkspaceRepositoryError.corruptIndex }
        if let count = importedBytes.first {
          try makeAttachmentOriginalSpace(
            adding: count, maximumBytes: AttachmentUploadRepository.maximumOriginalBytes)
        }
        var revisions: [String: Int64] = [:]
        for change in changes {
          let old: WorkspaceStoredValue? = try read(
            "workspace_values", keyColumn: "key", key: change.key)
          guard old?.revision == change.expectedRevision else {
            throw WorkspaceRepositoryError.concurrentWrite
          }
          guard change.value?.key == change.key || change.value == nil,
            (change.expectedRevision ?? 0) < Int64.max
          else { throw WorkspaceRepositoryError.corruptIndex }
          var next = change.value
          let last = try lastValueRevision(change.key)
          guard last < Int64.max else { throw WorkspaceRepositoryError.corruptIndex }
          next?.revision = last + 1
          if let next { revisions[change.key] = next.revision }
          try writeStoredValue(next, key: change.key)
        }
        try execute("COMMIT")
        return revisions
      } catch {
        try? execute("ROLLBACK")
        throw error
      }
    }
  }

}
