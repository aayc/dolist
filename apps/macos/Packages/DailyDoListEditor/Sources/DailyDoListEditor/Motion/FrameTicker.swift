import AppKit
import QuartzCore

/// Calls its frame handler once per display refresh while running.
@MainActor
protocol FrameTicker: AnyObject {
  var isRunning: Bool { get }
  func start()
  func stop()
}

/// A display link of the editor's view (`NSView.displayLink(target:selector:)`), so frames follow
/// the refresh of the screen the editor is on. The link only exists while running.
@MainActor
final class DisplayLinkTicker: FrameTicker {
  private weak var view: NSView?
  private let onFrame: @MainActor () -> Void
  private var link: CADisplayLink?

  init(view: NSView?, onFrame: @escaping @MainActor () -> Void) {
    self.view = view
    self.onFrame = onFrame
  }

  var isRunning: Bool { link != nil }

  func start() {
    guard link == nil, let view else { return }
    let target = DisplayLinkTarget()
    target.ticker = self
    let link = view.displayLink(target: target, selector: #selector(DisplayLinkTarget.step(_:)))
    // The motion is gentle; 60 Hz is plenty and spares ProMotion displays.
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
    link.add(to: .main, forMode: .common)
    self.link = link
  }

  func stop() {
    link?.invalidate()
    link = nil
  }

  fileprivate func step() {
    onFrame()
  }
}

/// The display link's target (a display link retains its target): forwards frames without keeping
/// the ticker alive, and ends the link once the ticker is gone.
@MainActor
private final class DisplayLinkTarget: NSObject {
  weak var ticker: DisplayLinkTicker?

  @objc func step(_ link: CADisplayLink) {
    guard let ticker else {
      link.invalidate()
      return
    }
    ticker.step()
  }
}
