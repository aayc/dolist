import Foundation

public struct CachedDocumentMetadata: Sendable {
  public let path: String
  public let state: NoteSyncState
}

extension WorkspaceRepository {
  /// Quick navigation needs path/state metadata, never every downloaded document's text.
  public func cachedDocumentMetadata() throws -> [CachedDocumentMetadata] {
    try index.documents().map { CachedDocumentMetadata(path: $0.path, state: $0.state) }
  }
}
