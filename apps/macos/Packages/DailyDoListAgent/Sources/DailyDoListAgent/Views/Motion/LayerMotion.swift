import AppKit
import QuartzCore
import SwiftUI

/// How the typing caret looks: blinking gently, or still (Reduce Motion).
enum CaretMode: Hashable, Sendable {
  case blinking, steady

  init(reduceMotion: Bool) {
    self = reduceMotion ? .steady : .blinking
  }
}

/// The chat's looping animations, run by Core Animation on the render server: they cost the app
/// nothing per frame and stop with the layer (views that loop only exist while the agent works).
@MainActor
enum LayerMotion {
  static let caretBlinkKey = "ddl.caret.blink"
  static let pulseKey = "ddl.pulse"
  static let dotsKey = "ddl.dots"

  /// The caret fades out and back every 1.1 s, after resting solid for `delay` (it stays solid
  /// while text arrives: each move restarts the delay).
  static func caretBlink(delay: CFTimeInterval, on layer: CALayer) -> CAAnimation {
    let blink = CABasicAnimation(keyPath: "opacity")
    blink.fromValue = 1
    blink.toValue = 0.15
    blink.duration = 0.55
    blink.autoreverses = true
    blink.repeatCount = .infinity
    blink.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    blink.beginTime = layer.convertTime(CACurrentMediaTime(), from: nil) + delay
    blink.isRemovedOnCompletion = false
    return blink
  }

  /// A soft halo growing out of a dot and fading, every 1.6 s.
  static func pulse() -> CAAnimation {
    let scale = CABasicAnimation(keyPath: "transform.scale")
    scale.fromValue = 1
    scale.toValue = 2.6
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 0.45
    fade.toValue = 0
    let group = CAAnimationGroup()
    group.animations = [scale, fade]
    group.duration = 1.6
    group.repeatCount = .infinity
    group.timingFunction = CAMediaTimingFunction(name: .easeOut)
    group.isRemovedOnCompletion = false
    return group
  }

  /// One of three dots rising and brightening in turn (`index` 0…2), every 1.2 s.
  static func dot(index: Int, on layer: CALayer) -> CAAnimation {
    let lift = CAKeyframeAnimation(keyPath: "transform.translation.y")
    lift.values = [0, 2.5, 0, 0]
    let glow = CAKeyframeAnimation(keyPath: "opacity")
    glow.values = [0.35, 1, 0.35, 0.35]
    for animation in [lift, glow] {
      animation.keyTimes = [0, 0.22, 0.44, 1]
      animation.timingFunctions = Array(
        repeating: CAMediaTimingFunction(name: .easeInEaseOut), count: 3)
    }
    let group = CAAnimationGroup()
    group.animations = [lift, glow]
    group.duration = 1.2
    group.repeatCount = .infinity
    group.beginTime = layer.convertTime(CACurrentMediaTime(), from: nil) + Double(index) * 0.16
    group.fillMode = .backwards
    group.isRemovedOnCompletion = false
    return group
  }

  /// `color` for `view`'s appearance, for a layer.
  static func cgColor(_ color: NSColor, in view: NSView) -> CGColor {
    var resolved = color.cgColor
    view.effectiveAppearance.performAsCurrentDrawingAppearance { resolved = color.cgColor }
    return resolved
  }

  /// A layer that never animates implicitly (frames and colors change at once).
  static func stillLayer() -> CALayer {
    let layer = CALayer()
    layer.actions = [
      "position": NSNull(), "bounds": NSNull(), "frame": NSNull(), "backgroundColor": NSNull(),
      "opacity": NSNull(), "hidden": NSNull(), "transform": NSNull(),
    ]
    return layer
  }
}

// MARK: - Caret

/// A thin caret on its own line (where typing text ends in a code block or a table, or before the
/// first character arrives).
struct SoftCaret: NSViewRepresentable {
  let mode: CaretMode

  func makeNSView(context: Context) -> SoftCaretView { SoftCaretView() }

  func updateNSView(_ view: SoftCaretView, context: Context) {
    view.mode = mode
  }

  func sizeThatFits(_ proposal: ProposedViewSize, nsView: SoftCaretView, context: Context)
    -> CGSize?
  {
    SoftCaretView.size
  }
}

final class SoftCaretView: NSView {
  static let size = CGSize(width: 2, height: 16)
  var mode: CaretMode = .blinking {
    didSet { if mode != oldValue { install() } }
  }
  private let bar = LayerMotion.stillLayer()

