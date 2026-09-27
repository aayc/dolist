import DailyDoListDrawingModel
import Foundation

extension DrawingRepository {
  @discardableResult
  public func synchronize(with remote: any WorkspaceRemote) async throws -> [LocalDrawing] {
    guard !synchronizing else { return [] }
    synchronizing = true
    defer { synchronizing = false }
    let current = generation
    try await verify(remote, generation: current)
    let pending = try index.outbox().filter { WorkspaceDocumentPath.isDrawing($0.path) }.sorted {
      if ($0.attempt != nil) != ($1.attempt != nil) { return $0.attempt != nil }
      return $0.path < $1.path
    }
    var result: [LocalDrawing] = []
    for item in pending {
      do {
        try await reconcile(item.path, remote: remote, generation: current)
      } catch WorkspaceRepositoryError.pendingCaptures {} catch WorkspaceRepositoryError
        .pendingStructuralChange
      {}
      if let latest = try drawing(item.path) { result.append(latest) }
    }
    return result
  }

  /// Read-only refresh merges into local scene edits but does not send them from this call.
  public func refresh(path: String, with remote: any WorkspaceRemote) async throws -> LocalDrawing?
  {
    try Self.validatePath(path)
    guard !synchronizing else { return try drawing(path) }
    synchronizing = true
    defer { synchronizing = false }
    let current = generation
    try await verify(remote, generation: current)
    let received = try await remote.readNote(path)
    try check(current)
    if let prior = try index.document(path), prior.state != .synced {
      if try index.pending(path)?.attempt != nil { return try snapshot(prior) }
      if prior.state == .waitingToSync {
        try merge(prior, remote: received)
        return try drawing(path)
      }
      if prior.reviewReason != .invalidDrawing || prior.revision != prior.acknowledgedRevision {
        return try snapshot(prior)
      }
    }
    if let received { return try cache(received, path: path) }
    guard var prior = try index.document(path) else { return nil }
    if prior.recoveryCopies.isEmpty && prior.state == .synced {
      try index.commit(
        path: path, document: nil, pending: nil, expectedGeneration: prior.generation)
      return nil
    }
    try review(&prior, remote: nil, reason: .remoteDeleted)
    return try snapshot(prior)
  }

  private func reconcile(_ path: String, remote: any WorkspaceRemote, generation: UInt64)
    async throws
  {
    for _ in 0..<3 {
      try check(generation)
      guard try index.pending(path) != nil else { return }
      let received = try await remote.readNote(path)
      try check(generation)
      var record = try require(path)
      guard let pending = try index.pending(path), record.state == .waitingToSync else { return }
      if let attempt = pending.attempt {
        if let received, try checkpoints.put(received.content) == attempt.checkpoint {
          try acknowledge(path, attempt: attempt, remote: received)
          continue
        }
        if received?.version != attempt.baseVersion {
          try review(
            &record, remote: received, reason: received == nil ? .remoteDeleted : .uncertainWrite)
          return
        }
      } else {
        try merge(record, remote: received)
        guard try index.pending(path) != nil else { return }
      }
      try await transmit(path, remote: remote, generation: generation)
    }
  }

