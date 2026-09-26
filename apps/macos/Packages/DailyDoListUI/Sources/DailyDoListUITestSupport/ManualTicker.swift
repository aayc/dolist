import DailyDoListUI
import Foundation

/// A frame ticker the test fires by hand (a manual clock for motion and the chat's reveal).
@MainActor
public final class ManualTicker: FrameTicker {
  public private(set) var isRunning = false
  public private(set) var starts = 0
  private let onFrame: @MainActor (TimeInterval) -> Void

  public init(onFrame: @escaping @MainActor (TimeInterval) -> Void) {
    self.onFrame = onFrame
  }

  public func start() {
    isRunning = true
    starts += 1
  }

  public func stop() { isRunning = false }

  /// Delivers a frame at `timestamp`, if running.
  public func fire(at timestamp: TimeInterval = 0) {
    if isRunning { onFrame(timestamp) }
  }
}
