import AppKit
import DailyDoListUI

/// A tooltip center on virtual time that records what it shows (editor tests never touch the
/// app's shared one).
@MainActor
final class TooltipRecorder {
  let clock = ManualTooltipClock()
  let presenter = Presenter()
  private(set) lazy var center: TooltipCenter = {
    let presenter = presenter
    return TooltipCenter(
      clock: clock, events: Events(), presenter: { presenter }, reduceMotion: { false },
      mouseButtonsDown: { false })
  }()

  @MainActor
  final class Presenter: TooltipPresenting {
    private(set) var shown: TooltipPresentation?
    private(set) var animations: [TooltipAnimation.Kind] = []

    func show(_ presentation: TooltipPresentation, animation: TooltipAnimation) {
      shown = presentation
      animations.append(animation.kind)
    }

    func hide(animation: TooltipAnimation) {
      shown = nil
      animations.append(animation.kind)
    }
  }

  @MainActor
  final class Events: TooltipEventSource {
    func start(_ handler: @escaping @MainActor (TooltipDismissal) -> Void) {}
    func stop() {}
  }
}
