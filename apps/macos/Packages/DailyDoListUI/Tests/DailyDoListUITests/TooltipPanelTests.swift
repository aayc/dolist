import AppKit
import QuartzCore
import Testing

@testable import DailyDoListUI

/// The real panel presenter: window setup, placement, and which animations run.
@MainActor
@Suite("Tooltip panel", .serialized)
struct TooltipPanelTests {
  let clock = ManualScheduler()
  let window = Self.makeWindow()
  let presenter: TooltipPanelPresenter

  init() {
    presenter = TooltipPanelPresenter(clock: clock)
  }

  static func makeWindow() -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 800, height: 500), styleMask: [.borderless],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
    window.orderFrontRegardless()
    return window
  }

  /// A 28 pt square `top` points below the window's top, `x` from its left.
  func anchor(x: CGFloat, top: CGFloat) -> NSRect {
    window.convertToScreen(
      NSRect(x: x, y: window.frame.height - top - 28, width: 28, height: 28))
  }

  func show(
    _ content: TooltipContent, at anchor: NSRect, _ animation: TooltipAnimation,
    placement: TooltipPlacement = .automatic
  ) {
    presenter.show(
      TooltipPresentation(content: content, anchor: anchor, window: window, placement: placement),
      animation: animation)
  }

  @Test func aNonActivatingChildPanelThatIgnoresTheMouse() {
    show(TooltipContent("New note"), at: anchor(x: 100, top: 6), .enter(reduced: false))
    let panel = presenter.panel
    #expect(panel.isVisible)
    #expect(panel.ignoresMouseEvents)
    #expect(!panel.canBecomeKey && !panel.canBecomeMain)
    #expect(panel.styleMask.contains(.nonactivatingPanel))
    #expect(panel.parent === window, "a child of the target's window")
    #expect(panel.level.rawValue > window.level.rawValue)
    window.close()
  }

  @Test func belowAHeaderControlAboveOthers() throws {
    let header = anchor(x: 100, top: 6)
    show(
      TooltipContent("New note", keys: KeyShortcut("n", .command)), at: header,
      .enter(reduced: false))
    var surface = try #require(presenter.surfaceFrame)
    #expect(presenter.isBelow)
    #expect(surface.maxY == header.minY - 6)
    #expect(abs(surface.midX - header.midX) <= 0.5)
    #expect(surface.height >= 24 && surface.height <= 30, "one line with keycaps: \(surface)")

    let body = anchor(x: 300, top: 300)
    show(TooltipContent("Retry"), at: body, .enter(reduced: false))
    surface = try #require(presenter.surfaceFrame)
    #expect(!presenter.isBelow)
    #expect(surface.minY == body.maxY + 6)
    window.close()
  }

  @Test func longTextWrapsAt280Points() throws {
    let text = String(repeating: "A long tooltip that has to wrap onto more lines. ", count: 4)
    show(TooltipContent(text), at: anchor(x: 300, top: 300), .enter(reduced: false))
    let surface = try #require(presenter.surfaceFrame)
    #expect(surface.width <= 280)
    #expect(surface.height > 40, "wrapped: \(surface)")
    window.close()
  }

  @Test func entersWithAFadeASlideAndAScale() throws {
    show(TooltipContent("Back"), at: anchor(x: 100, top: 6), .enter(reduced: false))
    let layer = try #require(presenter.bubbleLayer)
    #expect(Set(layer.animationKeys() ?? []) == ["opacity", "position", "transform"])
    let opacity = try #require(layer.animation(forKey: "opacity") as? CABasicAnimation)
    #expect(opacity.duration == 0.14)
    #expect((opacity.fromValue as? NSNumber)?.floatValue == 0)
    let position = try #require(layer.animation(forKey: "position") as? CABasicAnimation)
    let start = try #require((position.fromValue as? NSValue)?.pointValue)
    #expect(start.y - layer.position.y == 3, "below its target: it slides down into place")
    window.close()
  }

  @Test func reduceMotionOnlyFades() throws {
    show(TooltipContent("Back"), at: anchor(x: 100, top: 6), .enter(reduced: true))
    let layer = try #require(presenter.bubbleLayer)
    #expect(layer.animationKeys() == ["opacity"])
    #expect(layer.animation(forKey: "opacity")?.duration == 0.08)
    show(TooltipContent("Forward"), at: anchor(x: 140, top: 6), .glide(reduced: true))
    #expect(layer.animation(forKey: "position") == nil, "no glide")
    window.close()
  }

  @Test func warmModeGlidesFromTheLastPosition() throws {
    show(TooltipContent("Back"), at: anchor(x: 100, top: 6), .enter(reduced: false))
    let first = try #require(presenter.surfaceFrame)
    show(TooltipContent("Forward"), at: anchor(x: 140, top: 6), .glide(reduced: false))
    let second = try #require(presenter.surfaceFrame)
    let layer = try #require(presenter.bubbleLayer)
    let glide = try #require(layer.animation(forKey: "position") as? CABasicAnimation)
    #expect(glide.duration == 0.12)
    let start = try #require((glide.fromValue as? NSValue)?.pointValue)
    #expect(abs((start.x - layer.position.x) - (first.minX - second.minX)) < 0.5)
    #expect(presenter.panel.frame.contains(first) && presenter.panel.frame.contains(second))
    window.close()
  }

  @Test func fadesOutThenLeavesTheWindow() {
    show(TooltipContent("Back"), at: anchor(x: 100, top: 6), .enter(reduced: false))
    presenter.hide(animation: .exit(reduced: false))
    #expect(presenter.isVisible, "still fading")
    #expect(presenter.bubbleLayer?.animation(forKey: "opacity")?.duration == 0.09)
    clock.advance(by: 0.09)
    #expect(!presenter.isVisible)
    #expect(!presenter.panel.isVisible)
    #expect(presenter.panel.parent == nil)
    window.close()
  }

  @Test func aNewTooltipDuringTheFadeKeepsThePanel() {
    show(TooltipContent("Back"), at: anchor(x: 100, top: 6), .enter(reduced: false))
    presenter.hide(animation: .exit(reduced: false))
    clock.advance(by: 0.04)
    show(TooltipContent("Forward"), at: anchor(x: 140, top: 6), .glide(reduced: false))
    clock.advance(by: 1)
    #expect(presenter.isVisible, "the old fade doesn't hide the new tooltip")
    #expect(presenter.panel.isVisible)
    window.close()
  }

  @Test func hidesAtOnce() {
    show(TooltipContent("Back"), at: anchor(x: 100, top: 6), .enter(reduced: false))
    presenter.hide(animation: .immediate)
    #expect(!presenter.isVisible)
    #expect(!presenter.panel.isVisible)
    window.close()
  }
}
