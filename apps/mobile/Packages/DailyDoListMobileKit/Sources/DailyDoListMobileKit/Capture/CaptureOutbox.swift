import Foundation

/// Persistent, host-bound daily capture. Its SQLite barriers prevent a pending append from
/// racing ordinary note writes, including after a process restart. Capture text is never
/// inserted into WorkspaceRepository; the UI renders pending items separately until receipt.
public actor CaptureOutbox {
  public nonisolated let scope: WorkspaceScope
  let store: any WorkspaceStateStore
  let clock: @Sendable () -> Date
  var generation: UInt64 = 0
  var syncing = false
  static let prefix = "capture/"

  public init(
    rootDirectory: URL, scope: WorkspaceScope, clock: @escaping @Sendable () -> Date = { Date() }
  ) throws {
    self.scope = scope
    self.clock = clock
    let directory = WorkspaceDirectory.url(root: rootDirectory, scope: scope)
    self.store = try SQLiteWorkspaceIndex(
      url: directory.appendingPathComponent("index.sqlite"), scope: scope)
  }

  public init(
    scope: WorkspaceScope, store: any WorkspaceStateStore,
    clock: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.scope = scope
    self.store = store
    self.clock = clock
  }

  /// Pending/review captures are always included; completed history is bounded for display.
  public func captures(recentLimit: Int = 200) throws -> [QueuedCapture] {
    let all = try store.valueSummaries().filter { $0.key.hasPrefix(Self.prefix) }
    let pending = all.filter(\.blocksNoteWrites)
    let recent = all.filter { !$0.blocksNoteWrites }.sorted { $0.updatedAt > $1.updatedAt }.prefix(
      max(0, recentLimit))
    return try (pending + recent).map { summary in
      guard let value = try store.value(summary.key) else {
        throw WorkspaceRepositoryError.corruptIndex
      }
      return try decode(value)
    }.sorted {
      $0.operation.capturedAt == $1.operation.capturedAt
        ? $0.id.uuidString < $1.id.uuidString : $0.operation.capturedAt < $1.operation.capturedAt
    }
  }

  public func capture(_ id: UUID) throws -> QueuedCapture? {
    try store.value(Self.key(id)).map(decode)
  }

  @discardableResult
  public func enqueue(
    text: String, capturedAt: Date, timeZone: TimeZone, operationID: UUID = UUID()
  ) throws -> QueuedCapture {
    let operation = try CaptureOperation(
      id: operationID, scope: scope, text: text, capturedAt: capturedAt, timeZone: timeZone)
    if let previous = try capture(operationID) {
      guard previous.operation == operation, previous.operation.text.utf8.elementsEqual(text.utf8)
      else {
        throw CaptureError.operationIDReused
      }
      return previous
    }
    let value = QueuedCapture(operation: operation, state: .queued, attemptCount: 0, revision: 0)
    return try save(value)
  }

  /// Explicit cancel is available only before a request might have been sent. The tombstone
  /// remains so a repeated enqueue with the same UUID cannot resurrect a cancelled capture.
  @discardableResult
  public func cancel(_ id: UUID, replacing revision: Int64) throws -> QueuedCapture {
    var value = try require(id, revision: revision)
    guard value.state == .queued, value.attemptCount == 0 else {
      throw CaptureError.cannotCancelAttemptedCapture
    }
    value.state = .cancelled
    return try save(value)
  }

  /// Only after the user has compared the saved content and resolved uncertainty. This removes
  /// the write barrier without issuing a second append. A new task requires a new operation.
  @discardableResult
  public func markReconciled(_ id: UUID, replacing revision: Int64) throws -> QueuedCapture {
    var value = try require(id, revision: revision)
    guard value.state == .indeterminate else { throw CaptureError.notIndeterminate }
    value.state = .reconciled
    return try save(value)
  }

  public func invalidateConnection() { generation &+= 1 }

  @discardableResult
  public func synchronize(with remote: any CaptureRemote) async throws -> [QueuedCapture] {
    guard !syncing else { return [] }
    syncing = true
    defer { syncing = false }
    let currentGeneration = generation
    guard remote.profileID == scope.profileID, remote.origin == scope.origin else {
      throw WorkspaceRepositoryError.workspaceMismatch
    }
    let identity = try await remote.identity()
    try check(currentGeneration)
    guard identity.workspaceID == scope.workspaceID else {
      throw WorkspaceRepositoryError.workspaceMismatch
    }
    guard identity.hostID == scope.hostID else { throw WorkspaceRepositoryError.hostMismatch }
    guard identity.supportsConditionalWorkspaceWrites, identity.supportsAtomicCapture else {
      throw WorkspaceRepositoryError.unsupportedHost
    }
    var results: [QueuedCapture] = []
    for cached in try captures(recentLimit: 0)
    where cached.state == .queued || cached.state == .sending {
      try check(currentGeneration)
      // Re-read so a cancel/reconciliation in another repository instance wins by revision.
      var value = try require(cached.id, revision: cached.revision)
      guard value.attemptCount < Int.max else { throw WorkspaceRepositoryError.corruptIndex }
      value.state = .sending
      value.attemptCount += 1
      value = try save(value, requiresIdleNoteWrites: true)
      let receipt = try await remote.append(value.operation)
      try check(currentGeneration)
      try validate(receipt, for: value.operation)
      let latest = try require(value.id, revision: value.revision)
      guard latest.state == .sending else { throw WorkspaceRepositoryError.concurrentWrite }
      value.receipt = receipt
      value.state = receipt.outcome == .applied ? .applied : .indeterminate
      results.append(try save(value))
    }
    return results
  }

  private func require(_ id: UUID, revision: Int64) throws -> QueuedCapture {
    guard let value = try capture(id) else { throw CaptureError.missingCapture }
    guard value.revision == revision else { throw WorkspaceRepositoryError.concurrentWrite }
    return value
  }

  private func save(_ value: QueuedCapture, requiresIdleNoteWrites: Bool = false) throws
    -> QueuedCapture
  {
    let key = Self.key(value.id)
    var stored = WorkspaceStoredValue(
      key: key, data: try JSONEncoder().encode(value), updatedAt: clock(), retention: .durable)
    stored.blocksNoteWrites = value.state.blocksNoteWrites
    let committed = try store.commitValues([
      WorkspaceValueMutation(
        key: key, value: stored,
        expectedRevision: value.revision == 0 ? nil : value.revision,
        requiresIdleNoteWrites: requiresIdleNoteWrites)
    ])
    var next = value
    guard let revision = committed[key] else { throw WorkspaceRepositoryError.corruptIndex }
    next.revision = revision
    return next
  }

  private func decode(_ value: WorkspaceStoredValue) throws -> QueuedCapture {
    var capture: QueuedCapture
    do { capture = try JSONDecoder().decode(QueuedCapture.self, from: value.data) } catch {
      throw WorkspaceRepositoryError.corruptIndex
    }
    guard capture.operation.scope == scope, value.key == Self.key(capture.id),
      value.blocksNoteWrites == capture.state.blocksNoteWrites, value.retention == .durable
    else { throw WorkspaceRepositoryError.corruptIndex }
    capture.revision = value.revision
    return capture
  }

  private func validate(_ receipt: CaptureReceipt, for operation: CaptureOperation) throws {
    guard receipt.operationID == operation.id, receipt.workspaceID == scope.workspaceID,
      receipt.hostID == scope.hostID
    else { throw CaptureError.receiptMismatch }
    switch receipt.outcome {
    case .applied:
      guard let note = receipt.note, note.date == operation.localDate, !note.version.isEmpty else {
        throw CaptureError.receiptMismatch
      }
      try WorkspaceRepository.validatePath(note.path)
    case .indeterminate:
      guard let path = receipt.path else { throw CaptureError.receiptMismatch }
      try WorkspaceRepository.validatePath(path)
    }
  }

  private func check(_ current: UInt64) throws {
    try Task.checkCancellation()
    guard current == generation else { throw WorkspaceRepositoryError.connectionChanged }
  }

  private static func key(_ id: UUID) -> String { prefix + id.uuidString }
}
