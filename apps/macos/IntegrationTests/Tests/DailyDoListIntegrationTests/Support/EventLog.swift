import DailyDoListClient
import DailyDoListModels
import Foundation

/// Records everything a client's event stream delivers so tests can wait for specific items.
final class EventLog: @unchecked Sendable {
  private let lock = NSLock()
  private var recorded: [DaemonStreamItem] = []
  private var consumer: Task<Void, Never>?

  init(_ client: some DaemonClient) {
    let stream = client.events()
    consumer = Task { [weak self] in
      for await item in stream { self?.append(item) }
    }
  }

  deinit { consumer?.cancel() }

  var items: [DaemonStreamItem] { lock.withLock { recorded } }
  /// Position to wait from, so earlier items don't satisfy a later expectation.
  var mark: Int { lock.withLock { recorded.count } }

  private func append(_ item: DaemonStreamItem) {
    lock.withLock { recorded.append(item) }
  }

  /// The first item at or after `from` for which `match` returns a value.
  @MainActor
  func wait<T>(
    from: Int = 0, timeout: Duration = .seconds(60), for description: String,
    _ match: (DaemonStreamItem) -> T?
  ) async throws -> T {
    let deadline = ContinuousClock.now + timeout
    var scanned = from
    while true {
      let items = self.items
      while scanned < items.count {
        if let value = match(items[scanned]) { return value }
        scanned += 1
      }
      if ContinuousClock.now >= deadline {
        let recent = items.suffix(8).map(Self.describe).joined(separator: "\n  ")
        throw FixtureError(
          "Timed out after \(timeout) waiting for \(description). Last items:\n  \(recent)")
      }
      try await Task.sleep(for: .milliseconds(20))
    }
  }

  /// Index of the first item at or after `from` that satisfies `predicate`.
  @MainActor
  func index(
    from: Int = 0, timeout: Duration = .seconds(60), for description: String,
    where predicate: (DaemonStreamItem) -> Bool
  ) async throws -> Int {
    var position = from
    return try await wait(from: from, timeout: timeout, for: description) { item -> Int? in
      defer { position += 1 }
      return predicate(item) ? position : nil
    }
  }

  /// Waits for a server event matched by `match`.
  @MainActor
  func event<T>(
    from: Int = 0, timeout: Duration = .seconds(60), _ description: String,
    _ match: (ServerEvent) -> T?
  ) async throws -> T {
    try await wait(from: from, timeout: timeout, for: description) { item in
      if case .event(let event) = item { return match(event) }
      return nil
    }
  }

  /// Waits until the connection reports `.connected`.
  @MainActor
  func connected(from: Int = 0, timeout: Duration = .seconds(30)) async throws {
    _ = try await wait(from: from, timeout: timeout, for: "connected") { item -> Bool? in
      if case .state(.connected) = item { return true }
      return nil
    }
  }

  private static func describe(_ item: DaemonStreamItem) -> String {
    switch item {
    case .state(let state): "state \(state)"
    case .resync: "resync"
    case .event(let event):
      switch event {
      case .taskRecord(let record): "task.record \(record.status.rawValue) \(record.text)"
      case .threadUpsert(let thread): "thread.upsert \(thread.status.rawValue) \(thread.title)"
      case .approvalUpsert(let approval):
        "approval.upsert \(approval.status.rawValue) \(approval.summary)"
      default: event.type
      }
    }
  }
}
