import Foundation

/// One document generation and its merge base. Revisions never decrease, including after a
/// remote merge. Checkpoint references are immutable content hashes, not mutable filenames.
public struct NoteIndexRecord: Codable, Sendable {
  /// CAS generation for metadata transactions, distinct from the user's text revision.
  public var generation: Int64 = 0
  public var path: String
  public var working: String
  public var base: String?
  public var baseVersion: String?
  public var revision: Int64
  public var acknowledgedRevision: Int64
  public var state: NoteSyncState
  public var reviewReason: ReviewReason?
  public var recoveryCopies: [String]
  /// Newly embedded drawings must be acknowledged before this note may first send the embed.
  public var requiredDrawings: [String]? = nil
  public var requiredAttachments: [AttachmentDependency]? = nil
}

/// Persisted before sending. An interrupted/lost response is reconciled with this exact body,
/// never with later typing. Queued records have no attempt yet.
public struct NoteWriteAttempt: Codable, Sendable {
  public let operationID: UUID
  public let checkpoint: String
  public let revision: Int64
  public let baseVersion: String?
  public var requiredDrawings: [String]? = nil
  public var requiredAttachments: [AttachmentDependency]? = nil
}

public struct NoteOutboxRecord: Codable, Sendable {
  public var path: String
  public var attempt: NoteWriteAttempt?
}

/// Synchronous operations run exclusively on the repository actor. `commit` must atomically
/// change both document and outbox; nil removes the corresponding row. It must throw rather
/// than silently rebuilding a corrupted or newer index. Implementations may be failure-injected.
public protocol WorkspaceIndex: WorkspaceStateStore {
  func documents() throws -> [NoteIndexRecord]
  func document(_ path: String) throws -> NoteIndexRecord?
  func lastDocumentRevision(_ path: String) throws -> Int64
  func outbox() throws -> [NoteOutboxRecord]
  func pending(_ path: String) throws -> NoteOutboxRecord?
  func commit(
    path: String, document: NoteIndexRecord?, pending: NoteOutboxRecord?, expectedGeneration: Int64?
  ) throws
}

extension WorkspaceIndex {
  public func lastDocumentRevision(_ path: String) throws -> Int64 {
    try document(path)?.revision ?? 0
  }

  func commit(_ document: NoteIndexRecord, pending: NoteOutboxRecord?) throws {
    try commit(
      path: document.path, document: document, pending: pending,
      expectedGeneration: document.generation == 0 ? nil : document.generation)
  }
}
