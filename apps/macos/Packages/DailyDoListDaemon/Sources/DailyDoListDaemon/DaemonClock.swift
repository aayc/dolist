import Foundation

/// Time source for polling, backoff and timeouts, injectable so tests run instantly.
public protocol DaemonClock: Sendable {
  var now: ContinuousClock.Instant { get }
  /// Throws `CancellationError` when the calling task is cancelled.
  func sleep(for duration: Duration) async throws
}

/// The real clock.
public struct SystemDaemonClock: DaemonClock {
  public init() {}

  public var now: ContinuousClock.Instant { .now }

  public func sleep(for duration: Duration) async throws {
    try await Task.sleep(for: duration)
  }
}

extension Duration {
  /// Whole seconds, rounded down (for messages).
  var wholeSeconds: Int { Int(components.seconds) }
}
