import AppKit
import DailyDoListUI

/// A tooltip center for tests: virtual time, no event monitors, nothing drawn. Views under test
/// report to it (`.environment(\.tooltipCenter, …)`) instead of the app's shared one.
@MainActor
public enum QuietTooltips {
  public static func makeCenter() -> TooltipCenter {
    TooltipCenter(
      clock: ManualTooltipClock(), events: NoEvents(), presenter: { NoPresenter() },
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
