import AppKit
import DailyDoListUI
import Testing

@MainActor
struct FrameTickerTests {
  @Test func theDisplayLinkTickerExistsOnlyWhileRunning() {
    let view = NSView(frame: NSRect(x: 0, y: 0, width: 10, height: 10))
    let ticker = DisplayLinkTicker(view: view) { _ in }
    #expect(!ticker.isRunning)
    ticker.start()
    #expect(ticker.isRunning)
    ticker.stop()
    #expect(!ticker.isRunning)
    let orphan = DisplayLinkTicker(view: nil) { _ in }
    orphan.start()
    #expect(!orphan.isRunning, "no view, no link")
  }
}
