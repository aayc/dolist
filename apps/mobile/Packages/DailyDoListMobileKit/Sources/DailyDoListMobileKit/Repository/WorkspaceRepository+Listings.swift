import Foundation

public struct CachedDocumentMetadata: Sendable {
  public let path: String
  public let state: NoteSyncState
  public let baseVersion: String?
  public let localRevision: Int64
  public let acknowledgedRevision: Int64
  /// The split `notes()` and `DrawingRepository.drawings()` use.
  public var isDrawing: Bool { WorkspaceDocumentPath.isDrawing(path) }

  init(_ record: NoteIndexRecord) {
    path = record.path
    state = record.state
    baseVersion = record.baseVersion
    localRevision = record.revision
    acknowledgedRevision = record.acknowledgedRevision
  }
}

extension WorkspaceRepository {
  /// Quick navigation needs path/state metadata, never every downloaded document's text.
  public func cachedDocumentMetadata() throws -> [CachedDocumentMetadata] {
    try index.documents().map(CachedDocumentMetadata.init)
  }
}
