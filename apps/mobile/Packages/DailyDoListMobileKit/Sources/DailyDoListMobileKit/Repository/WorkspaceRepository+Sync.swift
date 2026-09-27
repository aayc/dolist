import DailyDoListDomain
import Foundation

extension WorkspaceRepository {
  /// Serializes all replay on this repository. Transient/authorization errors leave the exact
  /// durable attempt intact. A later foreground pass reconciles it before any new write.
  @discardableResult
  public func synchronize(with remote: any WorkspaceRemote) async throws -> [LocalNote] {
    guard !synchronizing else { return [] }
    synchronizing = true
    defer { synchronizing = false }
    let generation = connectionGeneration
    try await verify(remote, generation: generation)
    var changed: [LocalNote] = []
    let pendingWrites = try index.outbox().filter { !WorkspaceDocumentPath.isDrawing($0.path) }
      .sorted {
        if ($0.attempt != nil) != ($1.attempt != nil) { return $0.attempt != nil }
        return $0.path < $1.path
      }
    for pending in pendingWrites {
      do {
        try await reconcile(path: pending.path, remote: remote, generation: generation)
      } catch WorkspaceRepositoryError.pendingCaptures {
        // A capture waits for earlier attempted writes. A blocked new note must not prevent
        // another document's immutable attempt from resolving and releasing that dependency.
      } catch WorkspaceRepositoryError.pendingAttachmentDependencies {
        // Pending imported files must be acknowledged before sending the containing embed.
      } catch WorkspaceRepositoryError.pendingDrawingDependencies {
        // New embeds wait for their drawing's acknowledged create, across restart as well.
      } catch WorkspaceRepositoryError.pendingStructuralChange {
        // Local text stays durable while an online rename/delete awaits acknowledgement.
      }
      if let note = try note(pending.path) { changed.append(note) }
    }
    return changed
  }

  /// Refreshes a cached read without writing it back. Deleted clean entries disappear; a dirty
  /// deleted document becomes a recovery draft. Concurrent replay owns its own refresh.
  public func refresh(path: String, with remote: any WorkspaceRemote) async throws -> LocalNote? {
    try Self.validatePath(path)
    guard !synchronizing else { return try note(path) }
    synchronizing = true
    defer { synchronizing = false }
    let generation = connectionGeneration
    try await verify(remote, generation: generation)
    let received = try await remote.readNote(path)
    try checkConnection(generation)
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    if let received { return try cache(received, path: path) }
    guard var existing = try index.document(path) else { return nil }
    if existing.state == .synced && existing.recoveryCopies.isEmpty {
      try index.commit(
        path: path, document: nil, pending: nil, expectedGeneration: existing.generation)
      return nil
    }
    if existing.baseVersion != nil {
      try review(&existing, remote: nil, reason: .remoteDeleted)
    }
    return try snapshot(existing)
  }

  private func verify(_ remote: any WorkspaceRemote, generation: UInt64) async throws {
    guard remote.profileID == scope.profileID, remote.origin == scope.origin else {
      throw WorkspaceRepositoryError.workspaceMismatch
    }
    let identity = try await remote.identity()
    try checkConnection(generation)
    guard identity.workspaceID == scope.workspaceID else {
      throw WorkspaceRepositoryError.workspaceMismatch
    }
    guard identity.hostID == scope.hostID else { throw WorkspaceRepositoryError.hostMismatch }
    guard identity.supportsConditionalWorkspaceWrites else {
      throw WorkspaceRepositoryError.unsupportedHost
    }
  }

