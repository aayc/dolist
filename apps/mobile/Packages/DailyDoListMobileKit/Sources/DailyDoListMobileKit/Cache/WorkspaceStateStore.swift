import Foundation

public enum WorkspaceValueRetention: String, Codable, Sendable {
  case disposable
  case durable
}

/// A revisioned value in the workspace's SQLite transaction domain. Durable values include
/// composers, notification cursors and capture receipts, and are never cache-budget victims.
public struct WorkspaceStoredValue: Codable, Sendable {
  public var key: String
  public var revision: Int64 = 0
  public var data: Data
  public var updatedAt: Date
  public var retention: WorkspaceValueRetention
  public var blocksNoteWrites: Bool = false

  public var byteCount: Int { key.utf8.count + data.count }
}

public struct WorkspaceValueMutation: Sendable {
  public var key: String
  public var value: WorkspaceStoredValue?
  public var expectedRevision: Int64?
  /// Capture preparation and note-attempt preparation share the same SQLite write lock.
  public var requiresIdleNoteWrites: Bool = false
  /// New attachment creates also wait for capture/structural barriers in the same transaction.
  public var requiresIdleCaptureWrites: Bool = false
  public var requiresNoStructuralChange: Bool = false
  /// Original-byte admission shares the transaction which first publishes an upload intent.
  public var attachmentImportBytes: Int? = nil
}

/// Lightweight budget/index metadata; listing it never decodes large thread/capture payloads.
public struct WorkspaceValueSummary: Sendable {
  public let key: String
  public let revision: Int64
  public let updatedAt: Date
  public let retention: WorkspaceValueRetention
  public let byteCount: Int
  public let blocksNoteWrites: Bool
}

public protocol WorkspaceStateStore: Sendable {
  func value(_ key: String) throws -> WorkspaceStoredValue?
  func values(prefix: String) throws -> [WorkspaceStoredValue]
  func valueSummaries() throws -> [WorkspaceValueSummary]
  /// Compares every revision before changing any row. A failed comparison changes nothing.
  /// Returns committed revisions; a recreated key never reuses an earlier revision.
  @discardableResult
  func commitValues(_ changes: [WorkspaceValueMutation]) throws -> [String: Int64]
}

enum WorkspaceDirectory {
  static func url(root: URL, scope: WorkspaceScope) -> URL {
    root.appendingPathComponent(scope.profileID.uuidString)
      .appendingPathComponent(MarkdownCheckpointStore.digest(Data(scope.workspaceID.utf8)))
  }
}
