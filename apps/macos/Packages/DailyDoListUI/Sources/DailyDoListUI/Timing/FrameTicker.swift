import AppKit
import QuartzCore

/// Calls its frame handler once per display refresh while running, with the frame's timestamp
/// (seconds on the media clock).
@MainActor
public protocol FrameTicker: AnyObject {
  var isRunning: Bool { get }
  func start()
  func stop()
}

/// A display link of a view (`NSView.displayLink(target:selector:)`), so frames follow the refresh
/// of the screen the view is on and stop with its window. The link only exists while running.
@MainActor
public final class DisplayLinkTicker: FrameTicker {
  private weak var view: NSView?
  private let onFrame: @MainActor (TimeInterval) -> Void
  private var link: CADisplayLink?

  public init(view: NSView?, onFrame: @escaping @MainActor (TimeInterval) -> Void) {
    self.view = view
    self.onFrame = onFrame
  }

  public var isRunning: Bool { link != nil }

  public func start() {
    guard link == nil, let view else { return }
    let target = DisplayLinkTarget()
    target.ticker = self
    let link = view.displayLink(target: target, selector: #selector(DisplayLinkTarget.step(_:)))
    // Typing and the badges' motion read smoothly at 60 Hz, and ProMotion displays are spared
    // half the frames.
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
    link.add(to: .main, forMode: .common)
    self.link = link
  }

  public func stop() {
    link?.invalidate()
    link = nil
  }

  fileprivate func step(timestamp: TimeInterval) {
    onFrame(timestamp)
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
    ticker.step(timestamp: link.timestamp)
  }
}
