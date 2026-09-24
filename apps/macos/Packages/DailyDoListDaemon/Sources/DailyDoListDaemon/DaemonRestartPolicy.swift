import Foundation

/// When to restart a daemon that went away, and when to give up.
///
/// Failures (unexpected exits and failed relaunches) are counted within a sliding `window`. The
/// n-th failure in the window waits `initialDelay × 2^(n-1)` (capped at `maxDelay`) before the
/// next attempt; reaching `maxFailures` gives up. The defaults (1, 2, 4, 8 s, give up at the
/// fifth failure within two minutes) keep a crash-looping daemon from spinning while riding out
/// one-off crashes indefinitely.
public struct DaemonRestartPolicy: Hashable, Sendable {
  public var initialDelay: Duration
  public var maxDelay: Duration
  public var maxFailures: Int
  public var window: Duration

  public init(
    initialDelay: Duration = .seconds(1),
    maxDelay: Duration = .seconds(30),
    maxFailures: Int = 5,
    window: Duration = .seconds(120)
  ) {
    self.initialDelay = initialDelay
    self.maxDelay = maxDelay
    self.maxFailures = max(1, maxFailures)
    self.window = window
  }

  /// Backoff before the next attempt after the `attempt`-th failure (1-based) in the window.
  public func delay(forAttempt attempt: Int) -> Duration {
    let doublings = min(max(attempt - 1, 0), 30)
    var delay = initialDelay
    for _ in 0..<doublings {
      delay *= 2
      if delay >= maxDelay { return maxDelay }
    }
    return min(delay, maxDelay)
  }
}

/// Timestamps of recent failures, for `DaemonRestartPolicy`.
struct FailureHistory: Sendable {
  private var failures: [ContinuousClock.Instant] = []

  /// Records a failure at `now` and returns how many fall within `window` (including this one).
  mutating func record(at now: ContinuousClock.Instant, window: Duration) -> Int {
    failures.append(now)
    failures.removeAll { now - $0 > window }
    return failures.count
  }

  mutating func reset() { failures.removeAll() }
}
