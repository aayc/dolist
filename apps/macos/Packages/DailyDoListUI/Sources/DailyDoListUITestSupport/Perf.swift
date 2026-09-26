import AppKit
import SwiftUI

/// Timing for performance tests: medians in milliseconds, printed as `PERF …`. Budgets hold in
/// the unoptimized test build and scale with `PERF_BUDGET_MULTIPLIER` (CI's runners are slower).
public enum Perf {
  public static let multiplier =
    Double(ProcessInfo.processInfo.environment["PERF_BUDGET_MULTIPLIER"] ?? "") ?? 1

  /// The median of `runs` calls of `body` (given the run's index), in milliseconds.
  @MainActor @discardableResult
  public static func median(_ name: String, runs: Int, _ body: (Int) async throws -> Void)
    async rethrows -> Double
  {
    let clock = ContinuousClock()
    var samples: [Duration] = []
    for i in 0..<runs {
      let start = clock.now
      try await body(i)
      samples.append(start.duration(to: clock.now))
    }
    let median = samples.sorted()[runs / 2] / .milliseconds(1)
    print(String(format: "PERF %@: %.2f ms (median of %d)", name, median, runs))
    return median
  }

  /// `view` in a borderless window off every screen, ordered in (AppKit only builds some
  /// content, like table rows, for windows that are displayed). `render()` lays it out and draws.
  @MainActor
  public static func window(_ view: some View, size: CGSize) -> NSWindow {
    let window = NSWindow(
      contentRect: CGRect(origin: CGPoint(x: -20_000, y: -20_000), size: size),
      styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = NSHostingView(rootView: view)
    window.orderFrontRegardless()
    return window
  }
}

extension NSWindow {
  /// Lays out and draws whatever changed.
  public func render() {
    contentView?.layoutSubtreeIfNeeded()
    displayIfNeeded()
  }
}
