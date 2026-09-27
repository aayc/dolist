import Foundation

/// Durable phone working copies. All document-sized work and disk access run on this actor,
/// never in TextKit's input callback. Network awaits permit typing while immutable sends run.
public actor WorkspaceRepository {
  public nonisolated let scope: WorkspaceScope
  let index: any WorkspaceIndex
  let checkpoints: any NoteCheckpointStore
  var connectionGeneration: UInt64 = 0
  var synchronizing = false

  public init(rootDirectory: URL, scope: WorkspaceScope) throws {
    try Self.validate(scope)
    let workspace = MarkdownCheckpointStore.digest(Data(scope.workspaceID.utf8))
    let directory = rootDirectory.appendingPathComponent(scope.profileID.uuidString)
      .appendingPathComponent(workspace)
    self.scope = scope
    self.checkpoints = try MarkdownCheckpointStore(
      directory: directory.appendingPathComponent("markdown"))
    self.index = try SQLiteWorkspaceIndex(
      url: directory.appendingPathComponent("index.sqlite"), scope: scope)
  }

  /// Inject storage to exercise disk-full/locked-data and interrupted-transaction recovery.
  public init(
    scope: WorkspaceScope, index: any WorkspaceIndex, checkpoints: any NoteCheckpointStore
  ) throws {
    try Self.validate(scope)
    self.scope = scope
    self.index = index
    self.checkpoints = checkpoints
  }

  public func note(_ path: String) throws -> LocalNote? {
    try Self.validatePath(path)
    return try index.document(path).map(snapshot)
  }

  public func notes() throws -> [LocalNote] { try index.documents().map(snapshot) }

  /// A fetched note can seed/refresh clean cache entries. Dirty/recovery entries win until
  /// reconciliation; an arriving server snapshot must never overwrite their working files.
  @discardableResult
  public func cache(_ remote: RemoteNote, path: String) throws -> LocalNote {
    try Self.validatePath(path)
    let prior = try index.document(path)
    if let existing = prior, existing.state != .synced {
      return try snapshot(existing)
    }
    let hash = try checkpoints.put(remote.content)
    let revision = try nextRevision(prior?.revision ?? 0)
    let record = NoteIndexRecord(
      generation: prior?.generation ?? 0, path: path, working: hash, base: hash,
      baseVersion: remote.version,
      revision: revision, acknowledgedRevision: revision, state: .synced, recoveryCopies: [])
    try index.commit(record, pending: nil)
    return try snapshot(record)
  }

  /// Ordinary new notes use create-only intent. Daily capture is a separate append operation;
  /// callers must not represent the same pending capture as an ordinary full-note edit.
  @discardableResult
  public func create(path: String, content: String) throws -> LocalNote {
    try Self.validatePath(path)
    guard try index.document(path) == nil else {
      throw WorkspaceRepositoryError.documentNeedsReview
    }
    let hash = try checkpoints.put(content)
    let record = NoteIndexRecord(
      path: path, working: hash, revision: 1, acknowledgedRevision: 0,
      state: .waitingToSync, recoveryCopies: [])
    try index.commit(record, pending: NoteOutboxRecord(path: path))
    return try snapshot(record)
  }

  @discardableResult
  public func edit(path: String, change: NoteTextChange, expectedRevision: Int64) throws
    -> LocalNote
  {
    let record = try requireDocument(path, revision: expectedRevision)
    let text = try checkpoints.read(record.working) as NSString
    guard change.range.location >= 0, change.range.length >= 0,
      change.range.location <= text.length,
      change.range.length <= text.length - change.range.location
    else { throw WorkspaceRepositoryError.invalidTextChange }
    return try save(
      path: path, content: text.replacingCharacters(in: change.range, with: change.replacement),
      expectedRevision: expectedRevision)
  }

  /// Called by a debounced editor checkpoint or by `edit`, never per-key on the main actor.
  @discardableResult
  public func save(path: String, content: String, expectedRevision: Int64) throws -> LocalNote {
    var record = try requireDocument(path, revision: expectedRevision)
    let hash = try checkpoints.put(content)
    if hash == record.working { return try snapshot(record) }
    record.working = hash
    record.revision = try nextRevision(record.revision)
    var pending = try index.pending(path)
    if record.state == .synced || record.state == .waitingToSync {
      if hash == record.base && pending?.attempt == nil {
        record.acknowledgedRevision = record.revision
        record.state = .synced
        pending = nil
      } else {
        record.state = .waitingToSync
        pending = pending ?? NoteOutboxRecord(path: path)
      }
    }
    try index.commit(record, pending: pending)
    return try snapshot(record)
  }

  /// Explicit user review may resume a merged note. Deletions, collisions and indeterminate
  /// writes require saving a new recovery note or choosing the remote version instead.
  @discardableResult
  public func keepMergedEdits(path: String, expectedRevision: Int64) throws -> LocalNote {
    var record = try requireDocument(path, revision: expectedRevision)
    guard record.reviewReason == .overlappingEdits else {
      throw WorkspaceRepositoryError.documentNeedsReview
    }
    record.reviewReason = nil
    record.state = record.working == record.base ? .synced : .waitingToSync
    if record.state == .synced { record.acknowledgedRevision = record.revision }
    try index.commit(
      record,
      pending: record.state == .synced ? nil : NoteOutboxRecord(path: path))
    return try snapshot(record)
  }

  /// Creates a separate, create-only note. The original stays available for review/export and
  /// cannot silently resurrect the remotely deleted task at its old path.
  @discardableResult
  public func recover(path: String, as newPath: String, expectedRevision: Int64) throws -> LocalNote
  {
    let record = try requireDocument(path, revision: expectedRevision)
    guard record.state == .recoveryDraft || record.state == .needsReview else {
      throw WorkspaceRepositoryError.documentNeedsReview
    }
    return try create(path: newPath, content: checkpoints.read(record.working))
  }

  /// Explicitly resolves review by adopting the saved remote version. Preserve the local
  /// working file in recovery copies so this choice remains exportable.
  @discardableResult
  public func useRemoteVersion(path: String, expectedRevision: Int64) throws -> LocalNote {
    var record = try requireDocument(path, revision: expectedRevision)
    guard record.state == .needsReview, let base = record.base else {
      throw WorkspaceRepositoryError.documentNeedsReview
    }
    if !record.recoveryCopies.contains(record.working) {
      record.recoveryCopies.append(record.working)
    }
    record.working = base
    record.revision = try nextRevision(record.revision)
    record.acknowledgedRevision = record.revision
    record.state = .synced
    record.reviewReason = nil
    try index.commit(record, pending: nil)
    return try snapshot(record)
  }

  /// Called on foreground connection replacement, revocation or workspace-changing events.
  /// In-flight requests may finish, but their results cannot mutate the new session's cache.
  public func invalidateConnection() { connectionGeneration &+= 1 }

  func requireDocument(_ path: String, revision: Int64? = nil) throws -> NoteIndexRecord {
    try Self.validatePath(path)
    guard let record = try index.document(path) else {
      throw WorkspaceRepositoryError.missingDocument
    }
    if let revision, revision != record.revision {
      throw WorkspaceRepositoryError.staleRevision(expected: revision, actual: record.revision)
    }
    return record
  }

  func snapshot(_ record: NoteIndexRecord) throws -> LocalNote {
    // Validate both working content and base before displaying any writable document. Missing
    // protected/corrupt files produce a visible failure, never an invented empty editor.
    let content = try checkpoints.read(record.working)
    if let base = record.base { _ = try checkpoints.read(base) }
    return try LocalNote(
      path: record.path, content: content, localRevision: record.revision,
      acknowledgedRevision: record.acknowledgedRevision, baseVersion: record.baseVersion,
      state: record.state, reviewReason: record.reviewReason,
      recoveryCopies: record.recoveryCopies.map(checkpoints.fileURL),
      workingFile: checkpoints.fileURL(record.working))
  }

  func nextRevision(_ current: Int64) throws -> Int64 {
    guard current < Int64.max else { throw WorkspaceRepositoryError.corruptIndex }
    return current + 1
  }

  static func validatePath(_ path: String) throws {
    let segments = path.split(separator: "/", omittingEmptySubsequences: false)
    guard !path.isEmpty, path.hasSuffix(".md"), !path.contains("\\"), !path.contains("\0"),
      !path.hasSuffix(".excalidraw.md"),
      segments.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.hasPrefix(".") })
    else { throw WorkspaceRepositoryError.invalidPath }
  }

  private static func validate(_ scope: WorkspaceScope) throws {
    guard !scope.workspaceID.isEmpty, !scope.hostID.isEmpty else {
      throw WorkspaceRepositoryError.invalidScope
    }
  }
}
