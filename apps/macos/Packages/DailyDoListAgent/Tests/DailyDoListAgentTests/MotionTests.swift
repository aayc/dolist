import AppKit
import SwiftUI
import Testing

@testable import DailyDoListAgent

/// The looping animations run on Core Animation only when motion is allowed, and the typing caret
/// sits after the last character.
@MainActor
@Suite("Chat motion", .serialized)
struct MotionTests {
  /// Puts `view` in an offscreen window (animations install once a view is in one).
  private func inWindow(_ view: NSView, size: CGSize = CGSize(width: 200, height: 40)) -> NSWindow {
    let window = NSWindow(
      contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    let container = NSView(frame: CGRect(origin: .zero, size: size))
    container.wantsLayer = true
    container.addSubview(view)
    window.contentView = container
    view.layoutSubtreeIfNeeded()
    return window
  }

  @Test func thinkingDotsMoveOnlyWhenMotionIsAllowed() {
    let dots = ThinkingDotsView()
    let window = inWindow(dots)
    defer { window.close() }
    #expect(dots.isAnimating)
    dots.animates = false
    #expect(!dots.isAnimating)
    dots.animates = true
    #expect(dots.isAnimating)
  }

  @Test func thePulseIsStillWithReduceMotion() {
    let dot = PulseDotView()
    let window = inWindow(dot)
    defer { window.close() }
    dot.configure(color: AgentPalette.info, diameter: 6, animates: true)
    #expect(dot.isPulsing)
    dot.configure(color: AgentPalette.info, diameter: 6, animates: false)
    #expect(!dot.isPulsing)
  }

  @Test func theStandaloneCaretBlinksOrStaysStill() {
    let caret = SoftCaretView()
    let window = inWindow(caret)
    defer { window.close() }
    #expect(caret.isBlinking)
    caret.mode = .steady
    #expect(!caret.isBlinking)
  }

  @Test func theCaretFollowsTheLastCharacter() throws {
    let view = CitationTextView()
    view.frame = NSRect(x: 0, y: 0, width: 300, height: 60)
    let window = inWindow(view, size: CGSize(width: 300, height: 60))
    defer { window.close() }
    view.setContent(AttributedString("Hi"), style: .body)
    view.caret = .blinking
    let short = try #require(view.caretLayer)
    let shortX = short.frame.minX
    #expect(shortX > 5)
    #expect(short.frame.height >= 14)
    #expect(short.animation(forKey: LayerMotion.caretBlinkKey) != nil)
    view.setContent(AttributedString("Hi there, a longer line"), style: .body)
    #expect(try #require(view.caretLayer).frame.minX > shortX + 40)
    view.caret = .steady
    #expect(view.caretLayer?.animation(forKey: LayerMotion.caretBlinkKey) == nil)
    view.caret = nil
    #expect(view.caretLayer == nil)
  }

  @Test func caretModeFollowsReduceMotion() {
    #expect(CaretMode(reduceMotion: false) == .blinking)
    #expect(CaretMode(reduceMotion: true) == .steady)
  }
}
