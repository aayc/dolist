import Foundation
import SQLite3

extension SQLiteWorkspaceIndex: WorkspaceMaintenanceStore {
  public func prepareStructural(_ proposed: WorkspaceStructuralOperation) throws
    -> WorkspaceStructuralOperation
  {
    try locked {
      try transaction {
        try proposed.action.validate()
        let scope: WorkspaceScope? = try read("metadata", keyColumn: "key", key: "scope")
        guard scope == proposed.scope else { throw WorkspaceRepositoryError.workspaceMismatch }
        if try hasStructuralBarrier() {
          throw WorkspaceRepositoryError.pendingStructuralChange
        }
        let pendingCapture = try statement(
          "SELECT 1 FROM workspace_values WHERE blocks_note_writes=1 LIMIT 1"
        ) {
          switch sqlite3_step($0) {
          case SQLITE_ROW: return true
          case SQLITE_DONE: return false
          default: throw failure()
          }
        }
        guard !pendingCapture else { throw WorkspaceRepositoryError.pendingCaptures }
        let documents: [NoteIndexRecord] = try all("documents")
        let affected = documents.filter { proposed.action.affects($0.path) }
        let pending: [NoteOutboxRecord] = try all("outbox")
        guard affected.allSatisfy({ $0.state == .synced }),
          !pending.contains(where: { proposed.action.affects($0.path) })
        else {
          throw WorkspaceMaintenanceError.dirtyAffectedNotes
        }
        try validateDestination(proposed.action, documents: documents)
        var operation = proposed
        operation.state = .attempting
        operation.cachedNotes = affected
        operation.revision = 1
        let key = "structural/" + operation.id.uuidString
        let old: WorkspaceStoredValue? = try read("workspace_values", keyColumn: "key", key: key)
        guard old == nil else { throw WorkspaceRepositoryError.concurrentWrite }
        try storeOperation(operation)
        return operation
      }
    }
  }

  public func resolveStructural(_ id: UUID, revision: Int64, resolution: StructuralResolution?)
    throws -> WorkspaceStructuralOperation
  {
    try locked {
      try transaction {
        guard
          let value: WorkspaceStoredValue = try read(
            "workspace_values", keyColumn: "key", key: "structural/" + id.uuidString),
          let scope: WorkspaceScope = try read("metadata", keyColumn: "key", key: "scope")
        else { throw WorkspaceMaintenanceError.missingOperation }
        var operation = try WorkspaceStructuralCoordinator.decode(value, scope: scope)
        guard operation.revision == revision else { throw WorkspaceRepositoryError.concurrentWrite }
        guard operation.state.unresolved else {
          throw WorkspaceMaintenanceError.operationAlreadyResolved
        }
        guard revision < Int64.max else { throw WorkspaceRepositoryError.corruptIndex }
        if let resolution {
          switch resolution {
          case .applied:
            let latest: [NoteIndexRecord] = try all("documents")
            operation.cachedNotes.append(
              contentsOf: latest.filter {
                operation.action.affects($0.path) && !$0.recoveryCopies.isEmpty
              })
            try applyStructural(operation.action)
            operation.state = .applied
          case .notApplied: operation.state = .notApplied
          }
        } else {
          operation.state = .needsReview
        }
        operation.revision += 1
        if !operation.state.unresolved {
          operation.cachedNotes.removeAll { $0.recoveryCopies.isEmpty }
        }
        try storeOperation(operation)
        return operation
      }
    }
  }

  public func recoverySnapshot() throws -> WorkspaceRecoverySnapshot {
    try locked { try transaction { try snapshotForRecovery() } }
  }

  public func discardLocalNote(path: String, expectedRevision: Int64) throws {
    try WorkspaceRepository.validatePath(path)
    try locked {
      try transaction {
        guard let record: NoteIndexRecord = try read("documents", key: path) else {
          throw WorkspaceRepositoryError.missingDocument
        }
        guard record.revision == expectedRevision else {
          throw WorkspaceRepositoryError.staleRevision(
            expected: expectedRevision, actual: record.revision)
        }
        let pending: NoteOutboxRecord? = try read("outbox", key: path)
        guard pending?.attempt == nil else { throw WorkspaceRepositoryError.pendingNoteWrites }
        try put("documents", key: path, value: nil as NoteIndexRecord?)
        try put("outbox", key: path, value: nil as NoteOutboxRecord?)
      }
    }
  }

