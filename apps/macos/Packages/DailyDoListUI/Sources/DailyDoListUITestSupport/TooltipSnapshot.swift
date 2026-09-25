import AppKit
import DailyDoListUI
import SwiftUI

/// A tooltip drawn over a snapshot where the app would show it: the real bubble, placed by the
/// app's rules (`TooltipLayout`) against the window. The panel itself lives in its own window,
/// which offscreen snapshots can't capture.
@MainActor
public struct TooltipSnapshot {
  public var content: TooltipContent
  /// The target's frame in window coordinates (y up).
  public var anchor: NSRect
  public var prefersBelow: Bool

  public init(content: TooltipContent, anchor: NSRect, prefersBelow: Bool) {
    self.content = content
    self.anchor = anchor
    self.prefersBelow = prefersBelow
  }

  /// The tooltip of the control whose tooltip is labeled `label`, the way it shows: its content
  /// and frame, below it in a header, above it elsewhere. `index` picks one of several, counted
  /// from the left.
  public static func of(
    _ label: String, in view: NSView, placement: TooltipPlacement = .automatic, index: Int = 0
  ) -> TooltipSnapshot? {
    let matches = tooltipAnchors(in: view)
      .filter { $0.tooltipContent()?.lines.first?.text == label }
      .sorted { $0.convert($0.bounds, to: nil).minX < $1.convert($1.bounds, to: nil).minX }
    guard matches.indices.contains(index), let content = matches[index].tooltipContent() else {
      return nil
    }
    let target = matches[index]
    let anchor = target.convert(target.bounds, to: nil)
    let windowFrame = CGRect(origin: .zero, size: view.window?.frame.size ?? view.bounds.size)
    return TooltipSnapshot(
      content: content, anchor: anchor,
      prefersBelow: TooltipLayout.prefersBelow(placement, anchor: anchor, windowFrame: windowFrame))
  }

  public enum Failure: Error { case noImage, noContext }

  /// Draws the bubble into `rep`, a capture of a window of `windowSize` points. Rendered without a
  /// window or a run loop turn, so other tests can't run in the middle of it.
  public func draw(into rep: NSBitmapImageRep, windowSize: CGSize) throws {
    let measuring = NSHostingController(rootView: TooltipBubble(content: content))
    let fitting = measuring.sizeThatFits(
      in: CGSize(width: TooltipMetrics.maxWidth, height: 10_000))
    let size = CGSize(width: ceil(fitting.width), height: ceil(fitting.height))
    let placed = TooltipLayout.place(
      size: size, anchor: anchor, bounds: CGRect(origin: .zero, size: windowSize),
      prefersBelow: prefersBelow)
    let pad: CGFloat = 18
    let renderer = ImageRenderer(
      content: TooltipBubble(content: content).frame(width: size.width, height: size.height)
        .padding(pad))
    renderer.scale = CGFloat(rep.pixelsWide) / windowSize.width
    guard let bubble = renderer.cgImage else { throw Failure.noImage }
    guard let context = NSGraphicsContext(bitmapImageRep: rep) else { throw Failure.noContext }
    // Captures differ in units: points (cached displays) or pixels (layer renders, the window
    // server's copy).
    let unit = rep.size.width / windowSize.width
    context.cgContext.draw(
      bubble,
      in: CGRect(
        x: (placed.frame.minX - pad) * unit, y: (placed.frame.minY - pad) * unit,
        width: (size.width + 2 * pad) * unit, height: (size.height + 2 * pad) * unit))
    context.flushGraphics()
  }
}
