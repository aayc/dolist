import DailyDoListModels
import Foundation

public enum CachedContentResource: Codable, Hashable, Sendable {
  case thread(String)
  case artifact(threadID: String, artifactID: String)

  var key: String {
    switch self {
    case .thread(let id):
      return "thread/" + MarkdownCheckpointStore.digest(Data(id.utf8))
    case .artifact(let thread, let artifact):
      // A length-prefixed pair has no delimiter ambiguity, even for arbitrary server IDs.
      return "artifact/"
        + MarkdownCheckpointStore.digest(Data("\(thread.utf8.count):\(thread)\(artifact)".utf8))
    }
  }

  func validate() throws {
    let ids: [String]
    switch self {
    case .thread(let id): ids = [id]
    case .artifact(let thread, let artifact): ids = [thread, artifact]
    }
    guard ids.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 2_048 && !$0.contains("\0") }) else {
      throw WorkspaceContentCacheError.invalidContent
    }
  }
}

/// A persisted, one-use ticket. Starting a newer fetch/update invalidates earlier replies,
/// including across process restarts. A cache ticket conveys no network/action authority.
public struct ContentFetchTicket: Codable, Hashable, Sendable {
  public let scope: WorkspaceScope
  public let resource: CachedContentResource
  public let generation: Int64

  public init(scope: WorkspaceScope, resource: CachedContentResource, generation: Int64) {
    self.scope = scope
    self.resource = resource
    self.generation = generation
  }
}

public struct ContentCacheLimits: Codable, Hashable, Sendable {
  public var totalBytes: Int
  public var threadBytes: Int
  public var artifactBytes: Int

  public init(
    totalBytes: Int = 64 * 1_024 * 1_024,
    threadBytes: Int = 8 * 1_024 * 1_024,
    artifactBytes: Int = 5 * 1_024 * 1_024
  ) {
    self.totalBytes = max(0, totalBytes)
    self.threadBytes = max(0, threadBytes)
    self.artifactBytes = max(0, artifactBytes)
  }

  func maximum(for resource: CachedContentResource) -> Int {
    switch resource {
    case .thread: threadBytes
    case .artifact: artifactBytes
    }
  }
}

public struct CachedContentMetadata: Codable, Hashable, Sendable {
  public let resource: CachedContentResource
  /// Monotonic across eviction/recreation; suitable for a local snapshot CAS.
  public let generation: Int64
  public let fetchedAt: Date
  public let accessedAt: Date
  public let byteCount: Int
  public let sha256: String
  public var pinned: Bool

  public init(
    resource: CachedContentResource, generation: Int64, fetchedAt: Date, accessedAt: Date,
    byteCount: Int, sha256: String, pinned: Bool
  ) {
    self.resource = resource
    self.generation = generation
    self.fetchedAt = fetchedAt
    self.accessedAt = accessedAt
    self.byteCount = byteCount
    self.sha256 = sha256
    self.pinned = pinned
  }

  /// Age is presentation information, never permission to send a cached approval/action.
  public func isStale(at now: Date, after interval: TimeInterval) -> Bool {
    now.timeIntervalSince(fetchedAt) > max(0, interval)
  }
}

public enum ContentCacheAvailability: Sendable {
  case missing(pinned: Bool)
  case available(CachedContentMetadata)
  case tooLarge(CachedContentMetadata, limit: Int)
}

public struct ContentCacheEntry: Sendable {
  public let resource: CachedContentResource
  public let availability: ContentCacheAvailability
}

public struct CachedThreadSnapshot: Sendable {
  public let response: ThreadResponse
  public let metadata: CachedContentMetadata
}

public struct CachedArtifactDescriptor: Codable, Hashable, Sendable {
  public let artifact: ArtifactMeta
  /// The authenticated response's type; display policy must still treat active content safely.
  public let mimeType: String
}

public struct CachedArtifactSnapshot: Sendable {
  public let descriptor: CachedArtifactDescriptor
  public let data: Data
  public let metadata: CachedContentMetadata
}

public struct ContentCacheUsage: Sendable {
  /// Payload and descriptor bytes, including pinned entries. SQLite pages/WAL add overhead.
  public let totalBytes: Int
  public let pinnedBytes: Int
  public let entryCount: Int
  public let budgetBytes: Int
  public var overBudget: Bool { totalBytes > budgetBytes }

  public init(totalBytes: Int, pinnedBytes: Int, entryCount: Int, budgetBytes: Int) {
    self.totalBytes = totalBytes
    self.pinnedBytes = pinnedBytes
    self.entryCount = entryCount
    self.budgetBytes = budgetBytes
  }
}

public enum WorkspaceContentCacheError: Error, Equatable, Sendable {
  case invalidContent
  case payloadTooLarge(limit: Int)
  case budgetExceeded
  case staleFetch
  case corruptContent
}

/// Low-level immutable bytes plus a typed descriptor. No MIME decoder or network runs here.
public struct StoredCachedContent: Sendable {
  public let metadata: CachedContentMetadata
  public let descriptor: Data
  public let data: Data

  public init(metadata: CachedContentMetadata, descriptor: Data, data: Data) {
    self.metadata = metadata
    self.descriptor = descriptor
    self.data = data
  }
}

public protocol WorkspaceContentStore: Sendable {
  func beginContentFetch(
    _ resource: CachedContentResource, scope: WorkspaceScope, replacing generation: Int64?
  ) throws -> ContentFetchTicket
  func contentResources(pinnedOnly: Bool) throws -> [CachedContentResource]
  func contentAvailability(_ resource: CachedContentResource) throws -> ContentCacheAvailability
  func readContent(_ resource: CachedContentResource, maxBytes: Int, at: Date) throws
    -> StoredCachedContent?
  func commitContent(
    _ data: Data, descriptor: Data, ticket: ContentFetchTicket, at: Date,
    limits: ContentCacheLimits
  ) throws -> CachedContentMetadata
  func setContentPinned(_ resource: CachedContentResource, pinned: Bool) throws
  func removeContent(_ resource: CachedContentResource) throws
  func trimContent(to budgetBytes: Int) throws -> ContentCacheUsage
  func contentUsage(budgetBytes: Int) throws -> ContentCacheUsage
}