  public func forget(discardUnsyncedWork: Bool) throws {
    try locked {
      try transaction {
        let snapshot = try snapshotForRecovery()
        guard discardUnsyncedWork || !WorkspaceRecoverySummary(snapshot: snapshot).requiresDecision
        else {
          throw WorkspaceMaintenanceError.unsyncedWork
        }
        // Retiring the namespace fences other open SQLite handles as well as future opens.
        // The connection owner may remove its Keychain/profile only after this commits.
        try put("metadata", keyColumn: "key", key: "forgotten", value: true)
        try execute("DELETE FROM outbox")
        try execute("DELETE FROM documents")
        try execute("DELETE FROM workspace_values")
      }
    }
  }

  func transaction<Value>(_ action: () throws -> Value) throws -> Value {
    try beginTransaction()
    do {
      let result = try action()
      try execute("COMMIT")
      return result
    } catch {
      try? execute("ROLLBACK")
      throw error
    }
  }

  private func storeOperation(_ operation: WorkspaceStructuralOperation) throws {
    let key = "structural/" + operation.id.uuidString
    var value = WorkspaceStoredValue(
      key: key, revision: operation.revision,
      data: try JSONEncoder().encode(operation), updatedAt: operation.startedAt, retention: .durable
    )
    value.blocksNoteWrites = operation.state.unresolved
    try writeStoredValue(value, key: key)
  }

  private func applyStructural(_ action: WorkspaceStructuralAction) throws {
    let documents: [NoteIndexRecord] = try all("documents")
    try validateDestination(action, documents: documents)
    for var record in documents where action.affects(record.path) {
      let oldPath = record.path
      let pending: NoteOutboxRecord? = try read("outbox", key: oldPath)
      guard pending?.attempt == nil else { throw WorkspaceRepositoryError.pendingNoteWrites }
      if let destination = action.remappedPath(oldPath) {
        record.path = destination
        record.generation = 1
        try put("documents", key: oldPath, value: nil as NoteIndexRecord?)
        try put("outbox", key: oldPath, value: nil as NoteOutboxRecord?)
        try put("documents", key: destination, value: record)
        try put(
          "outbox", key: destination,
          value: pending.map { _ in NoteOutboxRecord(path: destination) })
      } else if record.state != .synced {
        guard record.generation < Int64.max else { throw WorkspaceRepositoryError.corruptIndex }
        record.generation += 1
        record.state = .recoveryDraft
        record.reviewReason = .remoteDeleted
        try put("documents", key: oldPath, value: record)
        try put("outbox", key: oldPath, value: nil as NoteOutboxRecord?)
      } else {
        try put("documents", key: oldPath, value: nil as NoteIndexRecord?)
        try put("outbox", key: oldPath, value: nil as NoteOutboxRecord?)
      }
    }
    // Path-bearing snapshots must be freshly fetched after either structural operation.
    try execute(
      "DELETE FROM workspace_values WHERE retention='disposable' AND key!='cache/settings'")
  }

  private func validateDestination(
    _ action: WorkspaceStructuralAction, documents: [NoteIndexRecord]
  ) throws {
    guard let destination = action.destination else { return }
    func key(_ path: String) -> String {
      path.precomposedStringWithCanonicalMapping.folding(
        options: .caseInsensitive, locale: Locale(identifier: "en_US_POSIX"))
    }
    let affected = documents.filter { action.affects($0.path) }
    let unaffected = documents.filter { !action.affects($0.path) }.map { key($0.path) }
    let targets = affected.compactMap { action.remappedPath($0.path) }.map(key)
    guard Set(targets).count == targets.count else {
      throw WorkspaceMaintenanceError.destinationCollision
    }
    let root = key(destination)
    for path in unaffected {
      if path == root || root.hasPrefix(path + "/") || path.hasPrefix(root + "/") {
        throw WorkspaceMaintenanceError.destinationCollision
      }
      if targets.contains(where: {
        $0 == path || $0.hasPrefix(path + "/") || path.hasPrefix($0 + "/")
      }) {
        throw WorkspaceMaintenanceError.destinationCollision
      }
    }
  }

  private func snapshotForRecovery() throws -> WorkspaceRecoverySnapshot {
    let values: [WorkspaceStoredValue] = try statement(
      """
      SELECT body FROM workspace_values WHERE retention='durable' AND key!='notifications'
        AND (instr(key, 'capture/')!=1 OR blocks_note_writes=1) ORDER BY key
      """
    ) { statement in
      var values: [WorkspaceStoredValue] = []
      while true {
        switch sqlite3_step(statement) {
        case SQLITE_ROW: values.append(try decode(statement))
        case SQLITE_DONE: return values
        default: throw failure()
        }
      }
    }
    return try WorkspaceRecoverySnapshot(
      documents: all("documents"), pendingWrites: all("outbox"), values: values)
  }
}