  private func merge(_ original: NoteIndexRecord, remote: RemoteNote?) throws {
    var record = original
    guard let remote else {
      if record.baseVersion != nil { try review(&record, remote: nil, reason: .remoteDeleted) }
      return
    }
    guard let base = record.base else {
      try review(&record, remote: remote, reason: .pathCollision)
      return
    }
    let localDocument = ExcalidrawMarkdown.parse(try checkpoints.read(record.working))
    let baseDocument = ExcalidrawMarkdown.parse(try checkpoints.read(base))
    let remoteDocument = ExcalidrawMarkdown.parse(remote.content)
    guard DrawingValidation.error(localDocument) == nil,
      DrawingValidation.error(baseDocument) == nil,
      DrawingValidation.error(remoteDocument) == nil
    else {
      try review(&record, remote: remote, reason: .invalidDrawing)
      return
    }
    let scene = SceneMerge.merge(
      base: baseDocument.scene, local: localDocument.scene, remote: remoteDocument.scene)
    let content = try ExcalidrawMarkdown.serialize(scene, previous: remoteDocument)
    let hash = try checkpoints.put(content)
    if hash != record.working {
      record.working = hash
      record.revision = try nextRevision(record.revision)
    }
    let remoteHash = try checkpoints.put(remote.content)
    record.base = remoteHash
    record.baseVersion = remote.version
    // Prefer the exact remote bytes when the merged file has no scene/file changes. This
    // avoids reformatting a compressed or differently spaced file without any local work.
    let canonicalRemote = try ExcalidrawMarkdown.serialize(
      remoteDocument.scene, previous: remoteDocument)
    if content.utf8.elementsEqual(canonicalRemote.utf8) {
      record.working = remoteHash
      record.state = .synced
      record.acknowledgedRevision = record.revision
    }
    try index.commit(
      record, pending: record.state == .synced ? nil : NoteOutboxRecord(path: record.path))
  }

  private func transmit(_ path: String, remote: any WorkspaceRemote, generation: UInt64)
    async throws
  {
    try check(generation)
    let record = try require(path)
    let attempt =
      try index.pending(path)?.attempt
      ?? NoteWriteAttempt(
        operationID: UUID(), checkpoint: record.working,
        revision: record.revision, baseVersion: record.baseVersion)
    let content = try checkpoints.read(attempt.checkpoint)
    if let error = DrawingValidation.error(ExcalidrawMarkdown.parse(content)) { throw error }
    try index.commit(record, pending: NoteOutboxRecord(path: path, attempt: attempt))
    do {
      let received = try await remote.writeNote(
        path, content: content, baseVersion: attempt.baseVersion, workspaceID: scope.workspaceID)
      try check(generation)
      if try checkpoints.put(received.content) == attempt.checkpoint {
        try acknowledge(path, attempt: attempt, remote: received)
      } else {
        var latest = try require(path)
        try review(&latest, remote: received, reason: .uncertainWrite)
      }
    } catch WorkspaceRemoteError.conflict {
      try check(generation)
      try index.commit(require(path), pending: NoteOutboxRecord(path: path))
    }
  }

  private func acknowledge(_ path: String, attempt: NoteWriteAttempt, remote: RemoteNote) throws {
    var record = try require(path)
    guard try index.pending(path)?.attempt?.operationID == attempt.operationID else {
      throw WorkspaceRepositoryError.concurrentWrite
    }
    record.base = attempt.checkpoint
    record.baseVersion = remote.version
    record.acknowledgedRevision = max(record.acknowledgedRevision, attempt.revision)
    record.state = record.working == attempt.checkpoint ? .synced : .waitingToSync
    if record.state == .synced { record.acknowledgedRevision = record.revision }
    try index.commit(record, pending: record.state == .synced ? nil : NoteOutboxRecord(path: path))
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

  private func verify(_ remote: any WorkspaceRemote, generation: UInt64) async throws {
    guard remote.profileID == scope.profileID, remote.origin == scope.origin else {
      throw WorkspaceRepositoryError.workspaceMismatch
    }
    let identity = try await remote.identity()
    try check(generation)
    guard identity.workspaceID == scope.workspaceID else {
      throw WorkspaceRepositoryError.workspaceMismatch
    }
    guard identity.hostID == scope.hostID else { throw WorkspaceRepositoryError.hostMismatch }
    guard identity.supportsConditionalWorkspaceWrites else {
      throw WorkspaceRepositoryError.unsupportedHost
    }
  }

  private func check(_ value: UInt64) throws {
    try Task.checkCancellation()
    guard value == generation else { throw WorkspaceRepositoryError.connectionChanged }
  }
}
