import Foundation

/// Tells the daemon where the user is typing (`editor.activity`) so the orchestrator never jumps
/// on a half-written task. Throttled (leading + trailing, 400 ms); sent on line changes and while
/// typing on the same line.
@MainActor
final class PresenceReporter {
  private var path: String?
  private var line: Int?
  private var lastSent: String?
  private var throttle: Throttle<Position>!
  private let send: @MainActor (String, Int) -> Void

  private struct Position {
    let path: String
    let line: Int
    var key: String { "\(path)\u{0}\(line)" }
  }

  init(
    scheduler: AppScheduler, interval: TimeInterval = 0.4,
    send: @escaping @MainActor (String, Int) -> Void
  ) {
    self.send = send
    throttle = Throttle(scheduler: scheduler, interval: interval) { [weak self] position in
      self?.lastSent = position.key
      self?.send(position.path, position.line)
    }
  }

  func cursorMoved(path: String, line: Int) {
    self.path = path
    self.line = line
    let position = Position(path: path, line: line)
    if lastSent != position.key { throttle.call(position) }
  }

  func edited(path: String) {
    guard self.path == path, let line else { return }
    throttle.call(Position(path: path, line: line))
  }

  func reset() {
    throttle.cancel()
    path = nil
    line = nil
    lastSent = nil
  }
}
