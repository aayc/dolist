import DailyDoListAgentCore
import DailyDoListClient
import DailyDoListModels
import Foundation

/// Bridges the phone's scoped SQLite cache to the portable agent store. No credentials are
/// stored here; the app owns the authenticated client and its current connection authority.
public actor MobileAgentContentCache: AgentContentCache {
  let cache: WorkspaceContentCache
  private let ticketOwner = UUID()
  public var artifactMaxBytes: Int { get async { cache.limits.artifactBytes } }

  public init(rootDirectory: URL, scope: WorkspaceScope, limits: ContentCacheLimits = .init())
    throws
  {
    cache = try WorkspaceContentCache(rootDirectory: rootDirectory, scope: scope, limits: limits)
  }

  public init(cache: WorkspaceContentCache) { self.cache = cache }

  public func inbox() async throws -> AgentCacheSnapshot<AgentInboxSnapshot>? {
    try await cache.agentInbox()
  }

  /// Background approval refresh only: preserve every other field and fail if a newer Inbox
  /// snapshot won. A missing Inbox can be seeded with approvals without inventing agent status.
  public func replacePendingApprovals(_ approvals: [ApprovalRequest], replacing generation: Int64?)
    async throws -> AgentCacheMetadata
  {
    try await cache.replaceAgentPendingApprovals(approvals, replacing: generation).agentMetadata
  }

  public func thread(_ id: String) async throws -> AgentCacheSnapshot<ThreadResponse>? {
    guard let value = try await cache.thread(id) else { return nil }
    return AgentCacheSnapshot(value: value.response, metadata: value.metadata.agentMetadata)
  }

  public func artifact(threadID: String, artifactID: String) async throws -> AgentCacheSnapshot<
    AgentCachedArtifact
  >? {
    guard let value = try await cache.artifact(threadID: threadID, artifactID: artifactID) else {
      return nil
    }
    return AgentCacheSnapshot(
      value: AgentCachedArtifact(
        artifact: value.descriptor.artifact,
        payload: ArtifactPayload(data: value.data, mimeType: value.descriptor.mimeType)),
      metadata: value.metadata.agentMetadata)
  }

  public func begin(_ resource: AgentCacheResource) async throws -> AgentCacheTicket {
    let ticket = try await cache.beginAgentFetch(resource.contentResource)
    return AgentCacheTicket(owner: ticketOwner, resource: resource, generation: ticket.generation)
  }

  public func storeInbox(_ value: AgentInboxSnapshot, ticket: AgentCacheTicket) async throws
    -> AgentCacheMetadata
  {
    guard ticket.resource == .inbox else { throw WorkspaceContentCacheError.invalidContent }
    return try await cache.storeAgentInbox(value, ticket: contentTicket(ticket)).agentMetadata
  }

  public func storeThread(_ value: ThreadResponse, ticket: AgentCacheTicket) async throws
    -> AgentCacheMetadata
  {
    try await cache.storeThread(value, fetch: contentTicket(ticket)).agentMetadata
  }

  public func storeArtifact(
    _ meta: ArtifactMeta, payload: ArtifactPayload, ticket: AgentCacheTicket
  ) async throws -> AgentCacheMetadata {
    try await cache.storeArtifact(
      meta, data: payload.data, mimeType: payload.mimeType,
      fetch: contentTicket(ticket)
    ).agentMetadata
  }

  public func availability(_ resource: AgentCacheResource) async throws -> AgentCacheAvailability {
    switch try await cache.availability(resource.contentResource) {
    case .missing(let pinned): return .missing(pinned: pinned)
    case .available(let metadata): return .available(metadata.agentMetadata)
    case .tooLarge(let metadata, let limit): return .tooLarge(limit: limit, pinned: metadata.pinned)
    }
  }

  public func setPinned(_ resource: AgentCacheResource, pinned: Bool) async throws {
    try await cache.setPinned(resource.contentResource, pinned)
  }

  private func contentTicket(_ ticket: AgentCacheTicket) throws -> ContentFetchTicket {
    guard ticket.owner == ticketOwner else { throw WorkspaceRepositoryError.invalidScope }
    return ContentFetchTicket(
      scope: cache.scope, resource: ticket.resource.contentResource, generation: ticket.generation)
  }
}

extension AgentCacheResource {
  fileprivate var contentResource: CachedContentResource {
    switch self {
    case .inbox: .inbox
    case .thread(let id): .thread(id)
    case .artifact(let thread, let id): .artifact(threadID: thread, artifactID: id)
    }
  }
}

extension CachedContentMetadata {
  fileprivate var agentMetadata: AgentCacheMetadata {
    AgentCacheMetadata(
      generation: generation, fetchedAt: fetchedAt, byteCount: byteCount, pinned: pinned)
  }
}

extension WorkspaceContentCache {
  fileprivate func beginAgentFetch(_ resource: CachedContentResource) throws -> ContentFetchTicket {
    try resource.validate()
    return try store.beginContentFetch(resource, scope: scope, replacing: nil)
  }

  fileprivate func agentInbox() throws -> AgentCacheSnapshot<AgentInboxSnapshot>? {
    guard let stored = try store.readContent(.inbox, maxBytes: limits.threadBytes, at: clock())
    else { return nil }
    let value: AgentInboxSnapshot
    do { value = try JSONDecoder().decode(AgentInboxSnapshot.self, from: stored.data) } catch {
      throw WorkspaceContentCacheError.corruptContent
    }
    return AgentCacheSnapshot(value: value, metadata: stored.metadata.agentMetadata)
  }

  fileprivate func replaceAgentPendingApprovals(
    _ approvals: [ApprovalRequest], replacing generation: Int64?
  ) throws -> CachedContentMetadata {
    let ticket = try store.beginContentFetch(.inbox, scope: scope, replacing: generation)
    let previous = try agentInbox()
    guard previous?.metadata.generation == generation else {
      throw WorkspaceRepositoryError.concurrentWrite
    }
    var value =
      previous?.value
      ?? AgentInboxSnapshot(
        status: nil, threads: [], approvals: [], recordsByNote: [:], routines: [],
        routineTemplates: [])
    var latest = Dictionary(
      value.approvals.filter { !$0.isPending }.map { ($0.id, $0) },
      uniquingKeysWith: { _, rhs in rhs })
    for approval in approvals where latest[approval.id] == nil || !approval.isPending {
      latest[approval.id] = approval
    }
    value.approvals = Array(latest.values)
    value.approvalsFetchedAt = clock()
    return try storeAgentInbox(value, ticket: ticket)
  }

  fileprivate func storeAgentInbox(_ value: AgentInboxSnapshot, ticket: ContentFetchTicket) throws
    -> CachedContentMetadata
  {
    try store.commitContent(
      JSONEncoder().encode(value), descriptor: Data(), ticket: ticket, at: clock(), limits: limits)
  }
}
