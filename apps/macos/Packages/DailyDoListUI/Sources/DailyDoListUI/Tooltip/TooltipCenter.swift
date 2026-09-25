import AppKit

/// The app's one tooltip. Targets report the pointer arriving and leaving; the center decides when
/// the tooltip opens and how it moves:
///
/// - It opens after the pointer rests on a target for ``TooltipMetrics/openDelay``.
/// - Warm mode: while a tooltip shows, or within ``TooltipMetrics/warmWindow`` of it starting to
///   hide, another target's tooltip shows at once and glides over from the last one.
/// - Leaving the target fades it out. A mouse down, key down, scroll, the window resigning key or
///   the app deactivating hide it at once (the next one waits for the delay again), and the target
///   under the pointer stays quiet until the pointer leaves it.
/// - Nothing opens while a mouse button is held. With Reduce Motion it only fades.
@MainActor
public final class TooltipCenter {
  public static let shared = TooltipCenter()

  private enum Phase {
    case idle
    case pending(TooltipTarget, TooltipTimer)
    case showing(TooltipTarget)
  }

  private let clock: TooltipClock
  private let events: TooltipEventSource
  private let makePresenter: @MainActor () -> TooltipPresenting
  private lazy var presenter: TooltipPresenting = makePresenter()
  private let reduceMotion: @MainActor () -> Bool
  private let mouseButtonsDown: @MainActor () -> Bool

  private var phase: Phase = .idle
  private weak var hovered: TooltipTarget?
  /// The target under the pointer when a dismissal hid its tooltip; quiet until the pointer leaves.
  private var suppressed: ObjectIdentifier?
  /// When the last tooltip started fading out (warm mode lasts a while after that).
  private var hideStartedAt: TimeInterval?
  private var warmTimer: TooltipTimer?
  private(set) var isListening = false

  public init(
    clock: TooltipClock = LiveTooltipClock(),
    events: TooltipEventSource = LiveTooltipEvents(),
    presenter: @escaping @MainActor () -> TooltipPresenting = { TooltipPanelPresenter() },
    reduceMotion: @escaping @MainActor () -> Bool = {
      NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    },
    mouseButtonsDown: @escaping @MainActor () -> Bool = { NSEvent.pressedMouseButtons != 0 }
  ) {
    self.clock = clock
    self.events = events
    self.makePresenter = presenter
    self.reduceMotion = reduceMotion
    self.mouseButtonsDown = mouseButtonsDown
  }

  /// The target whose tooltip is on screen.
  public var shownTarget: TooltipTarget? {
    if case .showing(let target) = phase { return target }
    return nil
  }

  /// The target waiting for the open delay.
  public var pendingTarget: TooltipTarget? {
    if case .pending(let target, _) = phase { return target }
    return nil
  }

  // MARK: Targets

  public func pointerEntered(_ target: TooltipTarget) {
    // A target with nothing to say (text that isn't truncated, a disabled control) isn't one: a
    // tooltip of the view around it stays.
    guard target.tooltipHasContent() else { return }
    hovered = target
    defer { updateListening() }
    guard suppressed != ObjectIdentifier(target), !mouseButtonsDown() else { return }
    switch phase {
    case .showing(let current):
      if current !== target { showNow(target) }
    case .pending(let current, let timer):
      guard current !== target else { return }
      timer.cancel()
      phase = .idle
      schedule(target)
    case .idle:
      if isWarm {
        showNow(target)
      } else {
        schedule(target)
      }
    }
  }

  public func pointerExited(_ target: TooltipTarget) {
    if hovered === target { hovered = nil }
    if suppressed == ObjectIdentifier(target) { suppressed = nil }
    switch phase {
    case .pending(let current, let timer) where current === target:
      timer.cancel()
      phase = .idle
    case .showing(let current) where current === target:
      beginHiding()
    default:
      break
    }
    updateListening()
  }

