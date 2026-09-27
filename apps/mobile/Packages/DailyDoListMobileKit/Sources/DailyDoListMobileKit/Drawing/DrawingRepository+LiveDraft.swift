import DailyDoListDrawingModel

extension DrawingRepository {
  /// A malformed remote file can arrive while a touch gesture has not committed yet. Preserve
  /// both its exact bytes and the valid live scene without authorizing an overwrite of the host.
  @discardableResult
  public func preserveLiveDraft(
    path: String, scene: ExcalidrawScene, previous: ExcalidrawMarkdown, expectedRevision: Int64
  ) throws -> LocalDrawing {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    var record = try require(path, revision: expectedRevision)
    guard record.state == .needsReview, record.reviewReason == .invalidDrawing else {
      throw WorkspaceRepositoryError.documentNeedsReview
    }
    let content = try DrawingValidation.serialized(scene, previous: previous)
    if !record.recoveryCopies.contains(record.working) {
      record.recoveryCopies.append(record.working)
    }
    record.working = try checkpoints.put(content)
    record.revision = try nextRevision(record.revision)
    try index.commit(record, pending: nil)
    return try snapshot(record)
  }
}
