import Foundation

public struct DrawingReviewSnapshot: Sendable {
  public let drawing: LocalDrawing
  public let hostContent: String?
}

extension DrawingRepository {
  /// Returns the exact preserved authoritative file alongside local work, without serializing
  /// or normalizing the scene. Choosing a version is a separate explicit recovery action.
  public func review(_ path: String) throws -> DrawingReviewSnapshot? {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    try Self.validatePath(path)
    guard let record = try index.document(path) else { return nil }
    return try DrawingReviewSnapshot(
      drawing: snapshot(record), hostContent: record.base.map(checkpoints.read))
  }
}
