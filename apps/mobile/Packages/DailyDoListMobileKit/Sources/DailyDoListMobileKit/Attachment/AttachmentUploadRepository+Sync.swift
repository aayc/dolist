import DailyDoListModels
import Foundation

extension AttachmentUploadRepository {
  /// Already attempted operations reconcile first. A missing attempted path may have been
  /// deleted after success, so it is retained for review rather than blindly created again.
  @discardableResult
  public func synchronize(with remote: any AttachmentUploadRemote) async throws
    -> [AttachmentUpload]
  {
    guard !synchronizing else { return try uploads() }
    synchronizing = true
    defer { synchronizing = false }
    let generation = connectionGeneration
    guard remote.profileID == scope.profileID, remote.origin == scope.origin else {
      throw WorkspaceRepositoryError.workspaceMismatch
    }
    let identity = try await remote.identity()
    try checkConnection(generation)
    guard identity.workspaceID == scope.workspaceID else {
      throw WorkspaceRepositoryError.workspaceMismatch
    }
    guard identity.hostID == scope.hostID else { throw WorkspaceRepositoryError.hostMismatch }
    guard identity.supportsConditionalWorkspaceWrites, identity.supportsAttachmentUploads else {
      throw WorkspaceRepositoryError.unsupportedHost
    }
    let pending = try uploads().filter { $0.state.unresolved }.sorted {
      if ($0.attemptCount > 0) != ($1.attemptCount > 0) { return $0.attemptCount > 0 }
      return $0.path < $1.path
    }
    for upload in pending {
      do {
        try await reconcile(upload.id, remote: remote, generation: generation)
      } catch WorkspaceRepositoryError.pendingCaptures {} catch WorkspaceRepositoryError
        .pendingNoteWrites
      {} catch WorkspaceRepositoryError.pendingStructuralChange {} catch WorkspaceRepositoryError
        .pendingAttachmentDependencies
      {} catch WorkspaceRepositoryError.concurrentWrite {}
    }
    return try uploads()
  }

  private func reconcile(_ id: UUID, remote: any AttachmentUploadRemote, generation: UInt64)
    async throws
  {
    let existing = try await remote.readAttachment(try require(id).upload.path)
    try checkConnection(generation)
    var record = try require(id)
    guard record.upload.state.unresolved else { return }
    let original = try requireOriginal(record)
    if let existing {
      if valid(existing.metadata, for: record.upload), existing.data == original.data {
        record.upload.state = .acknowledged
        record.upload.receipt = existing.metadata
        record.upload.reviewReason = nil
      } else {
        record.upload.state = .needsReview
        record.upload.reviewReason =
          record.upload.attemptCount == 0 ? .pathCollision : .remoteChanged
      }
      try commit(record, original: original)
      return
    }
    guard record.upload.state == .queued, record.upload.attemptCount == 0 else {
      record.upload.state = .needsReview
      record.upload.reviewReason = .uncertainMissing
      try commit(record, original: original)
      return
    }
    record.upload.state = .attempting
    record.upload.attemptCount = 1
    let attempting = try commit(record, original: original, preparingAttempt: true)
    do {
      let response = try await remote.createAttachment(
        attempting.path, data: original.data, workspaceID: scope.workspaceID)
      try checkConnection(generation)
      var latest = try require(id)
      let bytes = try requireOriginal(latest)
      guard latest.upload.state.unresolved else { return }
      if valid(response, for: latest.upload) {
        latest.upload.state = .acknowledged
        latest.upload.receipt = response
        latest.upload.reviewReason = nil
      } else {
        latest.upload.state = .needsReview
        latest.upload.reviewReason = .invalidReceipt
      }
      try commit(latest, original: bytes)
    } catch WorkspaceRemoteError.conflict {
      try checkConnection(generation)
      // The exact create-only request was rejected. Reconciliation reads the current bytes;
      // it never weakens this attempt to an unconditional or version-matching replacement.
      try await reconcile(id, remote: remote, generation: generation)
    }
  }

  private func valid(_ metadata: VaultFileMetadata, for upload: AttachmentUpload) -> Bool {
    metadata.path == upload.path && metadata.size == upload.byteCount && !metadata.version.isEmpty
  }

  private func checkConnection(_ generation: UInt64) throws {
    guard generation == connectionGeneration else {
      throw WorkspaceRepositoryError.connectionChanged
    }
  }
}
