import DailyDoListModels
import Foundation

extension WorkspaceContentCache {
  public func beginAttachmentFetch(_ path: String) throws -> ContentFetchTicket {
    try begin(.attachment(path: path))
  }

  @discardableResult
  public func storeAttachment(_ payload: VaultFilePayload, fetch ticket: ContentFetchTicket) throws
    -> CachedContentMetadata
  {
    guard ticket.scope == scope, ticket.resource == .attachment(path: payload.metadata.path),
      payload.metadata.size == payload.data.count, !payload.metadata.version.isEmpty,
      payload.metadata.version.utf8.count <= 256,
      !payload.metadata.mimeType.isEmpty, payload.metadata.mimeType.utf8.count <= 256,
      !payload.metadata.mimeType.unicodeScalars.contains(where: {
        CharacterSet.controlCharacters.contains($0)
      })
    else { throw WorkspaceContentCacheError.invalidContent }
    return try store.commitContent(
      payload.data, descriptor: JSONEncoder().encode(payload.metadata), ticket: ticket,
      at: clock(), limits: limits)
  }

  public func attachment(_ path: String) throws -> VaultFilePayload? {
    let resource = CachedContentResource.attachment(path: path)
    try resource.validate()
    guard let stored = try store.readContent(resource, maxBytes: limits.artifactBytes, at: clock())
    else { return nil }
    let metadata: VaultFileMetadata
    do {
      metadata = try JSONDecoder().decode(VaultFileMetadata.self, from: stored.descriptor)
    } catch { throw WorkspaceContentCacheError.corruptContent }
    guard metadata.path == path, metadata.size == stored.data.count else {
      throw WorkspaceContentCacheError.corruptContent
    }
    return VaultFilePayload(data: stored.data, metadata: metadata)
  }
}
