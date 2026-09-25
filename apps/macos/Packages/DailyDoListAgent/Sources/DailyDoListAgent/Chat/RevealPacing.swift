import Foundation

/// How fast agent text types out (the web app's reveal uses the same numbers and cases).
///
/// Each frame reveals `max(1, round(speed × dt))` characters of the backlog (received but not yet
/// shown), where `speed = clamp(backlog / 1 s, 45, 3000)` characters per second: text never trails
/// what arrived by much more than a second, short replies visibly type out, long ones catch up.
enum RevealPacing {
  /// Characters per second while little is left to show.
  static let minimumSpeed: Double = 45
  /// Characters per second however much is waiting.
  static let maximumSpeed: Double = 3_000
  /// The backlog is shown within about this long.
  static let catchUpTime: TimeInterval = 1

  /// Characters per second for `backlog` characters waiting.
  static func speed(backlog: Int) -> Double {
    min(max(Double(backlog) / catchUpTime, minimumSpeed), maximumSpeed)
  }

  /// Characters (grapheme clusters) to reveal in a frame `elapsed` seconds after the last one.
  static func step(backlog: Int, elapsed: TimeInterval) -> Int {
    guard backlog > 0 else { return 0 }
    let dt = elapsed.isFinite ? max(0, elapsed) : 0
    let count = (speed(backlog: backlog) * dt).rounded()
    return min(backlog, max(1, count >= Double(backlog) ? backlog : Int(count)))
  }
}
