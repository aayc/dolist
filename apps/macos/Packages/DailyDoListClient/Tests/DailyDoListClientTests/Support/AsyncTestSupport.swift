import DailyDoListModels
import Foundation
import Testing
import os

@testable import DailyDoListClient

struct TimeoutError: Error, CustomStringConvertible {
  let description: String
}

/// Polls `condition` until it holds (every few ms), failing after `timeout`.
func waitUntil(
  _ what: @autoclosure () -> String = "condition",
  timeout: Duration = .seconds(5),
  _ condition: () -> Bool
) async throws {
  let clock = ContinuousClock()
  let deadline = clock.now.advanced(by: timeout)
  while !condition() {
    guard clock.now < deadline else {
      throw TimeoutError(description: "timed out waiting for \(what())")
    }
    try await Task.sleep(for: .milliseconds(5))
  }
}

/// Polls `value` until it returns non-nil.
func waitFor<T>(
  _ what: @autoclosure () -> String = "value",
  timeout: Duration = .seconds(5),
  _ value: () -> T?
) async throws -> T {
  var result: T?
  try await waitUntil(what(), timeout: timeout) {
    result = value()
    return result != nil
  }
  guard let result else { throw TimeoutError(description: "timed out waiting for \(what())") }
  return result
}

/// Runs `body` with a deadline, failing the test (instead of hanging) when it doesn't finish.
func withTimeout<T: Sendable>(
  _ timeout: Duration = .seconds(5),
  _ body: @escaping @Sendable () async throws -> T
) async throws -> T {
  try await withThrowingTaskGroup(of: T.self) { group in
    group.addTask { try await body() }
    group.addTask {
      try await Task.sleep(for: timeout)
      throw TimeoutError(description: "timed out after \(timeout)")
    }
    defer { group.cancelAll() }
    guard let first = try await group.next() else { throw TimeoutError(description: "no result") }
    return first
  }
}

/// Records every item of an event stream in the background.
final class StreamRecorder: Sendable {
  private let storage: OSAllocatedUnfairLock<(items: [DaemonStreamItem], finished: Bool)>
  private let task: Task<Void, Never>

  init(_ stream: AsyncStream<DaemonStreamItem>) {
    let storage = OSAllocatedUnfairLock<(items: [DaemonStreamItem], finished: Bool)>(
      initialState: ([], false))
    self.storage = storage
    task = Task {
      for await item in stream { storage.withLock { $0.items.append(item) } }
      storage.withLock { $0.finished = true }
    }
  }

  var items: [DaemonStreamItem] { storage.withLock { $0.items } }
  var finished: Bool { storage.withLock { $0.finished } }
  var states: [ConnectionState] {
    items.compactMap { if case .state(let state) = $0 { state } else { nil } }
  }
  var events: [ServerEvent] {
    items.compactMap { if case .event(let event) = $0 { event } else { nil } }
  }
  var resyncCount: Int { items.filter { $0 == .resync }.count }

  func waitFor(
    _ what: String = "item", timeout: Duration = .seconds(5), _ match: (DaemonStreamItem) -> Bool
  ) async throws {
    try await waitUntil(what, timeout: timeout) { items.contains(where: match) }
  }

  func waitForState(_ state: ConnectionState, timeout: Duration = .seconds(5)) async throws {
    try await waitFor("state \(state)", timeout: timeout) { $0 == .state(state) }
  }

  func waitForFinish(timeout: Duration = .seconds(5)) async throws {
    try await waitUntil("stream to finish", timeout: timeout) { finished }
  }

  func cancel() { task.cancel() }
}

extension ServerEvent {
  static func fromJSON(_ json: String) throws -> ServerEvent {
    try JSONDecoder.daemon.decode(ServerEvent.self, from: Data(json.utf8))
  }
}