  /// The target's content or frame changed: a shown tooltip follows it in place.
  public func targetChanged(_ target: TooltipTarget) {
    guard case .showing(let current) = phase, current === target else { return }
    guard let content = target.tooltipContent(), let anchor = target.tooltipScreenRect else {
      beginHiding()
      updateListening()
      return
    }
    presenter.show(
      TooltipPresentation(
        content: content, anchor: anchor, window: target.tooltipWindow,
        placement: target.tooltipPlacement),
      animation: .immediate)
  }

  /// The target went away (removed from its window, hidden): its tooltip goes at once.
  public func targetRemoved(_ target: TooltipTarget) {
    if hovered === target { hovered = nil }
    if suppressed == ObjectIdentifier(target) { suppressed = nil }
    switch phase {
    case .pending(let current, let timer) where current === target:
      timer.cancel()
      phase = .idle
    case .showing(let current) where current === target:
      presenter.hide(animation: .immediate)
      phase = .idle
      endWarmMode()
    default:
      break
    }
    updateListening()
  }

  /// Hides the tooltip at once, without its exit animation (a click, a key, a scroll…).
  public func dismiss(_ reason: TooltipDismissal) {
    if let hovered { suppressed = ObjectIdentifier(hovered) }
    switch phase {
    case .pending(_, let timer): timer.cancel()
    case .showing: presenter.hide(animation: .immediate)
    case .idle: if hideStartedAt != nil { presenter.hide(animation: .immediate) }
    }
    phase = .idle
    endWarmMode()
    updateListening()
  }

  // MARK: Private

  private var isWarm: Bool {
    guard let hideStartedAt else { return false }
    return clock.now - hideStartedAt < TooltipMetrics.warmWindow
  }

  /// Warm mode: the tooltip moves to `target` at once.
  private func showNow(_ target: TooltipTarget) {
    guard let content = target.tooltipContent() else {
      if case .showing = phase { beginHiding() }
      return
    }
    present(target, content, .glide(reduced: reduceMotion()))
  }

  private func schedule(_ target: TooltipTarget) {
    let timer = clock.schedule(after: TooltipMetrics.openDelay) { [weak self, weak target] in
      guard let self, let target else { return }
      self.openDelayElapsed(target)
    }
    phase = .pending(target, timer)
  }

  private func openDelayElapsed(_ target: TooltipTarget) {
    guard case .pending(let current, _) = phase, current === target else { return }
    phase = .idle
    defer { updateListening() }
    guard hovered === target, !mouseButtonsDown(), let content = target.tooltipContent() else {
      return
    }
    present(target, content, .enter(reduced: reduceMotion()))
  }

  private func present(
    _ target: TooltipTarget, _ content: TooltipContent, _ animation: TooltipAnimation
  ) {
    guard let anchor = target.tooltipScreenRect else {
      if case .showing = phase { beginHiding() }
      return
    }
    presenter.show(
      TooltipPresentation(
        content: content, anchor: anchor, window: target.tooltipWindow,
        placement: target.tooltipPlacement),
      animation: animation)
    phase = .showing(target)
    endWarmMode()
  }

  private func beginHiding() {
    presenter.hide(animation: .exit(reduced: reduceMotion()))
    phase = .idle
    hideStartedAt = clock.now
    warmTimer?.cancel()
    warmTimer = clock.schedule(after: TooltipMetrics.warmWindow) { [weak self] in
      guard let self else { return }
      self.warmTimer = nil
      self.hideStartedAt = nil
      self.updateListening()
    }
  }

  private func endWarmMode() {
    hideStartedAt = nil
    warmTimer?.cancel()
    warmTimer = nil
  }

  /// Hide triggers are watched only while a tooltip is pending, shown or warm.
  private func updateListening() {
    let active: Bool
    if case .idle = phase { active = hideStartedAt != nil } else { active = true }
    if active, !isListening {
      isListening = true
      events.start { [weak self] reason in self?.dismiss(reason) }
    } else if !active, isListening {
      isListening = false
      events.stop()
    }
  }
}
