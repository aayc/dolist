import AppKit
import DailyDoListUI
import SwiftUI

/// A tooltip center for tests: virtual time, no event monitors, nothing drawn. Views under test
/// report to it (`.environment(\.tooltipCenter, …)`) instead of the app's shared one.
@MainActor
public enum QuietTooltips {
  public static func makeCenter() -> TooltipCenter {
    TooltipCenter(
      clock: ManualScheduler(), events: NoEvents(), presenter: { NoPresenter() },
      reduceMotion: { false }, mouseButtonsDown: { false })
  }

  private final class NoEvents: TooltipEventSource {
    func start(_ handler: @escaping @MainActor (TooltipDismissal) -> Void) {}
    func stop() {}
  }

  private final class NoPresenter: TooltipPresenting {
    func show(_ presentation: TooltipPresentation, animation: TooltipAnimation) {}
    func hide(animation: TooltipAnimation) {}
  }
}

/// Every control with a tooltip under `view` (the `.tooltip` modifier's anchor views).
@MainActor
public func tooltipAnchors(in view: NSView) -> [TooltipAnchorView] {
  (view as? TooltipAnchorView).map { [$0] } ?? []
    + view.subviews.flatMap { tooltipAnchors(in: $0) }
}

/// The tooltip anchors of `view` laid out in an offscreen window of `size`, reporting to a quiet
/// tooltip center.
@MainActor
public func tooltipAnchors(of view: some View, size: CGSize) -> [TooltipAnchorView] {
  let window = Perf.window(
    view.frame(width: size.width, height: size.height)
      .environment(\.tooltipCenter, QuietTooltips.makeCenter()), size: size)
  defer { window.close() }
  for _ in 0..<6 {
    window.render()
    RunLoop.main.run(until: Date().addingTimeInterval(0.02))
  }
  return tooltipAnchors(in: window.contentView!)
}
