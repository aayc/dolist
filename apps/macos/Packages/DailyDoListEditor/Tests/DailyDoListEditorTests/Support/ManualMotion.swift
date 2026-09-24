import AppKit
import Foundation

@testable import DailyDoListEditor

/// Hand-driven motion for an offscreen editor: a manual clock and frame ticker, the window "on
/// screen", Reduce Motion off (both switchable), and a record of every rect motion redraws.
@MainActor
final class ManualMotion {
  var now: TimeInterval = 100
  var reduceMotion = false
  var isOnScreen = true
  private(set) var tickers: [ManualTicker] = []
  private(set) var invalidated: [NSRect] = []

  var isTicking: Bool { tickers.last?.isRunning ?? false }

  init(_ editor: EditorHarness) {
    editor.controller.motion.environment = MotionEnvironment(
      now: { [weak self] in self?.now ?? 0 },
      reduceMotion: { [weak self] in self?.reduceMotion ?? true },
      isOnScreen: { [weak self] in self?.isOnScreen ?? false },
      makeTicker: { [weak self] onFrame in
        let ticker = ManualTicker(onFrame: onFrame)
        self?.tickers.append(ticker)
        return ticker
      },
      setNeedsDisplay: { [weak self] rect in self?.invalidated.append(rect) })
  }

  /// Moves the clock forward and delivers one display frame (if the ticker runs).
  func frame(after seconds: TimeInterval = 1.0 / 60) {
    now += seconds
    tickers.last?.fire()
  }

  /// Frames every 1/60 s for `seconds`.
  func run(for seconds: TimeInterval) {
    let frames = Int((seconds * 60).rounded(.up))
    for _ in 0..<frames { frame() }
  }

  func clearInvalidated() {
    invalidated.removeAll()
  }
}

@MainActor
final class ManualTicker: FrameTicker {
  private let onFrame: @MainActor () -> Void
  private(set) var isRunning = false

  init(onFrame: @escaping @MainActor () -> Void) {
    self.onFrame = onFrame
  }

  func start() { isRunning = true }
  func stop() { isRunning = false }

  func fire() {
    if isRunning { onFrame() }
  }
}

extension EditorHarness {
  /// What happens before the text view draws: the document counts as shown (badges set from now on
  /// animate in) and a visible triaging badge starts its pulse.
  func willDraw() {
    controller.textViewWillDraw(textView)
  }
}
