import DailyDoListModels
import Foundation

/// Authenticated server snapshots only. Unsynced work and upload dependencies belong to their
/// durable repositories, never this evictable cache. Hydration never sends a read signal/action.
public actor WorkspaceContentCache {
  public nonisolated let scope: WorkspaceScope
  public let limits: ContentCacheLimits
  let store: any WorkspaceContentStore
  let clock: @Sendable () -> Date

  public init(
    rootDirectory: URL, scope: WorkspaceScope, limits: ContentCacheLimits = .init(),
    clock: @escaping @Sendable () -> Date = { Date() }
  ) throws {
    self.scope = scope
    self.limits = limits
    self.clock = clock
    self.store = try SQLiteWorkspaceIndex(
      url: WorkspaceDirectory.url(root: rootDirectory, scope: scope).appendingPathComponent(
        "index.sqlite"),
      scope: scope)
  }

  public init(
    scope: WorkspaceScope, store: any WorkspaceContentStore, limits: ContentCacheLimits = .init(),
    clock: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.scope = scope
    self.store = store
    self.limits = limits
    self.clock = clock
  }

  public func beginThreadFetch(_ id: String) throws -> ContentFetchTicket {
    try begin(.thread(id))
  }

  /// Reserve after applying stream events to the authoritative in-memory snapshot. This
  /// invalidates any earlier network response, so it cannot roll back the saved event state.
  public func beginThreadUpdate(_ id: String, replacing generation: Int64) throws
    -> ContentFetchTicket
  {
    try begin(.thread(id), replacing: generation)
  }

  public func beginArtifactFetch(threadID: String, artifactID: String) throws -> ContentFetchTicket
  {
    try begin(.artifact(threadID: threadID, artifactID: artifactID))
  }

  @discardableResult
  public func storeThread(_ response: ThreadResponse, fetch ticket: ContentFetchTicket) throws
    -> CachedContentMetadata
  {
    guard ticket.scope == scope, ticket.resource == .thread(response.thread.id) else {
      throw WorkspaceContentCacheError.invalidContent
    }
    let data = try JSONEncoder().encode(response)
    return try store.commitContent(
      data, descriptor: Data(), ticket: ticket, at: clock(), limits: limits)
  }

  public func thread(_ id: String) throws -> CachedThreadSnapshot? {
    let resource = CachedContentResource.thread(id)
    try resource.validate()
    guard let stored = try store.readContent(resource, maxBytes: limits.threadBytes, at: clock())
    else {
      return nil
    }
    let response: ThreadResponse
    do { response = try JSONDecoder().decode(ThreadResponse.self, from: stored.data) } catch {
      throw WorkspaceContentCacheError.corruptContent
    }
    guard response.thread.id == id else { throw WorkspaceContentCacheError.corruptContent }
    return CachedThreadSnapshot(response: response, metadata: stored.metadata)
  }

  @discardableResult
  public func storeArtifact(
    _ artifact: ArtifactMeta, data: Data, mimeType: String, fetch ticket: ContentFetchTicket
  ) throws -> CachedContentMetadata {
    guard ticket.scope == scope,
      ticket.resource == .artifact(threadID: artifact.threadId, artifactID: artifact.id),
      artifact.size == data.count
    else { throw WorkspaceContentCacheError.invalidContent }
    guard data.count <= limits.artifactBytes else {
      throw WorkspaceContentCacheError.payloadTooLarge(limit: limits.artifactBytes)
    }
    let type = mimeType.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !type.isEmpty, type.utf8.count <= 256,
      !type.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
    else { throw WorkspaceContentCacheError.invalidContent }
    let descriptor = CachedArtifactDescriptor(artifact: artifact, mimeType: type)
    return try store.commitContent(
      data, descriptor: JSONEncoder().encode(descriptor), ticket: ticket, at: clock(),
      limits: limits)
  }

  public func artifact(threadID: String, artifactID: String) throws -> CachedArtifactSnapshot? {
    let resource = CachedContentResource.artifact(threadID: threadID, artifactID: artifactID)
    try resource.validate()
    guard let stored = try store.readContent(resource, maxBytes: limits.artifactBytes, at: clock())
    else {
      return nil
    }
    let descriptor: CachedArtifactDescriptor
    do {
      descriptor = try JSONDecoder().decode(CachedArtifactDescriptor.self, from: stored.descriptor)
    } catch { throw WorkspaceContentCacheError.corruptContent }
    guard descriptor.artifact.id == artifactID, descriptor.artifact.threadId == threadID,
      descriptor.artifact.size == stored.data.count
    else { throw WorkspaceContentCacheError.corruptContent }
    return CachedArtifactSnapshot(
      descriptor: descriptor, data: stored.data, metadata: stored.metadata)
  }

  public func availability(_ resource: CachedContentResource) throws -> ContentCacheAvailability {
    try resource.validate()
    let result = try store.contentAvailability(resource)
    if case .available(let metadata) = result,
      metadata.byteCount > limits.maximum(for: resource)
    {
      return .tooLarge(metadata, limit: limits.maximum(for: resource))
    }
    return result
  }

  /// Includes pinned selections whose bytes have not arrived, without loading payloads.
  public func entries(pinnedOnly: Bool = false) throws -> [ContentCacheEntry] {
    try store.contentResources(pinnedOnly: pinnedOnly).map {
      ContentCacheEntry(resource: $0, availability: try availability($0))
    }
  }

  /// A chosen download can be pinned before its fetch. Pinning never implies bytes exist.
  /// Pins are cache preference, not unsynced user work, and do not block explicit Forget.
  public func setPinned(_ resource: CachedContentResource, _ pinned: Bool) throws {
    try resource.validate()
    try store.setContentPinned(resource, pinned: pinned)
  }

  /// Explicit removal clears its pin and invalidates every prior fetch ticket atomically.
  public func remove(_ resource: CachedContentResource) throws {
    try resource.validate()
    try store.removeContent(resource)
  }

  @discardableResult
  public func trim() throws -> ContentCacheUsage { try store.trimContent(to: limits.totalBytes) }

  public func usage() throws -> ContentCacheUsage {
    try store.contentUsage(budgetBytes: limits.totalBytes)
  }

  private func begin(_ resource: CachedContentResource, replacing generation: Int64? = nil) throws
    -> ContentFetchTicket
  {
    try resource.validate()
    return try store.beginContentFetch(resource, scope: scope, replacing: generation)
  }
}
