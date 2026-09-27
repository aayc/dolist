import DailyDoListModels
import Foundation

public struct CachedWorkspaceValue<Value: Codable & Sendable>: Sendable {
  public let value: Value
  public let revision: Int64
  public let updatedAt: Date
}

public enum ComposerDestination: Codable, Hashable, Sendable {
  case orchestrator
  case thread(String)

  var key: String {
    switch self {
    case .orchestrator: "composer/orchestrator"
    case .thread(let id): "composer/thread/" + MarkdownCheckpointStore.digest(Data(id.utf8))
    }
  }
}

public struct ComposerDraft: Sendable {
  public let destination: ComposerDestination
  public let text: String
  /// Zero means no draft has ever been saved. Clearing keeps a revisioned tombstone.
  public let revision: Int64
}

public struct CachedNotification: Codable, Hashable, Sendable {
  public var id: String
  public var notification: RoutineNotification
  public var delivered: Bool

  public init(id: String, notification: RoutineNotification, delivered: Bool = false) {
    self.id = id
    self.notification = notification
    self.delivered = delivered
  }
}

public struct NotificationCache: Codable, Sendable {
  public var cursor: String?
  public var items: [CachedNotification]
  /// Bounded deduplication history outlives the shorter visible notification list.
  public var seenIDs: [String]
}

public struct WorkspaceCacheUsage: Sendable {
  public let disposableBytes: Int
  public let protectedBytes: Int
  public let budgetBytes: Int
}

