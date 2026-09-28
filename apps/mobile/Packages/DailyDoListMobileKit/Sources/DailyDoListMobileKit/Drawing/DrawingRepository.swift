import DailyDoListDrawingModel
import Foundation

/// Durable drawing files share note transactions/barriers but never enter markdown TextMerge.
/// Call after canvas debounce, away from touch handling; all parse/serialization/disk work is
/// actor-isolated. The app fences stale editor sessions just as it does text editor revisions.
public actor DrawingRepository {
  public nonisolated let scope: WorkspaceScope
  let index: any WorkspaceIndex
  let checkpoints: any NoteCheckpointStore
  var generation: UInt64 = 0
  let passes = RepositoryPasses()

  public init(rootDirectory: URL, scope: WorkspaceScope) throws {
    self.scope = scope
    let directory = WorkspaceDirectory.url(root: rootDirectory, scope: scope)
    self.index = try SQLiteWorkspaceIndex(
      url: directory.appendingPathComponent("index.sqlite"), scope: scope)
    self.checkpoints = try MarkdownCheckpointStore(
      directory: directory.appendingPathComponent("markdown"))
  }

  public init(
    scope: WorkspaceScope, index: any WorkspaceIndex, checkpoints: any NoteCheckpointStore
  ) {
    self.scope = scope
    self.index = index
    self.checkpoints = checkpoints
  }

  public func drawing(_ path: String) throws -> LocalDrawing? {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    try Self.validatePath(path)
    return try index.document(path).map(snapshot)
  }

  public func drawings() throws -> [LocalDrawing] {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    return try index.documents().filter { WorkspaceDocumentPath.isDrawing($0.path) }.map(snapshot)
  }

  @discardableResult
  public func cache(_ remote: RemoteNote, path: String) throws -> LocalDrawing {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    try Self.validatePath(path)
    let prior = try index.document(path)
    if let prior, prior.state != .synced {
      // A malformed file fetched without any local edit can later be repaired on the host.
      if prior.reviewReason != .invalidDrawing || prior.revision != prior.acknowledgedRevision {
        return try snapshot(prior)
      }
    }
    let hash = try checkpoints.put(remote.content)
    let revision = try nextRevision(prior?.revision ?? index.lastDocumentRevision(path))
    let invalid = DrawingValidation.error(ExcalidrawMarkdown.parse(remote.content)) != nil
    var copies = prior?.recoveryCopies ?? []
    if let prior, prior.reviewReason == .invalidDrawing, !copies.contains(prior.working) {
      copies.append(prior.working)
    }
    let record = NoteIndexRecord(
      generation: prior?.generation ?? 0, path: path, working: hash,
      base: hash, baseVersion: remote.version, revision: revision, acknowledgedRevision: revision,
      state: invalid ? .needsReview : .synced, reviewReason: invalid ? .invalidDrawing : nil,
      recoveryCopies: copies)
    try index.commit(record, pending: nil)
    return try snapshot(record)
  }

  @discardableResult
  public func create(path: String, scene: ExcalidrawScene = ExcalidrawScene()) throws
    -> LocalDrawing
  {
    try createRaw(path: path, content: DrawingValidation.serialized(scene, previous: nil))
  }

  private func createRaw(path: String, content: String) throws -> LocalDrawing {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    try Self.validatePath(path)
    guard try index.document(path) == nil else {
      throw WorkspaceRepositoryError.documentNeedsReview
    }
    let record = NoteIndexRecord(
      path: path, working: try checkpoints.put(content),
      revision: try nextRevision(index.lastDocumentRevision(path)),
      acknowledgedRevision: 0, state: .waitingToSync, recoveryCopies: [])
    try index.commit(record, pending: NoteOutboxRecord(path: path))
    return try snapshot(record)
  }

  @discardableResult
  public func save(path: String, scene: ExcalidrawScene, expectedRevision: Int64) throws
    -> LocalDrawing
  {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    var record = try require(path, revision: expectedRevision)
    let previous = ExcalidrawMarkdown.parse(try checkpoints.read(record.working))
    if let error = DrawingValidation.error(previous) { throw error }
    if scene == previous.scene { return try snapshot(record) }
    let content = try DrawingValidation.serialized(scene, previous: previous)
    let hash = try checkpoints.put(content)
    if hash == record.working { return try snapshot(record) }
    record.working = hash
    record.revision = try nextRevision(record.revision)
    var pending = try index.pending(path)
    if record.state == .synced || record.state == .waitingToSync {
      if record.working == record.base && pending?.attempt == nil {
        record.state = .synced
        record.acknowledgedRevision = record.revision
        pending = nil
      } else {
        record.state = .waitingToSync
        pending = pending ?? NoteOutboxRecord(path: path)
      }
    }
    try index.commit(record, pending: pending)
    return try snapshot(record)
  }

  /// Recovery creates a different drawing and leaves the old recovery record exportable.
  @discardableResult
  public func recover(path: String, as newPath: String, expectedRevision: Int64) throws
    -> LocalDrawing
  {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    let record = try require(path, revision: expectedRevision)
    guard record.state == .needsReview || record.state == .recoveryDraft else {
      throw WorkspaceRepositoryError.documentNeedsReview
    }
    let content = try checkpoints.read(record.working)
    if let error = DrawingValidation.error(ExcalidrawMarkdown.parse(content)) { throw error }
    return try createRaw(path: newPath, content: content)
  }

  /// Retains unsaved canvas input that arrived while refresh removed a clean cached drawing.
  /// The app passes its last file snapshot so frontmatter/non-scene sections survive too.
  @discardableResult
  public func createRecoveryDraft(
    path: String, scene: ExcalidrawScene, previous: ExcalidrawMarkdown
  ) throws -> LocalDrawing {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    try Self.validatePath(path)
    guard try index.document(path) == nil else {
      throw WorkspaceRepositoryError.documentNeedsReview
    }
    let content = try DrawingValidation.serialized(scene, previous: previous)
    let record = NoteIndexRecord(
      path: path, working: try checkpoints.put(content),
      revision: try nextRevision(index.lastDocumentRevision(path)),
      acknowledgedRevision: 0, state: .recoveryDraft, reviewReason: .remoteDeleted,
      recoveryCopies: [])
    try index.commit(record, pending: nil)
    return try snapshot(record)
  }

  /// Explicit review: preserve our file before taking a valid authoritative base.
  @discardableResult
  public func useRemoteVersion(path: String, expectedRevision: Int64) throws -> LocalDrawing {
    let access = try checkpoints.beginAccess()
    defer { access?.release() }
    var record = try require(path, revision: expectedRevision)
    guard record.state == .needsReview, let base = record.base else {
      throw WorkspaceRepositoryError.documentNeedsReview
    }
    if let error = DrawingValidation.error(ExcalidrawMarkdown.parse(try checkpoints.read(base))) {
      throw error
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

  public func invalidateConnection() { generation &+= 1 }

  func require(_ path: String, revision: Int64? = nil) throws -> NoteIndexRecord {
    try Self.validatePath(path)
    guard let record = try index.document(path) else {
      throw WorkspaceRepositoryError.missingDocument
    }
    if let revision, revision != record.revision {
      throw WorkspaceRepositoryError.staleRevision(expected: revision, actual: record.revision)
    }
    return record
  }

  func snapshot(_ record: NoteIndexRecord) throws -> LocalDrawing {
    let content = try checkpoints.read(record.working)
    if let base = record.base { _ = try checkpoints.read(base) }
    let document = ExcalidrawMarkdown.parse(content)
    return try LocalDrawing(
      path: record.path, content: content, document: document,
      localRevision: record.revision, acknowledgedRevision: record.acknowledgedRevision,
      baseVersion: record.baseVersion, state: record.state, reviewReason: record.reviewReason,
      editingError: DrawingValidation.error(document),
      recoveryCopies: record.recoveryCopies.map(checkpoints.fileURL),
      workingFile: checkpoints.fileURL(record.working))
  }

  func nextRevision(_ revision: Int64) throws -> Int64 {
    guard revision < Int64.max else { throw WorkspaceRepositoryError.corruptIndex }
    return revision + 1
  }

  static func validatePath(_ path: String) throws {
    try WorkspaceDocumentPath.validate(path)
    guard WorkspaceDocumentPath.isDrawing(path) else { throw WorkspaceRepositoryError.invalidPath }
  }
}
