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
    let directory = WorkspaceDirectory.url(root: rootDirectory, scope: scope)
    self.scope = scope
    self.index = try SQLiteWorkspaceIndex(
      url: directory.appendingPathComponent("index.sqlite"), scope: scope)
    self.checkpoints = try MarkdownCheckpointStore(
      directory: directory.appendingPathComponent("markdown"))
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
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    try Self.validatePath(path)
    return try index.document(path).map(snapshot)
  }

  public func notes() throws -> [LocalNote] {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    return try index.documents().filter { !WorkspaceDocumentPath.isDrawing($0.path) }.map(snapshot)
  }

  /// A fetched note can seed/refresh clean cache entries. Dirty/recovery entries win until
  /// reconciliation; an arriving server snapshot must never overwrite their working files.
  @discardableResult
  public func cache(_ remote: RemoteNote, path: String) throws -> LocalNote {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    try Self.validatePath(path)
    let prior = try index.document(path)
    if let existing = prior, existing.state != .synced {
      return try snapshot(existing)
    }
    let hash = try checkpoints.put(remote.content)
    let revision = try nextRevision(prior?.revision ?? index.lastDocumentRevision(path))
    let record = NoteIndexRecord(
      generation: prior?.generation ?? 0, path: path, working: hash, base: hash,
      baseVersion: remote.version,
      revision: revision, acknowledgedRevision: revision, state: .synced,
      recoveryCopies: prior?.recoveryCopies ?? [])
    try index.commit(record, pending: nil)
    return try snapshot(record)
  }

  /// Ordinary new notes use create-only intent. Daily capture is a separate append operation;
  /// callers must not represent the same pending capture as an ordinary full-note edit.
  @discardableResult
  public func create(
    path: String, content: String, requiringDrawings: [String] = [],
    requiringAttachments: [AttachmentDependency] = []
  ) throws
    -> LocalNote
  {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    try Self.validatePath(path)
    guard try index.document(path) == nil else {
      throw WorkspaceRepositoryError.documentNeedsReview
    }
    let hash = try checkpoints.put(content)
    for path in requiringDrawings { try DrawingRepository.validatePath(path) }
    for dependency in requiringAttachments { try dependency.validate() }
    let record = NoteIndexRecord(
      path: path, working: hash, revision: try nextRevision(index.lastDocumentRevision(path)),
      acknowledgedRevision: 0,
      state: .waitingToSync, recoveryCopies: [],
      requiredDrawings: requiringDrawings.isEmpty ? nil : requiringDrawings,
      requiredAttachments: requiringAttachments.isEmpty ? nil : requiringAttachments)
    try index.commit(record, pending: NoteOutboxRecord(path: path))
    return try snapshot(record)
  }

  /// A remote refresh can remove a clean cached row while the live editor receives unsaved
  /// typing. Retain that text for recovery without creating an intent to restore the old path.
  @discardableResult
  public func createRecoveryDraft(path: String, content: String) throws -> LocalNote {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    try Self.validatePath(path)
    guard try index.document(path) == nil else {
      throw WorkspaceRepositoryError.documentNeedsReview
    }
    let record = NoteIndexRecord(
      path: path, working: try checkpoints.put(content),
      revision: try nextRevision(index.lastDocumentRevision(path)),
      acknowledgedRevision: 0, state: .recoveryDraft, reviewReason: .remoteDeleted,
      recoveryCopies: [])
    try index.commit(record, pending: nil)
    return try snapshot(record)
  }

  @discardableResult
  public func edit(path: String, change: NoteTextChange, expectedRevision: Int64) throws
    -> LocalNote
  {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
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
  public func save(
    path: String, content: String, expectedRevision: Int64, requiringDrawings: [String]? = nil,
    requiringAttachments: [AttachmentDependency]? = nil
  ) throws -> LocalNote {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    var record = try requireDocument(path, revision: expectedRevision)
    if let requiringDrawings {
      for path in requiringDrawings { try DrawingRepository.validatePath(path) }
    }
    let attachments = requiringAttachments ?? record.requiredAttachments ?? []
    for dependency in attachments { try dependency.validate() }
    let dependencies = requiringDrawings ?? record.requiredDrawings ?? []
    let hash = try checkpoints.put(content)
    if hash == record.working && dependencies == (record.requiredDrawings ?? [])
      && attachments == (record.requiredAttachments ?? [])
    {
      return try snapshot(record)
    }
    record.requiredDrawings = dependencies.isEmpty ? nil : dependencies
    record.requiredAttachments = attachments.isEmpty ? nil : attachments
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

  /// A live editor may have uncheckpointed typing when reconciliation updates its durable
  /// snapshot. If merging those two versions conflicts, preserve the authoritative snapshots
  /// and atomically park the merged local text for explicit review instead of replaying it.
  @discardableResult
  public func saveForReview(
    path: String, content: String, expectedRevision: Int64,
    requiringDrawings: [String]? = nil, requiringAttachments: [AttachmentDependency]? = nil
  ) throws
    -> LocalNote
  {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    var record = try requireDocument(path, revision: expectedRevision)
    guard record.reviewReason == nil || record.reviewReason == .overlappingEdits else {
      throw WorkspaceRepositoryError.documentNeedsReview
    }
    guard try index.pending(path)?.attempt == nil else {
      throw WorkspaceRepositoryError.pendingNoteWrites
    }
    if let requiringDrawings {
      for path in requiringDrawings { try DrawingRepository.validatePath(path) }
      record.requiredDrawings = requiringDrawings.isEmpty ? nil : requiringDrawings
    }
    if let requiringAttachments {
      for dependency in requiringAttachments { try dependency.validate() }
      record.requiredAttachments = requiringAttachments.isEmpty ? nil : requiringAttachments
    }
    for reference in [record.working, record.base].compactMap({ $0 })
    where !record.recoveryCopies.contains(reference) {
      _ = try checkpoints.read(reference)
      record.recoveryCopies.append(reference)
    }
    let hash = try checkpoints.put(content)
    if hash != record.working {
      record.working = hash
      record.revision = try nextRevision(record.revision)
    }
    record.state = .needsReview
    record.reviewReason = .overlappingEdits
    try index.commit(record, pending: nil)
    return try snapshot(record)
  }

  /// Explicit user review may resume a merged note. Deletions, collisions and indeterminate
  /// writes require saving a new recovery note or choosing the remote version instead.
  @discardableResult
  public func keepMergedEdits(path: String, expectedRevision: Int64) throws -> LocalNote {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
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
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
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
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
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
    try WorkspaceDocumentPath.validate(path)
    guard !WorkspaceDocumentPath.isDrawing(path) else { throw WorkspaceRepositoryError.invalidPath }
  }

  private static func validate(_ scope: WorkspaceScope) throws {
    guard !scope.workspaceID.isEmpty, !scope.hostID.isEmpty else {
      throw WorkspaceRepositoryError.invalidScope
    }
  }
}
