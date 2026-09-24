import Foundation

/// Exponential backoff with jitter between WebSocket reconnect attempts.
public struct ReconnectBackoff: Sendable {
  /// Delay before the first retry.
  public var initialDelay: Duration
  /// Upper bound of the (un-jittered) delay.
  public var maximumDelay: Duration
  public var multiplier: Double
  /// Relative jitter: each delay is scaled by a random factor in `1 ± jitter`.
  public var jitter: Double
  /// Uniform random source in `0..<1` (injectable for deterministic tests).
  public var random: @Sendable () -> Double

  public init(
    initialDelay: Duration = .milliseconds(250),
    maximumDelay: Duration = .seconds(30),
    multiplier: Double = 2,
    jitter: Double = 0.2,
    random: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) }
  ) {
    self.initialDelay = initialDelay
    self.maximumDelay = maximumDelay
    self.multiplier = multiplier
    self.jitter = jitter
    self.random = random
  }

  /// 0.25 s doubling up to 30 s, ±20 %.
  public static let `default` = ReconnectBackoff()

  /// The delay before retry number `attempt` (1-based).
  public func delay(forAttempt attempt: Int) -> Duration {
    let initial = initialDelay.seconds
    let maximum = maximumDelay.seconds
    let exponent = Double(max(0, attempt - 1))
    let base = min(maximum, initial * pow(max(1, multiplier), exponent))
    let spread = max(0, min(1, jitter))
    let factor = 1 + spread * (2 * random() - 1)
    return .seconds(max(0, base * factor))
  }
}

extension Duration {
  var seconds: Double {
    let (seconds, attoseconds) = components
    return Double(seconds) + Double(attoseconds) / 1e18
  }
}
