import AppKit
import QuartzCore
import SwiftUI

/// Shows the tooltip in a borderless, non-activating panel that ignores the mouse. The panel is a
/// child of the target's window, so panes don't clip it and it can reach past the window's edge
/// like a native tooltip. Core Animation moves the bubble inside it.
@MainActor
public final class TooltipPanelPresenter: TooltipPresenting {
  let panel: NSPanel
  private let container: NSView
  private let hosting: NSHostingController<TooltipPanelContent>
  private let clock: AppScheduler
  /// The surface (without the shadow margin) in screen coordinates, last time it was shown.
  private(set) var surfaceFrame: NSRect?
  /// Ordered in (possibly fading out).
  private(set) var isVisible = false
  private(set) var isBelow = false
  /// Bumped by every show and hide, so a finished fade can't order out a newer tooltip.
  private var generation = 0

  public init(clock: AppScheduler = LiveScheduler.shared) {
    self.clock = clock
    panel = TooltipPanel(
      contentRect: NSRect(x: 0, y: 0, width: 10, height: 10),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.ignoresMouseEvents = true
    panel.level = Self.level
    panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
    panel.isReleasedWhenClosed = false
    panel.hidesOnDeactivate = true
    panel.animationBehavior = .none
    panel.isExcludedFromWindowsMenu = true
    panel.appearance = NSAppearance(named: .darkAqua)
    panel.setAccessibilityElement(false)
    container = NSView(frame: panel.contentLayoutRect)
    container.wantsLayer = true
    panel.contentView = container
    hosting = NSHostingController(
      rootView: TooltipPanelContent(content: TooltipContent("")))
    hosting.sizingOptions = []
    hosting.view.wantsLayer = true
    container.addSubview(hosting.view)
  }

  // MARK: TooltipPresenting

  public func show(_ presentation: TooltipPresentation, animation: TooltipAnimation) {
    generation += 1
    hosting.rootView = TooltipPanelContent(content: presentation.content)
    let insets = TooltipPanelContent.shadowInsets
    let fitting = hosting.sizeThatFits(
      in: CGSize(
        width: TooltipMetrics.maxWidth + insets.left + insets.right, height: 10_000))
    let size = CGSize(
      width: ceil(fitting.width - insets.left - insets.right),
      height: ceil(fitting.height - insets.top - insets.bottom))
    let result = TooltipLayout.place(
      size: size, anchor: presentation.anchor, bounds: Self.bounds(for: presentation),
      prefersBelow: TooltipLayout.prefersBelow(
        presentation.placement, anchor: presentation.anchor,
        windowFrame: presentation.window?.frame))
    let previous = isVisible || animation.kind == .glide ? surfaceFrame : nil
    let glidesFrom = animation.kind == .glide && !animation.reduced ? previous : nil
    let kind: TooltipAnimation.Kind =
      animation.kind == .glide && previous == nil ? .enter : animation.kind
    let wasVisible = isVisible

    let panelSurface = glidesFrom.map { result.frame.union($0) } ?? result.frame
    let panelFrame = Self.expand(panelSurface, by: insets)
    panel.setFrame(panelFrame, display: false)
    container.frame = NSRect(origin: .zero, size: panelFrame.size)
    hosting.view.frame = Self.expand(result.frame, by: insets).offsetBy(
      dx: -panelFrame.minX, dy: -panelFrame.minY)
    hosting.view.layoutSubtreeIfNeeded()
    let layer = hosting.view.layer
    let opacity = wasVisible ? (layer?.presentation()?.opacity ?? layer?.opacity ?? 1) : 0
    layer?.removeAllAnimations()
    // Transparent while it's ordered in, so no frame shows it before its animation starts.
    if !wasVisible { hosting.view.alphaValue = 0 }
    attach(to: presentation.window)
    surfaceFrame = result.frame
    isBelow = result.isBelow
    isVisible = true

    guard let layer else {
      hosting.view.alphaValue = 1
      return
    }
    let position = layer.position
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    hosting.view.alphaValue = 1
    switch kind {
    case .enter:
      let duration = animation.duration
      layer.add(Self.basic("opacity", from: opacity, duration: duration), forKey: "opacity")
      if !animation.reduced {
        let slide = result.isBelow ? TooltipMetrics.slide : -TooltipMetrics.slide
        let start = CGPoint(x: position.x, y: position.y + slide)
        layer.add(
          Self.basic("position", from: NSValue(point: start), duration: duration),
          forKey: "position")
        layer.add(
          Self.basic(
            "transform", from: NSValue(caTransform3D: Self.scaleAroundCenter(layer)),
            duration: duration),
          forKey: "transform")
      }
    case .glide:
      if opacity < 1 {
        layer.add(
          Self.basic("opacity", from: opacity, duration: animation.duration), forKey: "opacity")
      }
      if let glidesFrom {
        let start = CGPoint(
          x: position.x + glidesFrom.minX - result.frame.minX,
          y: position.y + glidesFrom.minY - result.frame.minY)
        layer.add(
          Self.basic("position", from: NSValue(point: start), duration: animation.duration),
          forKey: "position")
      }
    case .exit, .none:
      break
    }
    CATransaction.commit()
  }

  public func hide(animation: TooltipAnimation) {
    guard isVisible else { return }
    generation += 1
    let generation = self.generation
    guard animation.kind == .exit, animation.duration > 0, let layer = hosting.view.layer else {
      hosting.view.layer?.removeAllAnimations()
      orderOut()
      return
    }
    let opacity = layer.presentation()?.opacity ?? layer.opacity
    layer.removeAllAnimations()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    hosting.view.alphaValue = 0
    let fade = Self.basic("opacity", from: opacity, duration: animation.duration)
    fade.timingFunction = CAMediaTimingFunction(name: .easeIn)
    layer.add(fade, forKey: "opacity")
    CATransaction.commit()
    _ = clock.schedule(after: animation.duration) { [weak self] in
      guard let self, self.generation == generation else { return }
      self.orderOut()
    }
  }

  /// The bubble's layer, where the animations run (tests).
  var bubbleLayer: CALayer? { hosting.view.layer }

  // MARK: Private

  private func attach(to window: NSWindow?) {
    if let parent = panel.parent, parent !== window { parent.removeChildWindow(panel) }
    if let window, panel.parent == nil {
      window.addChildWindow(panel, ordered: .above)
      // Adding a child gives it the parent's level; a tooltip floats above the app's other windows.
      panel.level = Self.level
    }
    if !panel.isVisible { panel.orderFront(nil) }
  }

  private static let level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.helpWindow)))

  private func orderOut() {
    panel.parent?.removeChildWindow(panel)
    panel.orderOut(nil)
    isVisible = false
  }

  /// Where the tooltip may go: the target's screen (without the menu bar and Dock), else the
  /// window (an offscreen window has no screen).
  private static func bounds(for presentation: TooltipPresentation) -> NSRect {
    let screen =
      presentation.window?.screen
      ?? NSScreen.screens.first { $0.frame.intersects(presentation.anchor) }
    return screen?.visibleFrame ?? presentation.window?.frame
      ?? presentation.anchor.insetBy(dx: -1_000, dy: -1_000)
  }

  private static func expand(_ rect: NSRect, by insets: NSEdgeInsets) -> NSRect {
    NSRect(
      x: rect.minX - insets.left, y: rect.minY - insets.bottom,
      width: rect.width + insets.left + insets.right,
      height: rect.height + insets.top + insets.bottom)
  }

  /// ``TooltipMetrics/enterScale`` about the layer's center, whatever its anchor point.
  private static func scaleAroundCenter(_ layer: CALayer) -> CATransform3D {
    let scale = TooltipMetrics.enterScale
    let dx = (0.5 - layer.anchorPoint.x) * layer.bounds.width
    let dy = (0.5 - layer.anchorPoint.y) * layer.bounds.height
    var transform = CATransform3DMakeTranslation(dx, dy, 0)
    transform = CATransform3DScale(transform, scale, scale, 1)
    return CATransform3DTranslate(transform, -dx, -dy, 0)
  }

  /// An ease-out animation from `value` to the layer's current (model) value.
  private static func basic(_ keyPath: String, from value: Any, duration: TimeInterval)
    -> CABasicAnimation
  {
    let animation = CABasicAnimation(keyPath: keyPath)
    animation.fromValue = value
    animation.duration = duration
    animation.timingFunction = CAMediaTimingFunction(name: .easeOut)
    return animation
  }
}

/// Never key, never main: showing it doesn't take focus from anything.
private final class TooltipPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}
