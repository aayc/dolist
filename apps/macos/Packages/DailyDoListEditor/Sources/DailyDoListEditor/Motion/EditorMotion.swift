import AppKit
import QuartzCore

/// What the editor's motion depends on: time, the Reduce Motion setting, whether the window is on
/// screen, the frame driver and redrawing. Tests replace it with fakes.
@MainActor
struct MotionEnvironment {
  /// Seconds on a monotonic clock.
  var now: () -> TimeInterval
  /// System Settings → Accessibility → Display → Reduce motion.
  var reduceMotion: () -> Bool
  /// Whether the editor's window is visible (occluded and windowless editors don't animate).
  var isOnScreen: () -> Bool
  var makeTicker: (_ onFrame: @escaping @MainActor () -> Void) -> FrameTicker
  var setNeedsDisplay: (NSRect) -> Void

  /// The real thing for `view`: media time, the system setting, a display link of the view.
  static func live(for view: NSView) -> MotionEnvironment {
    MotionEnvironment(
      now: { CACurrentMediaTime() },
      reduceMotion: { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion },
      isOnScreen: { [weak view] in view?.window?.occlusionState.contains(.visible) ?? false },
      makeTicker: { [weak view] onFrame in DisplayLinkTicker(view: view, onFrame: onFrame) },
      setNeedsDisplay: { [weak view] rect in view?.setNeedsDisplay(rect) })
  }
}

/// Runs the editor's paint-only motion: owns the pure ``MotionState`` and a frame ticker that runs
/// only while a transition plays or a pulsing badge is on screen, and never while idle. Nothing
/// here lays out text; frames only redraw the rects the controller passes to ``invalidate(_:)``.
@MainActor
final class EditorMotion {
  var environment: MotionEnvironment
  /// Called on every frame while the ticker runs.
  var onFrame: (@MainActor () -> Void)?
  private(set) var state = MotionState()
  /// Whether the current document has been drawn. Badges set before that (a note switch) just
  /// show; only badges that come later animate in.
  private(set) var documentShown = false
  private var ticker: FrameTicker?
  /// What the last frame redrew: redrawn again by the next one, in case the thing moved.
  private var lastFrameRects: [NSRect] = []

  init(environment: MotionEnvironment) {
    self.environment = environment
  }

  var isTicking: Bool { ticker?.isRunning ?? false }
  var now: TimeInterval { environment.now() }

  /// Motion is allowed and would be seen.
  var canAnimate: Bool { environment.isOnScreen() && !environment.reduceMotion() }

  // MARK: Events

  func setBadges(_ badges: [EditorBadge]) {
    state.setBadges(badges, now: now, animated: documentShown && canAnimate)
    if state.hasTransitions { startTicker() }
  }

  /// A new document (note switch): nothing carries over, and its first badges won't animate.
  func documentReplaced() {
    state = MotionState()
    documentShown = false
    stopTicker()
  }

  /// Before each draw: the document is now shown. `pulseVisible`: a pulsing badge is in view.
  func willDraw(pulseVisible: @autoclosure () -> Bool) {
    documentShown = true
    if state.hasPulses, !isTicking, pulseVisible() { startTicker() }
  }

  /// Checkboxes the user just toggled to done (offsets of their status characters).
  func checked(statusOffsets: [Int]) {
    guard !statusOffsets.isEmpty, documentShown, canAnimate else { return }
    let now = self.now
    for offset in statusOffsets { state.checked(statusOffset: offset, now: now) }
    startTicker()
  }

  func textDidEdit(location: Int, oldLength: Int, newLength: Int) {
    state.applyEdit(location: location, oldLength: oldLength, newLength: newLength)
  }

  // MARK: Painting

  func paint(for badge: EditorBadge, now: TimeInterval) -> BadgePaint {
    state.paint(for: badge, now: now, pulses: isTicking)
  }

  func checkPaint(statusOffset: Int) -> CheckPaint? {
    state.checking.isEmpty ? nil : state.checkPaint(statusOffset: statusOffset, now: now)
  }

  // MARK: Frames

  /// Ends the transitions that are over (their last frame must already be invalidated).
  func prune(now: TimeInterval) {
    state.prune(now: now)
  }

  /// Ends every transition and stops (Reduce Motion, off screen).
  func finish() {
    state.finishTransitions()
    stopTicker()
  }

  /// Redraws `rects` and whatever the previous frame redrew.
  func invalidate(_ rects: [NSRect]) {
    for rect in lastFrameRects + rects { environment.setNeedsDisplay(rect) }
    lastFrameRects = rects
  }

  func startTicker() {
    guard !isTicking else { return }
    guard canAnimate else {
      state.finishTransitions()
      return
    }
    if ticker == nil {
      ticker = environment.makeTicker { [weak self] in self?.onFrame?() }
    }
    ticker?.start()
  }

  func stopTicker() {
    ticker?.stop()
    for rect in lastFrameRects { environment.setNeedsDisplay(rect) }
    lastFrameRects = []
  }
}
