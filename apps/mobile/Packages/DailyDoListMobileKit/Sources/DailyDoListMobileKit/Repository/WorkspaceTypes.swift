import Foundation

/// A cache belongs to a verified vault on one explicitly selected connection. Credentials are
/// deliberately absent; re-pairing does not discard this namespace or its drafts.
public struct WorkspaceScope: Codable, Hashable, Sendable {
  public let profileID: UUID
  public let workspaceID: String
  public let hostID: String
  public let origin: ConnectionOrigin

  public init(profileID: UUID, workspaceID: String, hostID: String, origin: ConnectionOrigin) {
    self.profileID = profileID
    self.workspaceID = workspaceID
    self.hostID = hostID
    self.origin = origin
  }
}

public struct RemoteWorkspaceIdentity: Hashable, Sendable {
  public var workspaceID: String
  public var hostID: String
  public var supportsConditionalWorkspaceWrites: Bool
  public var supportsAtomicCapture: Bool

  public init(
    workspaceID: String, hostID: String, supportsConditionalWorkspaceWrites: Bool,
    supportsAtomicCapture: Bool = false
  ) {
    self.workspaceID = workspaceID
    self.hostID = hostID
    self.supportsConditionalWorkspaceWrites = supportsConditionalWorkspaceWrites
    self.supportsAtomicCapture = supportsAtomicCapture
  }
}

public struct RemoteNote: Hashable, Sendable {
  public var content: String
  public var version: String

  public init(content: String, version: String) {
    self.content = content
    self.version = version
  }
}

/// The adapter must reject credential/workspace errors, preserve ordinary TLS verification, and
/// attach the expected workspace to the actual write request. A preflight health check alone
/// cannot protect against a host switching vaults between the read and write.
public protocol WorkspaceRemote: Sendable {
  var profileID: UUID { get }
  var origin: ConnectionOrigin { get }
  func identity() async throws -> RemoteWorkspaceIdentity
  func readNote(_ path: String) async throws -> RemoteNote?
  func writeNote(_ path: String, content: String, baseVersion: String?, workspaceID: String)
    async throws -> RemoteNote
}

public enum WorkspaceRemoteError: Error, Sendable {
  case conflict
  case unauthorized
  case workspaceChanged
}

public enum WorkspaceRepositoryError: Error, Equatable, Sendable {
  case invalidPath
  case invalidScope
  case missingDocument
  case staleRevision(expected: Int64, actual: Int64)
  case workspaceMismatch
  case hostMismatch
  case unsupportedHost
  case connectionChanged
  case documentNeedsReview
  case invalidTextChange
  case corruptCheckpoint
  case corruptIndex
  case concurrentWrite
  case pendingCaptures
  case pendingNoteWrites
  case pendingStructuralChange
  case workspaceForgotten
  case unsupportedIndexVersion(Int)
  case storage(String)
}

public enum NoteSyncState: String, Codable, Sendable {
  case synced
  case waitingToSync
  case needsReview
  case recoveryDraft
}

/// A returned revision has been durably checkpointed. The caller may show "saved on iPhone"
/// only after this acknowledgement, and applies asynchronous results only to their own revision.
public struct LocalNote: Sendable {
  public let path: String
  public let content: String
  public let localRevision: Int64
  public let acknowledgedRevision: Int64
  public let baseVersion: String?
  public let state: NoteSyncState
  public let reviewReason: ReviewReason?
  public let recoveryCopies: [URL]
  public let workingFile: URL

  public var hasUnsyncedChanges: Bool { localRevision > acknowledgedRevision }
}

public enum ReviewReason: String, Codable, Sendable {
  case overlappingEdits
  case remoteDeleted
  case pathCollision
  case uncertainWrite
}

/// UTF-16 offsets match TextKit and the shared editor. Enqueue away from the input callback;
/// the repository actor performs replacement, hashing, checkpointing and indexing off-main.
public struct NoteTextChange: Sendable {
  public let range: NSRange
  public let replacement: String

  public init(range: NSRange, replacement: String) {
    self.range = range
    self.replacement = replacement
  }
}

public enum OfflineOperation: Sendable {
  case editCachedNote, createNote, editRoutineInstructions, editDrawing, capture
  case draftMessage, searchCache, viewCachedArtifact
  case sendMessage, approval, runNow, retry, stop, pauseRoutine, resumeRoutine
  case rename, move, delete, sharedSettings, placement, syncSettings

  public var policy: OfflineOperationPolicy {
    switch self {
    case .editCachedNote, .createNote, .editRoutineInstructions, .editDrawing, .capture:
      .durableLocalOperation
    case .draftMessage: .draftOnly
    case .searchCache, .viewCachedArtifact: .cachedReadOnly
    default: .requiresOnlineAction
    }
  }
}

public enum OfflineOperationPolicy: Sendable {
  case durableLocalOperation, draftOnly, cachedReadOnly, requiresOnlineAction
}