/// Typed, disposable metadata and durable composer/notification state share the repository's
/// SQLite namespace. No method sends messages or queues an approval/control action.
public actor WorkspaceCache {
  public nonisolated let scope: WorkspaceScope
  let store: any WorkspaceStateStore
  let clock: @Sendable () -> Date
  let budgetBytes: Int

  public init(
    rootDirectory: URL, scope: WorkspaceScope, budgetBytes: Int = 8 * 1_024 * 1_024,
    clock: @escaping @Sendable () -> Date = { Date() }
  ) throws {
    self.scope = scope
    let directory = WorkspaceDirectory.url(root: rootDirectory, scope: scope)
    self.store = try SQLiteWorkspaceIndex(
      url: directory.appendingPathComponent("index.sqlite"), scope: scope)
    self.clock = clock
    self.budgetBytes = max(0, budgetBytes)
  }

  public init(
    scope: WorkspaceScope, store: any WorkspaceStateStore, budgetBytes: Int,
    clock: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.scope = scope
    self.store = store
    self.budgetBytes = max(0, budgetBytes)
    self.clock = clock
  }

  public func settings() throws -> CachedWorkspaceValue<AppSettings>? { try read("cache/settings") }
  public func tree() throws -> CachedWorkspaceValue<VaultTreeResponse>? { try read("cache/tree") }
  public func recentThreads() throws -> CachedWorkspaceValue<[ThreadSummary]>? {
    try read("cache/threads")
  }
  public func notifications() throws -> CachedWorkspaceValue<NotificationCache>? {
    try read("notifications")
  }

  /// Capture the revision before starting a fetch. An older response cannot replace a newer
  /// event/response that has since updated the same cache entry.
  @discardableResult
  public func storeSettings(_ value: AppSettings, replacing revision: Int64?) throws -> Int64 {
    try writeCache(value, key: "cache/settings", replacing: revision)
  }

  @discardableResult
  public func storeTree(_ value: VaultTreeResponse, replacing revision: Int64?) throws -> Int64 {
    try writeCache(value, key: "cache/tree", replacing: revision)
  }

  @discardableResult
  public func storeRecentThreads(_ value: [ThreadSummary], replacing revision: Int64?) throws
    -> Int64
  {
    try writeCache(value, key: "cache/threads", replacing: revision)
  }

  public func composer(_ destination: ComposerDestination) throws -> ComposerDraft {
    let existing: CachedWorkspaceValue<String>? = try read(destination.key)
    return ComposerDraft(
      destination: destination, text: existing?.value ?? "", revision: existing?.revision ?? 0)
  }

  /// Empty text is an explicit clear, not deletion of the revision. A delayed pre-send save
  /// therefore cannot recreate the draft after the UI acknowledged clearing it.
  @discardableResult
  public func saveComposer(
    _ destination: ComposerDestination, text: String, replacing revision: Int64
  ) throws -> ComposerDraft {
    let next = try write(
      text, key: destination.key, retention: .durable, replacing: revision == 0 ? nil : revision)
    return ComposerDraft(destination: destination, text: text, revision: next)
  }

  /// Cursor advancement and deduplication are one transaction. IDs must come from durable
  /// server notification decisions, not inferred routine status or wall-clock guesses.
  @discardableResult
  public func mergeNotifications(
    _ items: [CachedNotification], cursor: String?, replacing revision: Int64?
  ) throws -> Int64 {
    let existing = try notifications()
    guard existing?.revision == revision else { throw WorkspaceRepositoryError.concurrentWrite }
    var state = existing?.value ?? NotificationCache(items: [], seenIDs: [])
    var seen = Set(state.seenIDs)
    for item in items where !item.id.isEmpty {
      if seen.insert(item.id).inserted {
        state.seenIDs.append(item.id)
        state.items.append(item)
      }
    }
    state.cursor = cursor
    state.items = Array(state.items.suffix(500))
    state.seenIDs = Array(state.seenIDs.suffix(2_000))
    return try write(state, key: "notifications", retention: .durable, replacing: revision)
  }

  @discardableResult
  public func markNotificationsDelivered(_ ids: Set<String>, replacing revision: Int64) throws
    -> Int64
  {
    guard let current = try notifications(), current.revision == revision else {
      throw WorkspaceRepositoryError.concurrentWrite
    }
    var state = current.value
    for index in state.items.indices where ids.contains(state.items[index].id) {
      state.items[index].delivered = true
    }
    return try write(state, key: "notifications", retention: .durable, replacing: revision)
  }

  /// Evicts only explicitly disposable payloads, oldest fetch first. Plain markdown, immutable
  /// bases/recovery files and durable values are outside this disposable byte budget.
  @discardableResult
  public func trim() throws -> WorkspaceCacheUsage {
    let values = try store.valueSummaries()
    let disposable = values.filter { $0.retention == .disposable }.sorted {
      $0.updatedAt == $1.updatedAt ? $0.key < $1.key : $0.updatedAt < $1.updatedAt
    }
    var bytes = disposable.reduce(0) { $0 + $1.byteCount }
    var removals: [WorkspaceValueMutation] = []
    for value in disposable where bytes > budgetBytes {
      bytes -= value.byteCount
      removals.append(WorkspaceValueMutation(key: value.key, expectedRevision: value.revision))
    }
    if !removals.isEmpty { try store.commitValues(removals) }
    return WorkspaceCacheUsage(
      disposableBytes: bytes,
      protectedBytes: values.filter { $0.retention == .durable }.reduce(0) { $0 + $1.byteCount },
      budgetBytes: budgetBytes)
  }

  private func read<Value: Codable & Sendable>(_ key: String) throws -> CachedWorkspaceValue<Value>?
  {
    guard let value = try store.value(key) else { return nil }
    let decoded: Value
    do { decoded = try JSONDecoder().decode(Value.self, from: value.data) } catch {
      throw WorkspaceRepositoryError.corruptIndex
    }
    return CachedWorkspaceValue(
      value: decoded, revision: value.revision, updatedAt: value.updatedAt)
  }

  private func writeCache<Value: Encodable>(_ value: Value, key: String, replacing revision: Int64?)
    throws -> Int64
  {
    let next = try write(value, key: key, retention: .disposable, replacing: revision)
    _ = try trim()
    return next
  }

  private func write<Value: Encodable>(
    _ value: Value, key: String, retention: WorkspaceValueRetention,
    replacing revision: Int64?
  ) throws -> Int64 {
    let record = WorkspaceStoredValue(
      key: key, data: try JSONEncoder().encode(value), updatedAt: clock(), retention: retention)
    try store.commitValues([
      WorkspaceValueMutation(key: key, value: record, expectedRevision: revision)
    ])
    return (revision ?? 0) + 1
  }
}
