import DailyDoListClient
import DailyDoListModels
import Foundation

public enum AgentCacheResource: Hashable, Sendable {
  case inbox
  case thread(String)
  case artifact(threadID: String, artifactID: String)
}

public struct AgentCacheTicket: Sendable {
  public let owner: UUID
  public let resource: AgentCacheResource
  public let generation: Int64
  public init(owner: UUID, resource: AgentCacheResource, generation: Int64) {
    self.owner = owner
    self.resource = resource
    self.generation = generation
  }
}

public struct AgentCacheMetadata: Hashable, Sendable {
  public let generation: Int64
  public let fetchedAt: Date
  public let byteCount: Int
  public let pinned: Bool
  public init(generation: Int64, fetchedAt: Date, byteCount: Int, pinned: Bool) {
    self.generation = generation
    self.fetchedAt = fetchedAt
    self.byteCount = byteCount
    self.pinned = pinned
  }
}

public struct AgentCacheSnapshot<Value: Sendable>: Sendable {
  public let value: Value
  public let metadata: AgentCacheMetadata
  public init(value: Value, metadata: AgentCacheMetadata) {
    self.value = value
    self.metadata = metadata
  }
}

public enum AgentCacheAvailability: Hashable, Sendable {
  case missing(pinned: Bool)
  case available(AgentCacheMetadata)
  case tooLarge(limit: Int, pinned: Bool)

  public var pinned: Bool {
    switch self {
    case .missing(let pinned), .tooLarge(_, let pinned): pinned
    case .available(let metadata): metadata.pinned
    }
  }
}

/// Latest observed presentation state. Cached approvals/status never authorize an action.
public struct AgentInboxSnapshot: Codable, Sendable {
  public var status: AgentStatusResponse?
  public var threads: [ThreadSummary]
  public var approvals: [ApprovalRequest]
  public var approvalsFetchedAt: Date?
  public var recordsByNote: [String: [TaskAgentRecord]]
  public var routines: [Routine]
  public var routineTemplates: [RoutineTemplate]

  public init(
    status: AgentStatusResponse?, threads: [ThreadSummary], approvals: [ApprovalRequest],
    recordsByNote: [String: [TaskAgentRecord]], routines: [Routine],
    routineTemplates: [RoutineTemplate], approvalsFetchedAt: Date? = nil
  ) {
    self.status = status
    self.threads = threads
    self.approvals = approvals
    self.approvalsFetchedAt = approvalsFetchedAt
    self.recordsByNote = recordsByNote
    self.routines = routines
    self.routineTemplates = routineTemplates
  }
}

public struct AgentCachedArtifact: Sendable {
  public let artifact: ArtifactMeta
  public let payload: ArtifactPayload
  public init(artifact: ArtifactMeta, payload: ArtifactPayload) {
    self.artifact = artifact
    self.payload = payload
  }
}

/// Optional, Foundation-only persistence. Implementations consume generation tickets once,
/// reject stale responses and never mix scopes, send network requests or evict unsynced work.
public protocol AgentContentCache: Sendable {
  var artifactMaxBytes: Int { get async }
  func inbox() async throws -> AgentCacheSnapshot<AgentInboxSnapshot>?
  func thread(_ id: String) async throws -> AgentCacheSnapshot<ThreadResponse>?
  func artifact(threadID: String, artifactID: String) async throws -> AgentCacheSnapshot<
    AgentCachedArtifact
  >?
  func begin(_ resource: AgentCacheResource) async throws -> AgentCacheTicket
  func storeInbox(_ value: AgentInboxSnapshot, ticket: AgentCacheTicket) async throws
    -> AgentCacheMetadata
  func storeThread(_ value: ThreadResponse, ticket: AgentCacheTicket) async throws
    -> AgentCacheMetadata
  func storeArtifact(_ meta: ArtifactMeta, payload: ArtifactPayload, ticket: AgentCacheTicket)
    async throws -> AgentCacheMetadata
  func availability(_ resource: AgentCacheResource) async throws -> AgentCacheAvailability
  func setPinned(_ resource: AgentCacheResource, pinned: Bool) async throws
}

public enum AgentContentError: Error, LocalizedError, Sendable {
  case unavailableOffline
  case exceedsLimit(Int)
  case changedConnection

  public var errorDescription: String? {
    switch self {
    case .unavailableOffline: "This content has not been downloaded. Reconnect to download it."
    case .exceedsLimit(let limit):
      "This content exceeds the \(limit / 1_024 / 1_024) MB download limit. Open it on the host."
    case .changedConnection: "The connection changed. Open this content again."
    }
  }
}
