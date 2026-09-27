import Foundation

public enum WorkspaceStructuralAction: Codable, Hashable, Sendable {
  case rename(from: String, to: String, isFolder: Bool)
  case trash(path: String, isFolder: Bool)

  public var source: String {
    switch self {
    case .rename(let from, _, _): from
    case .trash(let path, _): path
    }
  }
  public var destination: String? {
    if case .rename(_, let to, _) = self { return to }
    return nil
  }
  public var isFolder: Bool {
    switch self {
    case .rename(_, _, let folder), .trash(_, let folder): folder
    }
  }

  public func affects(_ path: String) -> Bool {
    path.utf8.elementsEqual(source.utf8)
      || (isFolder && path.utf8.starts(with: (source + "/").utf8))
  }

  public func remappedPath(_ path: String) -> String? {
    guard affects(path), let destination else { return nil }
    return destination + String(decoding: path.utf8.dropFirst(source.utf8.count), as: UTF8.self)
  }

  func validate() throws {
    try Self.validatePath(source, folder: isFolder)
    if let destination {
      try Self.validatePath(destination, folder: isFolder)
      guard !destination.utf8.elementsEqual(source.utf8), !affects(destination) else {
        throw WorkspaceMaintenanceError.invalidStructuralAction
      }
    }
  }

  static func validatePath(_ path: String, folder: Bool) throws {
    if !folder {
      try WorkspaceDocumentPath.validate(path)
      return
    }
    guard !path.isEmpty, !path.contains("\\"), !path.contains("\0"),
      path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({
        !$0.isEmpty && !$0.hasPrefix(".")
      })
    else { throw WorkspaceMaintenanceError.invalidStructuralAction }
  }
}

public enum StructuralState: String, Codable, Sendable {
  /// Persisted before the only automatic send. After restart this also requires reconciliation.
  case attempting
  case needsReview
  case applied
  case notApplied

  public var unresolved: Bool { self == .attempting || self == .needsReview }
}

public struct WorkspaceStructuralOperation: Codable, Sendable, Identifiable {
  public let id: UUID
  public let scope: WorkspaceScope
  public let action: WorkspaceStructuralAction
  public let startedAt: Date
  public var state: StructuralState
  public var cachedNotes: [NoteIndexRecord]
  public var revision: Int64
}

public enum StructuralResolution: Sendable { case applied, notApplied }

public enum WorkspaceMaintenanceError: Error, Equatable, Sendable {
  case invalidStructuralAction
  case dirtyAffectedNotes
  case destinationCollision
  case missingOperation
  case operationAlreadyResolved
  case unsyncedWork
  case invalidExportDestination
}

public enum StructuralRemoteError: Error, Sendable {
  /// Use only for a response that proves no mutation took place, never a timeout or generic 5xx.
  case rejected
}

public protocol StructuralRemote: Sendable {
  var profileID: UUID { get }
  var origin: ConnectionOrigin { get }
  func identity() async throws -> RemoteWorkspaceIdentity
  /// Online only, expected workspace attached. Return only after verifying the requested
  /// target was acknowledged. Delete must call the daemon's soft-trash route.
  func perform(_ action: WorkspaceStructuralAction, workspaceID: String) async throws
}

public struct WorkspaceRecoverySnapshot: Sendable {
  public let documents: [NoteIndexRecord]
  public let pendingWrites: [NoteOutboxRecord]
  public let values: [WorkspaceStoredValue]

  public init(
    documents: [NoteIndexRecord], pendingWrites: [NoteOutboxRecord], values: [WorkspaceStoredValue]
  ) {
    self.documents = documents
    self.pendingWrites = pendingWrites
    self.values = values
  }
}

/// The maintenance implementation must use the same transaction domain as notes/captures.
public protocol WorkspaceMaintenanceStore: WorkspaceIndex {
  func prepareStructural(_ operation: WorkspaceStructuralOperation) throws
    -> WorkspaceStructuralOperation
  func resolveStructural(_ id: UUID, revision: Int64, resolution: StructuralResolution?) throws
    -> WorkspaceStructuralOperation
  func recoverySnapshot() throws -> WorkspaceRecoverySnapshot
  func discardLocalNote(path: String, expectedRevision: Int64) throws
  func isForgotten() throws -> Bool
  func forget(discardUnsyncedWork: Bool) throws
}
