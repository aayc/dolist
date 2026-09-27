import Foundation

struct StorageReferenceGraph {
  var references: Set<String> = []
  var protectedReferences: Set<String> = []
  var protections: [String: Set<CachedDocumentProtection>] = [:]
  var unsupportedProtectedRecords = 0

  init(snapshot: WorkspaceStorageSnapshot, scope: WorkspaceScope, activePaths: Set<String>) throws {
    let agentKeys = RecoveryAgentMutations(values: snapshot.values, scope: scope).recognizedKeys
    let attachmentKeys = RecoveryAttachmentUploads(values: snapshot.values, scope: scope)
      .recognizedKeys
    let pendingPaths = Set(snapshot.pending.map(\.path))
    let dependencies = Set(snapshot.documents.flatMap { $0.requiredDrawings ?? [] })
      .union(snapshot.pending.flatMap { $0.attempt?.requiredDrawings ?? [] })
    for document in snapshot.documents {
      var reasons: Set<CachedDocumentProtection> = []
      if document.state != .synced || document.revision != document.acknowledgedRevision
        || document.base == nil || document.baseVersion == nil
      {
        reasons.insert(.unsynced)
      }
      if !document.recoveryCopies.isEmpty || document.reviewReason != nil {
        reasons.insert(.recovery)
      }
      if pendingPaths.contains(document.path) { reasons.insert(.pendingWrite) }
      if !(document.requiredAttachments ?? []).isEmpty { reasons.insert(.attachmentDependency) }
      if dependencies.contains(document.path) || !(document.requiredDrawings ?? []).isEmpty {
        reasons.insert(.drawingDependency)
      }
      let owned = Self.references(document)
      references.formUnion(owned)
      if !reasons.isEmpty { protectedReferences.formUnion(owned) }
      if snapshot.selections.contains(where: { $0.contains(document.path) }) {
        reasons.insert(.pinned)
      }
      if activePaths.contains(document.path) { reasons.insert(.activeEditor) }
      protections[document.path] = reasons
    }
    for attempt in snapshot.pending.compactMap(\.attempt) {
      references.insert(attempt.checkpoint)
      protectedReferences.insert(attempt.checkpoint)
    }
    for value in snapshot.values where value.retention == .durable {
      if value.key.hasPrefix("structural/") {
        let operation = try WorkspaceStructuralCoordinator.decode(value, scope: scope)
        for document in operation.cachedNotes {
          let owned = Self.references(document)
          references.formUnion(owned)
          protectedReferences.formUnion(owned)
          protections[document.path, default: []].insert(.structuralOperation)
        }
        if operation.state.unresolved {
          for document in snapshot.documents where operation.action.affects(document.path) {
            protections[document.path, default: []].insert(.structuralOperation)
            protectedReferences.formUnion(Self.references(document))
          }
        }
      } else if value.key.hasPrefix("composer/") {
        _ = try JSONDecoder().decode(String.self, from: value.data)
      } else if value.key.hasPrefix("capture/") {
        _ = try JSONDecoder().decode(QueuedCapture.self, from: value.data)
      } else if attachmentKeys.contains(value.key) {
        // Exact original bytes are inline SQLite data, independent of markdown checkpoint GC.
      } else if agentKeys.contains(value.key) {
        // Validated version 1 commands and their matching exclusion slots contain inline JSON.
      } else if value.key == "notifications" {
        _ = try JSONDecoder().decode(NotificationCache.self, from: value.data)
      } else {
        unsupportedProtectedRecords += 1
      }
    }
    guard
      references.allSatisfy({ reference in
        reference.utf8.count == 64
          && reference.utf8.allSatisfy {
            (48...57).contains($0) || (97...102).contains($0)
          }
      })
    else { throw WorkspaceRepositoryError.corruptCheckpoint }
  }

  static func references(_ document: NoteIndexRecord) -> Set<String> {
    Set([document.working] + (document.base.map { [$0] } ?? []) + document.recoveryCopies)
  }
}
