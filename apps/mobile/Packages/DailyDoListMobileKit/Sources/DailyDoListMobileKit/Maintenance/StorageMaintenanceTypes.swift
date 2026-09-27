import Foundation

public enum OfflineDownloadSelection: Codable, Hashable, Sendable {
  case document(String)
  case folder(String)
  case allDocuments

  public func contains(_ path: String) -> Bool {
    switch self {
    case .document(let selected): path.utf8.elementsEqual(selected.utf8)
    case .folder(let folder): path.utf8.starts(with: (folder + "/").utf8)
    case .allDocuments: true
    }
  }

  func validate() throws {
    switch self {
    case .document(let path): try WorkspaceDocumentPath.validate(path)
    case .folder(let path): try WorkspaceStructuralAction.validatePath(path, folder: true)
    case .allDocuments: break
    }
  }

  var key: String {
    get throws {
      let encoder = JSONEncoder()
      encoder.outputFormatting = .sortedKeys
      return MarkdownCheckpointStore.digest(try encoder.encode(self))
    }
  }
}

public enum DocumentDownloadState: String, Codable, Sendable {
  case requested
  /// A durable start record, not evidence that a worker is still running after suspension.
  case attempting
  case available
  case failed
  case cancelled
}

public enum DocumentDownloadFailure: String, Codable, Sendable {
  case tooLarge, unavailable, connectionChanged, downloadFailed, storage
}

public struct DocumentDownloadRequest: Codable, Sendable, Identifiable {
  public let id: UUID
  public let path: String
  public let maxBytes: Int
  public var state: DocumentDownloadState
  public var requestedAt: Date
  public var updatedAt: Date
  public var completedBytes: Int?
  public var documentRevision: Int64?
  public var failure: DocumentDownloadFailure?

  public init(
    id: UUID, path: String, maxBytes: Int, state: DocumentDownloadState, requestedAt: Date,
    updatedAt: Date, completedBytes: Int? = nil, documentRevision: Int64? = nil,
    failure: DocumentDownloadFailure? = nil
  ) {
    self.id = id
    self.path = path
    self.maxBytes = maxBytes
    self.state = state
    self.requestedAt = requestedAt
    self.updatedAt = updatedAt
    self.completedBytes = completedBytes
    self.documentRevision = documentRevision
    self.failure = failure
  }
}

public struct DocumentDownloadTicket: Sendable {
  public let scope: WorkspaceScope
  public let id: UUID
  public let path: String
  public let maxBytes: Int

  public init(scope: WorkspaceScope, id: UUID, path: String, maxBytes: Int) {
    self.scope = scope
    self.id = id
    self.path = path
    self.maxBytes = maxBytes
  }
}

public enum CachedDocumentProtection: String, Hashable, Sendable {
  case unsynced, recovery, pendingWrite, drawingDependency, structuralOperation, pinned,
    activeEditor
}

public struct CachedDocumentEntry: Sendable, Identifiable {
  public var id: String { path }
  public let path: String
  public let revision: Int64
  public let generation: Int64
  public let state: NoteSyncState
  public let bytes: Int
  /// Checkpoint files are present; opening content also verifies their digest and encoding.
  public let available: Bool
  public let accessedAt: Date
  public let protections: Set<CachedDocumentProtection>
  public var evictable: Bool { protections.isEmpty }
}

public struct MarkdownStorageUsage: Sendable {
  /// Plain checkpoint files only; SQLite/WAL, artifact blobs and unrelated files are separate.
  public let checkpointBytes: Int
  public let referencedBytes: Int
  public let protectedBytes: Int
  public let cachedBytes: Int
  public let orphanBytes: Int
  public let budgetBytes: Int
  public var overBudget: Bool { cachedBytes > budgetBytes }
}

public struct WorkspaceStorageInventory: Sendable {
  public let documents: [CachedDocumentEntry]
  public let selections: [OfflineDownloadSelection]
  public let downloads: [DocumentDownloadRequest]
  public let usage: MarkdownStorageUsage
  /// Unknown durable payload formats stop reclamation rather than guessing their references.
  public let unsupportedProtectedRecords: Int
}

public struct StorageTrimResult: Sendable {
  public let evictedPaths: [String]
  public let skippedPaths: [String]
  public let busy: Bool
  public let unsupportedProtectedRecords: Int

  public init(
    evictedPaths: [String], skippedPaths: [String], busy: Bool, unsupportedProtectedRecords: Int
  ) {
    self.evictedPaths = evictedPaths
    self.skippedPaths = skippedPaths
    self.busy = busy
    self.unsupportedProtectedRecords = unsupportedProtectedRecords
  }
}

public struct CheckpointCollectionResult: Sendable {
  public let removedFiles: Int
  public let removedBytes: Int
  public let remainingOrphanFiles: Int
  public let busy: Bool
  public let unsupportedProtectedRecords: Int
}

public enum WorkspaceStorageError: Error, Equatable, LocalizedError, Sendable {
  case invalidLimit
  case staleDownload
  case unavailableCheckpoint
  case downloadTooLarge(maxBytes: Int)

  public var errorDescription: String? {
    switch self {
    case .invalidLimit: "The download or cleanup limit must be positive."
    case .staleDownload: "This download changed. Refresh its status before trying again."
    case .unavailableCheckpoint: "The downloaded content is unavailable on this device."
    case .downloadTooLarge(let maxBytes): "This download exceeds the \(maxBytes)-byte limit."
    }
  }
}

public struct WorkspaceStorageSnapshot: Sendable {
  public let documents: [NoteIndexRecord]
  public let pending: [NoteOutboxRecord]
  public let values: [WorkspaceStoredValue]
  public let selections: [OfflineDownloadSelection]
  public let downloads: [DocumentDownloadRequest]
  public let accessedAt: [String: Date]

  public init(
    documents: [NoteIndexRecord], pending: [NoteOutboxRecord], values: [WorkspaceStoredValue],
    selections: [OfflineDownloadSelection], downloads: [DocumentDownloadRequest],
    accessedAt: [String: Date]
  ) {
    self.documents = documents
    self.pending = pending
    self.values = values
    self.selections = selections
    self.downloads = downloads
    self.accessedAt = accessedAt
  }
}

/// Shares the document transaction domain. Download completions and eviction must revalidate
/// their tickets/generations in the same transaction that changes their metadata.
public protocol WorkspaceStorageControlStore: WorkspaceIndex {
  func storageSnapshot() throws -> WorkspaceStorageSnapshot
  func selectOffline(_ selection: OfflineDownloadSelection, selected: Bool) throws
  func requestDownloads(
    _ selection: OfflineDownloadSelection, paths: [String], maxBytes: Int, at: Date
  ) throws -> [DocumentDownloadRequest]
  func beginDownload(_ path: String, at: Date) throws -> DocumentDownloadTicket
  func completeDownload(
    _ ticket: DocumentDownloadTicket, document: NoteIndexRecord, bytes: Int, at: Date) throws
  func failDownload(_ ticket: DocumentDownloadTicket, failure: DocumentDownloadFailure, at: Date)
    throws
  func cancelDownload(_ path: String, id: UUID, at: Date) throws
  func evictDocuments(_ generations: [String: Int64], protecting activePaths: Set<String>) throws
    -> StorageTrimResult
}
