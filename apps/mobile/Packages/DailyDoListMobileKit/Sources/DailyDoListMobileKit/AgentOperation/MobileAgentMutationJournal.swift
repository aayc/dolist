import DailyDoListAgentCore
import DailyDoListClient
import DailyDoListModels
import Foundation

/// Adapters must use a client whose immutable workspace guard matches this journal's scope.
public protocol AgentMutationRemote: Sendable {
  func health() async throws -> HealthResponse
  func send(_ command: AgentMutationCommand, operationID: String) async throws
    -> AgentMutationResult
  func receipt(_ operationID: String) async throws -> AgentOperationResponse
}

public struct HTTPAgentMutationRemote: AgentMutationRemote {
  private let client: any DaemonClient

  public init(client: HTTPDaemonClient, scope: WorkspaceScope) throws {
    guard client.expectedWorkspaceId == scope.workspaceID,
      client.endpoint.baseURL == scope.origin.url
    else {
      throw WorkspaceRepositoryError.workspaceMismatch
    }
    self.client = client
  }

  public func health() async throws -> HealthResponse { try await client.health() }
  public func send(_ command: AgentMutationCommand, operationID: String) async throws
    -> AgentMutationResult
  { try await command.send(using: client, operationID: operationID) }
  public func receipt(_ operationID: String) async throws -> AgentOperationResponse {
    try await client.agentOperation(operationID)
  }
}

