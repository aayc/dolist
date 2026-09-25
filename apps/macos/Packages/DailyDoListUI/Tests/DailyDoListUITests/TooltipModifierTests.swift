import AppKit
import DailyDoListUITestSupport
import SwiftUI
import Testing

@testable import DailyDoListUI

/// SwiftUI views laid out in an offscreen window.
@MainActor
final class HostedView {
  let window: NSWindow
  let hosting: NSView

  init<V: View>(_ view: V, size: CGSize = CGSize(width: 400, height: 300)) {
    hosting = NSHostingView(rootView: view.frame(width: size.width, height: size.height))
    window = NSWindow(
      contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered,
      defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
    window.orderFrontRegardless()
    for _ in 0..<3 {
      hosting.layoutSubtreeIfNeeded()
      window.displayIfNeeded()
      RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
  }

  var anchors: [TooltipAnchorView] { tooltipAnchors(in: hosting) }

  func anchor(_ text: String) -> TooltipAnchorView? {
    anchors.first { $0.tooltipContent()?.lines.first?.text == text }
  }

  func close() { window.close() }
}

@MainActor
@Suite("Tooltip modifier", .serialized)
struct TooltipModifierTests {
  let h = CenterHarness()

  @Test func aControlReportsItsTooltipAndLetsClicksThrough() throws {
    let hosted = HostedView(
      VStack {
        Button("New") {}.tooltip("New note", keys: KeyShortcut("n", .command), command: "note.new")
      }
      .environment(\.tooltipCenter, h.center))
    let anchor = try #require(hosted.anchor("New note"))
    #expect(anchor.command == "note.new")
    #expect(anchor.tooltipContent()?.lines.first?.keys == KeyShortcut("n", .command))
    #expect(anchor.hitTest(NSPoint(x: anchor.bounds.midX, y: anchor.bounds.midY)) == nil)
    let rect = try #require(anchor.tooltipScreenRect)
    #expect(rect.width > 10 && rect.height > 10)
    #expect(anchor.tooltipWindow === hosted.window)

    let enter = try #require(
      NSEvent.enterExitEvent(
        with: .mouseEntered, location: .zero, modifierFlags: [], timestamp: 0,
        windowNumber: hosted.window.windowNumber, context: nil, eventNumber: 0, trackingNumber: 0,
        userData: nil))
    anchor.mouseEntered(with: enter)
    #expect(h.center.pendingTarget === anchor)
    h.clock.advance(by: 0.5)
    #expect(h.presenter.shown?.lines.first?.text == "New note")
    hosted.window.contentView = nil
    #expect(h.center.shownTarget == nil, "the target left its window")
    hosted.close()
  }

  @Test func disabledControlsStayQuietUnlessTheyExplainWhy() throws {
    let hosted = HostedView(
      VStack {
        Button("Back") {}.tooltip("Back", keys: KeyShortcut("[", .command)).disabled(true)
        Button("Today") {}.tooltip("Open today's note", whenDisabled: "Today's note is open")
          .disabled(true)
      }
      .environment(\.tooltipCenter, h.center))
    let texts = hosted.anchors.map { $0.tooltipContent()?.plainText }
    #expect(texts.contains(nil), "disabled Back shows nothing")
    #expect(texts.contains("Today's note is open"))
    hosted.close()
  }

  @Test func truncatedTextOnly() throws {
    let font = NSFont.systemFont(ofSize: 12)
    let long = "Projects/Launch Plan with a very long name.md"
    let hosted = HostedView(
      VStack(alignment: .leading) {
        Text(long).font(.system(size: 12)).lineLimit(1).frame(width: 80, alignment: .leading)
          .tooltip(ifTruncated: long, font: font)
        Text("Ideas").font(.system(size: 12)).lineLimit(1).frame(width: 80, alignment: .leading)
          .tooltip(ifTruncated: "Ideas", font: font)
      }
      .environment(\.tooltipCenter, h.center))
    let contents = hosted.anchors.map { $0.tooltipContent()?.plainText }
    #expect(contents.contains(long), "the truncated one shows its full text")
    #expect(contents.contains(nil), "the one that fits shows nothing")
    hosted.close()
  }

  @Test func iconButtonsNameThemselvesAndStayQuietWhenDisabled() throws {
    let hosted = HostedView(
      HStack {
        IconButton("plus", label: "New note", keys: KeyShortcut("n", .command), command: "note.new")
        {}
        IconButton("chevron.left", label: "Back", isEnabled: false) {}
      }
      .environment(\.tooltipCenter, h.center))
    let newNote = try #require(hosted.anchor("New note"))
    #expect(newNote.command == "note.new")
    #expect(hosted.anchors.count == 2)
    #expect(hosted.anchors.contains { $0.tooltipContent() == nil }, "disabled Back")
    hosted.close()
  }

  @Test func truncationIsMeasuredInTheViewsFont() {
    let font = NSFont.systemFont(ofSize: 13)
    #expect(
      TruncatedText.isTruncated(
        "A long note name", font: font, in: CGSize(width: 40, height: 16), lineLimit: 1))
    #expect(
      !TruncatedText.isTruncated(
        "Idea", font: font, in: CGSize(width: 80, height: 16), lineLimit: 1))
    let title = "Book a table for four at a quiet place near the office on Friday evening"
    #expect(
      TruncatedText.isTruncated(title, font: font, in: CGSize(width: 120, height: 34), lineLimit: 2)
    )
    #expect(
      !TruncatedText.isTruncated(
        "Book a table", font: font, in: CGSize(width: 120, height: 34), lineLimit: 2))
  }
}
