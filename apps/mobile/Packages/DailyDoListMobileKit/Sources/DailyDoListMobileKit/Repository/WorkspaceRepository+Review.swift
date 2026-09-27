import Foundation

public struct NoteReviewSnapshot: Sendable {
  public let note: LocalNote
  public let hostContent: String?
}

extension WorkspaceRepository {
  public func review(_ path: String) throws -> NoteReviewSnapshot? {
    try Self.validatePath(path)
    guard let record = try index.document(path) else { return nil }
    return try NoteReviewSnapshot(
      note: snapshot(record), hostContent: record.base.map(checkpoints.read))
  }
}
