import Foundation

/// Time for deadlines, launch waits and the pauses between synthesized events, injectable so
/// tests run instantly.
public protocol ComputerClock: Sendable {
  var now: ContinuousClock.Instant { get }
  func sleep(for duration: Duration) async throws
}

/// The real clock.
public struct SystemComputerClock: ComputerClock {
  public init() {}

  public var now: ContinuousClock.Instant { .now }

  public func sleep(for duration: Duration) async throws {
    try await Task.sleep(for: duration)
  }
}
