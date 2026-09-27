import Foundation

/// At most one structural request is unresolved in a namespace. The app drains affected edits
/// before invoking it and remaps open editor/history state only after `.applied` is returned.
public actor WorkspaceStructuralCoordinator {
  public nonisolated let scope: WorkspaceScope
  let store: any WorkspaceMaintenanceStore
  let clock: @Sendable () -> Date
  var generation: UInt64 = 0

  public init(
    rootDirectory: URL, scope: WorkspaceScope, clock: @escaping @Sendable () -> Date = { Date() }
  ) throws {
    self.scope = scope
    self.clock = clock
    self.store = try SQLiteWorkspaceIndex(
      url: WorkspaceDirectory.url(root: rootDirectory, scope: scope)
        .appendingPathComponent("index.sqlite"), scope: scope)
  }

  public init(
    scope: WorkspaceScope, store: any WorkspaceMaintenanceStore,
    clock: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.scope = scope
    self.store = store
    self.clock = clock
  }

  public func invalidateConnection() { generation &+= 1 }

  public func unresolved() throws -> [WorkspaceStructuralOperation] {
    try store.valueSummaries().filter { $0.key.hasPrefix("structural/") && $0.blocksNoteWrites }.map
    {
      guard let value = try store.value($0.key) else { throw WorkspaceRepositoryError.corruptIndex }
      return try Self.decode(value, scope: scope)
    }
  }

  @discardableResult
  public func perform(_ action: WorkspaceStructuralAction, with remote: any StructuralRemote)
    async throws -> WorkspaceStructuralOperation
  {
    try action.validate()
    let current = generation
    try await verify(remote, generation: current)
    let prepared = try store.prepareStructural(
      WorkspaceStructuralOperation(
        id: UUID(), scope: scope, action: action,
        startedAt: clock(), state: .attempting, cachedNotes: [], revision: 0))
    do {
      try await remote.perform(action, workspaceID: scope.workspaceID)
      try check(current)
      return try store.resolveStructural(
        prepared.id, revision: prepared.revision, resolution: .applied)
    } catch StructuralRemoteError.rejected {
      return try store.resolveStructural(
        prepared.id, revision: prepared.revision, resolution: .notApplied)
    } catch {
      // Even an interrupted local acknowledgement leaves a durable intent. Never resend a
      // rename/delete because it might already have succeeded on a host without receipts.
      return try store.resolveStructural(prepared.id, revision: prepared.revision, resolution: nil)
    }
  }

  /// Invoke only after fresh remote inspection and an explicit user choice. This changes local
  /// metadata only; it never repeats the structural request. Do not infer a move from equal text.
  @discardableResult
  public func resolve(
    _ id: UUID, revision: Int64, as resolution: StructuralResolution,
    with remote: any StructuralRemote
  ) async throws -> WorkspaceStructuralOperation {
    let current = generation
    try await verify(remote, generation: current)
    return try store.resolveStructural(id, revision: revision, resolution: resolution)
  }

  private func verify(_ remote: any StructuralRemote, generation: UInt64) async throws {
    guard remote.profileID == scope.profileID, remote.origin == scope.origin else {
      throw WorkspaceRepositoryError.workspaceMismatch
    }
    let identity = try await remote.identity()
    try check(generation)
    guard identity.workspaceID == scope.workspaceID else {
      throw WorkspaceRepositoryError.workspaceMismatch
    }
    guard identity.hostID == scope.hostID else { throw WorkspaceRepositoryError.hostMismatch }
    guard identity.supportsConditionalWorkspaceWrites else {
      throw WorkspaceRepositoryError.unsupportedHost
    }
  }

  private func check(_ current: UInt64) throws {
    try Task.checkCancellation()
    guard current == generation else { throw WorkspaceRepositoryError.connectionChanged }
  }

  static func decode(_ value: WorkspaceStoredValue, scope: WorkspaceScope) throws
    -> WorkspaceStructuralOperation
  {
    var operation: WorkspaceStructuralOperation
    do {
      operation = try JSONDecoder().decode(WorkspaceStructuralOperation.self, from: value.data)
    } catch { throw WorkspaceRepositoryError.corruptIndex }
    guard operation.scope == scope, value.key == "structural/" + operation.id.uuidString,
      value.blocksNoteWrites == operation.state.unresolved
    else { throw WorkspaceRepositoryError.corruptIndex }
    operation.revision = value.revision
    return operation
  }
}