  init() {
    super.init(frame: NSRect(origin: .zero, size: Self.size))
    wantsLayer = true
    bar.cornerRadius = 1
    layer?.addSublayer(bar)
    setAccessibilityElement(false)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  /// Whether the caret is blinking (tests).
  var isBlinking: Bool { bar.animation(forKey: LayerMotion.caretBlinkKey) != nil }

  override func layout() {
    super.layout()
    bar.frame = NSRect(x: 0, y: (bounds.height - 15) / 2, width: 2, height: 15)
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    install()
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    bar.backgroundColor = LayerMotion.cgColor(AgentPalette.accent, in: self)
  }

  private func install() {
    bar.backgroundColor = LayerMotion.cgColor(AgentPalette.accent, in: self)
    bar.removeAnimation(forKey: LayerMotion.caretBlinkKey)
    if mode == .blinking {
      bar.add(LayerMotion.caretBlink(delay: 0.5, on: bar), forKey: LayerMotion.caretBlinkKey)
    }
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

// MARK: - Pulse

/// A status dot, pulsing gently while `animates` (a soft halo grows out of it and fades).
struct PulseDot: NSViewRepresentable {
  let color: NSColor
  var diameter: CGFloat = 6
  let animates: Bool

  func makeNSView(context: Context) -> PulseDotView { PulseDotView() }

  func updateNSView(_ view: PulseDotView, context: Context) {
    view.configure(color: color, diameter: diameter, animates: animates)
  }

  func sizeThatFits(_ proposal: ProposedViewSize, nsView: PulseDotView, context: Context)
    -> CGSize?
  {
    CGSize(width: diameter, height: diameter)
  }
}

final class PulseDotView: NSView {
  private let dot = LayerMotion.stillLayer()
  private let halo = LayerMotion.stillLayer()
  private var color: NSColor = AgentPalette.accent
  private var diameter: CGFloat = 6
  private(set) var animates = false

  init() {
    super.init(frame: NSRect(x: 0, y: 0, width: 6, height: 6))
    wantsLayer = true
    layer?.masksToBounds = false
    layer?.addSublayer(halo)
    layer?.addSublayer(dot)
    halo.opacity = 0
    setAccessibilityElement(false)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  /// Whether the halo is pulsing (tests).
  var isPulsing: Bool { halo.animation(forKey: LayerMotion.pulseKey) != nil }

  func configure(color: NSColor, diameter: CGFloat, animates: Bool) {
    let changed = color != self.color || diameter != self.diameter || animates != self.animates
    self.color = color
    self.diameter = diameter
    self.animates = animates
    if changed { install() }
  }

  override func layout() {
    super.layout()
    let frame = NSRect(
      x: (bounds.width - diameter) / 2, y: (bounds.height - diameter) / 2, width: diameter,
      height: diameter)
    for layer in [dot, halo] {
      layer.frame = frame
      layer.cornerRadius = diameter / 2
    }
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    install()
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    recolor()
  }

  private func recolor() {
    let cgColor = LayerMotion.cgColor(color, in: self)
    dot.backgroundColor = cgColor
    halo.backgroundColor = cgColor
  }

  private func install() {
    recolor()
    needsLayout = true
    halo.removeAnimation(forKey: LayerMotion.pulseKey)
    if animates { halo.add(LayerMotion.pulse(), forKey: LayerMotion.pulseKey) }
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

// MARK: - Thinking dots

/// Three dots rising in turn while the agent thinks; still with Reduce Motion.
struct ThinkingDots: NSViewRepresentable {
  let animates: Bool

  func makeNSView(context: Context) -> ThinkingDotsView { ThinkingDotsView() }

  func updateNSView(_ view: ThinkingDotsView, context: Context) {
    view.animates = animates
  }

  func sizeThatFits(_ proposal: ProposedViewSize, nsView: ThinkingDotsView, context: Context)
    -> CGSize?
  {
    ThinkingDotsView.size
  }
}

final class ThinkingDotsView: NSView {
  static let size = CGSize(width: 20, height: 10)
  static let diameter: CGFloat = 4.5
  var animates = true {
    didSet { if animates != oldValue { install() } }
  }
  private let dots = (0..<3).map { _ in LayerMotion.stillLayer() }

  init() {
    super.init(frame: NSRect(origin: .zero, size: Self.size))
    wantsLayer = true
    layer?.masksToBounds = false
    for dot in dots {
      dot.cornerRadius = Self.diameter / 2
      layer?.addSublayer(dot)
    }
    setAccessibilityElement(false)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  /// Whether the dots are moving (tests).
  var isAnimating: Bool { dots.contains { $0.animation(forKey: LayerMotion.dotsKey) != nil } }

  override func layout() {
    super.layout()
    let gap = (bounds.width - 3 * Self.diameter) / 2
    for (index, dot) in dots.enumerated() {
      dot.frame = NSRect(
        x: CGFloat(index) * (Self.diameter + gap), y: (bounds.height - Self.diameter) / 2 - 1,
        width: Self.diameter, height: Self.diameter)
    }
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    install()
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    recolor()
  }

  private func recolor() {
    let color = LayerMotion.cgColor(AgentPalette.accent, in: self)
    for dot in dots { dot.backgroundColor = color }
  }

  private func install() {
    recolor()
    for (index, dot) in dots.enumerated() {
      dot.removeAnimation(forKey: LayerMotion.dotsKey)
      dot.opacity = animates ? 0.35 : 0.8
      if animates { dot.add(LayerMotion.dot(index: index, on: dot), forKey: LayerMotion.dotsKey) }
    }
  }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