  private func reconcile(path: String, remote: any WorkspaceRemote, generation: UInt64) async throws
  {
    // Bounded contention/typing: remaining edits stay queued for the next foreground pass.
    for _ in 0..<3 {
      try checkConnection(generation)
      guard try index.pending(path) != nil else { return }
      let currentRemote = try await remote.readNote(path)
      try checkConnection(generation)
      var access = try checkpoints.beginAccess()
      defer { access?.release() }
      var record = try requireDocument(path)
      guard let pending = try index.pending(path), record.state == .waitingToSync else { return }

      if let attempt = pending.attempt {
        if let currentRemote,
          try checkpoints.put(currentRemote.content) == attempt.checkpoint
        {
          try acknowledge(path: path, attempt: attempt, remote: currentRemote)
          continue
        }
        // An earlier write may have succeeded and then been changed by someone else. Replaying
        // the old diff can duplicate tasks. Preserve both sides and ask for review instead.
        if currentRemote?.version != attempt.baseVersion {
          try review(
            &record, remote: currentRemote,
            reason: currentRemote == nil ? .remoteDeleted : .uncertainWrite)
          return
        }
      } else {
        guard let currentRemote else {
          if record.baseVersion != nil {
            try review(&record, remote: nil, reason: .remoteDeleted)
            return
          }
          access?.release()
          access = nil
          try await transmit(path: path, remote: remote, generation: generation)
          continue
        }
        guard let base = record.base else {
          try review(&record, remote: currentRemote, reason: .pathCollision)
          return
        }
        let merge = TextMerge.merge(
          base: try checkpoints.read(base),
          local: try checkpoints.read(record.working), remote: currentRemote.content)
        let merged = try checkpoints.put(merge.text)
        if merged != record.working {
          record.working = merged
          record.revision = try nextRevision(record.revision)
        }
        record.base = try checkpoints.put(currentRemote.content)
        record.baseVersion = currentRemote.version
        if merge.conflict {
          try review(&record, remote: currentRemote, reason: .overlappingEdits)
          return
        }
        if record.working == record.base {
          record.state = .synced
          record.acknowledgedRevision = record.revision
          try index.commit(record, pending: nil)
          return
        }
        try index.commit(record, pending: NoteOutboxRecord(path: path))
      }
      access?.release()
      access = nil
      try await transmit(path: path, remote: remote, generation: generation)
    }
  }

  private func transmit(path: String, remote: any WorkspaceRemote, generation: UInt64) async throws
  {
    try checkConnection(generation)
    var access = try checkpoints.beginAccess()
    defer { access?.release() }
    let record = try requireDocument(path)
    let attempt =
      try index.pending(path)?.attempt
      ?? NoteWriteAttempt(
        operationID: UUID(),
        checkpoint: record.working, revision: record.revision, baseVersion: record.baseVersion,
        requiredDrawings: record.requiredDrawings, requiredAttachments: record.requiredAttachments)
    let content = try checkpoints.read(attempt.checkpoint)
    try index.commit(record, pending: NoteOutboxRecord(path: path, attempt: attempt))
    access?.release()
    access = nil
    do {
      let result = try await remote.writeNote(
        path, content: content, baseVersion: attempt.baseVersion,
        workspaceID: scope.workspaceID)
      try checkConnection(generation)
      access = try checkpoints.beginAccess()
      guard try checkpoints.put(result.content) == attempt.checkpoint else {
        var latest = try requireDocument(path)
        try review(&latest, remote: result, reason: .uncertainWrite)
        return
      }
      try acknowledge(path: path, attempt: attempt, remote: result)
    } catch WorkspaceRemoteError.conflict {
      try checkConnection(generation)
      access = try checkpoints.beginAccess()
      // A definite conditional rejection is safe to rebase. Other errors may be lost success.
      let latest = try requireDocument(path)
      try index.commit(latest, pending: NoteOutboxRecord(path: path))
    }
  }

  private func acknowledge(path: String, attempt: NoteWriteAttempt, remote: RemoteNote) throws {
    var latest = try requireDocument(path)
    guard try index.pending(path)?.attempt?.operationID == attempt.operationID else {
      throw WorkspaceRepositoryError.concurrentWrite
    }
    if let acknowledgedDependencies = attempt.requiredDrawings {
      latest.requiredDrawings?.removeAll { acknowledgedDependencies.contains($0) }
      if latest.requiredDrawings?.isEmpty == true { latest.requiredDrawings = nil }
    }
    if let acknowledged = attempt.requiredAttachments {
      latest.requiredAttachments?.removeAll { acknowledged.contains($0) }
      if latest.requiredAttachments?.isEmpty == true { latest.requiredAttachments = nil }
    }
    latest.base = attempt.checkpoint
    latest.baseVersion = remote.version
    latest.acknowledgedRevision = max(latest.acknowledgedRevision, attempt.revision)
    if latest.working == attempt.checkpoint {
      latest.acknowledgedRevision = latest.revision
      latest.state = .synced
    } else {
      latest.state = .waitingToSync
    }
    try index.commit(
      latest,
      pending: latest.state == .synced ? nil : NoteOutboxRecord(path: path))
  }

  private func review(_ record: inout NoteIndexRecord, remote: RemoteNote?, reason: ReviewReason)
    throws
  {
    if let remote {
      let hash = try checkpoints.put(remote.content)
      if !record.recoveryCopies.contains(hash) { record.recoveryCopies.append(hash) }
      record.base = hash
      record.baseVersion = remote.version
    }
    record.state = reason == .remoteDeleted ? .recoveryDraft : .needsReview
    record.reviewReason = reason
    try index.commit(record, pending: nil)
  }

  private func checkConnection(_ generation: UInt64) throws {
    try Task.checkCancellation()
    guard generation == connectionGeneration else {
      throw WorkspaceRepositoryError.connectionChanged
    }
  }
}