/// There is deliberately no background drain. A restored intent is uncertain, even when the
/// process may have died before sending it; only the daemon's original receipt can resolve it.
public actor MobileAgentMutationJournal: AgentMutationJournal {
  public nonisolated let scope: WorkspaceScope
  private let store: any WorkspaceStateStore
  private let remote: any AgentMutationRemote
  private let clock: @Sendable () -> Date
  private var inFlight: Set<String> = []
  private static let prefix = "agent-operation/"
  private static let slotPrefix = "agent-operation-slot/"

  private typealias Record = AgentMutationRecoveryRecord

  public init(
    rootDirectory: URL, scope: WorkspaceScope, remote: any AgentMutationRemote,
    clock: @escaping @Sendable () -> Date = { Date() }
  ) throws {
    self.scope = scope
    self.remote = remote
    self.clock = clock
    let directory = WorkspaceDirectory.url(root: rootDirectory, scope: scope)
    self.store = try SQLiteWorkspaceIndex(
      url: directory.appendingPathComponent("index.sqlite"), scope: scope)
  }

  public func pending() throws -> [PendingAgentMutation] {
    try records().filter { $0.1.unresolved }.map { $0.1.intent }.sorted {
      $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt
    }
  }

  public func perform(
    _ command: AgentMutationCommand, operationID: String?,
    authorize: @escaping @MainActor @Sendable () -> Bool
  ) async throws -> AgentMutationResult {
    try await verifyHost()
    let existing = try records()
    if let operationID, let previous = existing.first(where: { $0.1.intent.id == operationID }) {
      guard previous.1.intent.command == command else {
        throw AgentMutationError.changedIntent(operationID)
      }
      return try await resolve(operationID)
    }
    if let key = command.exclusionKey,
      let previous = existing.first(where: {
        $0.1.unresolved && $0.1.intent.command.exclusionKey == key
      })
    {
      guard previous.1.intent.command == command else {
        throw AgentMutationError.changedIntent(previous.1.intent.id)
      }
      return try await resolve(previous.1.intent.id)
    }
    let id = operationID ?? UUID().uuidString.lowercased()
    guard !id.isEmpty, id.utf8.count <= 128,
      id.utf8.allSatisfy({
        (48...57).contains($0) || (65...90).contains($0)
          || (97...122).contains($0) || $0 == 45 || $0 == 95
      })
    else { throw AgentMutationError.corruptJournal }
    var record = Record(
      scope: scope, intent: PendingAgentMutation(id: id, command: command, createdAt: clock()))
    let preparedRevision = try prepare(record)
    inFlight.insert(id)
    defer { inFlight.remove(id) }
    guard await authorize() else {
      record.notDispatched = true
      try write(record, replacing: preparedRevision)
      throw AgentMutationError.authorizationChanged
    }
    // Re-read after the main actor hop: namespace retirement fences a prepared action too.
    guard try store.value(Self.prefix + id)?.revision == preparedRevision else {
      throw WorkspaceRepositoryError.concurrentWrite
    }
    do {
      let result = try await remote.send(command, operationID: id)
      record.result = result
      try write(record, replacing: preparedRevision)
      return result
    } catch {
      // The prepared record already preserves an unknown outcome. Even cancellation may mean
      // the daemon acted; retaining it is mandatory, and a subsequent attempt only reads.
      if case DaemonClientError.approvalConflict = error { throw error }
      throw AgentMutationError.uncertain(id)
    }
  }

  public func resolve(_ operationID: String) async throws -> AgentMutationResult {
    guard !inFlight.contains(operationID) else { throw AgentMutationError.uncertain(operationID) }
    guard let (stored, record) = try records().first(where: { $0.1.intent.id == operationID })
    else {
      throw AgentMutationError.corruptJournal
    }
    if let result = record.result { return result }
    if let receipt = record.receipt { return try record.intent.command.decodeReceipt(receipt) }
    guard !record.notDispatched else { throw AgentMutationError.authorizationChanged }
    try await verifyHost()
    let receipt: AgentOperationResponse
    do { receipt = try await remote.receipt(operationID) } catch {
      if (error as? DaemonClientError)?.httpStatus == 404 {
        throw AgentMutationError.uncertain(operationID)
      }
      throw error
    }
    guard receipt.workspaceId == scope.workspaceID, receipt.operationId == operationID else {
      throw AgentMutationError.corruptJournal
    }
    guard receipt.outcome == .applied, let response = receipt.response else {
      throw AgentMutationError.uncertain(operationID)
    }
    var updated = record
    updated.receipt = response
    try write(updated, replacing: stored.revision)
    return try record.intent.command.decodeReceipt(response)
  }

  private func verifyHost() async throws {
    let health = try await remote.health()
    guard health.workspaceId == scope.workspaceID else {
      throw WorkspaceRepositoryError.workspaceMismatch
    }
    guard health.hostId == scope.hostID else { throw WorkspaceRepositoryError.hostMismatch }
    guard health.capabilities?.contains("agent-mutations-v1") == true else {
      throw AgentMutationError.unsupportedHost
    }
  }

  private func records() throws -> [(WorkspaceStoredValue, Record)] {
    try store.values(prefix: Self.prefix).map { stored in
      let record = try Record.decode(stored, scope: scope)
      return (stored, record)
    }
  }

  private func write(_ record: Record, replacing revision: Int64?) throws {
    let key = Self.prefix + record.intent.id
    let value = WorkspaceStoredValue(
      key: key, data: try JSONEncoder().encode(record), updatedAt: clock(),
      retention: record.unresolved ? .durable : .disposable)
    var changes = [
      WorkspaceValueMutation(key: key, value: value, expectedRevision: revision)
    ]
    if !record.unresolved, let exclusion = record.intent.command.exclusionKey {
      let slotKey = Self.slotPrefix + MarkdownCheckpointStore.digest(Data(exclusion.utf8))
      if let slot = try store.value(slotKey) {
        guard String(data: slot.data, encoding: .utf8) == record.intent.id else {
          throw AgentMutationError.corruptJournal
        }
        changes.append(WorkspaceValueMutation(key: slotKey, expectedRevision: slot.revision))
      }
    }
    // Confirmed receipts may leave the cache; the daemon retains their replay protection.
    // Unknown intents and their exclusion slots remain durable and block namespace retirement.
    try store.commitValues(changes)
  }

  private func prepare(_ record: Record) throws -> Int64 {
    let key = Self.prefix + record.intent.id
    var changes = [
      WorkspaceValueMutation(
        key: key,
        value: WorkspaceStoredValue(
          key: key, data: try JSONEncoder().encode(record), updatedAt: clock(), retention: .durable)
      )
    ]
    if let exclusion = record.intent.command.exclusionKey {
      let slotKey = Self.slotPrefix + MarkdownCheckpointStore.digest(Data(exclusion.utf8))
      let slot = try store.value(slotKey)
      if let slot {
        guard let previousID = String(data: slot.data, encoding: .utf8),
          let previous = try records().first(where: { $0.1.intent.id == previousID })
        else { throw AgentMutationError.corruptJournal }
        if previous.1.unresolved { throw AgentMutationError.uncertain(previousID) }
      }
      changes.append(
        WorkspaceValueMutation(
          key: slotKey,
          value: WorkspaceStoredValue(
            key: slotKey, data: Data(record.intent.id.utf8), updatedAt: clock(), retention: .durable
          ),
          expectedRevision: slot?.revision))
    }
    // The slot and intent share the SQLite transaction: two live handles cannot both prepare
    // replacement IDs for the same unresolved action.
    let committed = try store.commitValues(changes)
    guard let revision = committed[Self.prefix + record.intent.id] else {
      throw WorkspaceRepositoryError.corruptIndex
    }
    return revision
  }
}
