import AppKit
import DailyDoListModels
import Testing

@testable import DailyDoListAgent

/// A frame ticker the test fires by hand (a manual clock for the reveal).
@MainActor
final class ManualTicker: FrameTicker {
  private(set) var isRunning = false
  private(set) var starts = 0
  private let onFrame: @MainActor (TimeInterval) -> Void

  init(onFrame: @escaping @MainActor (TimeInterval) -> Void) {
    self.onFrame = onFrame
  }

  func start() {
    isRunning = true
    starts += 1
  }

  func stop() { isRunning = false }

  func fire(at timestamp: TimeInterval) {
    guard isRunning else { return }
    onFrame(timestamp)
  }
}

/// A reveal environment with a manual ticker and a Reduce Motion switch.
@MainActor
final class RevealHarness {
  var reduceMotion = false
  private(set) var tickers: [ManualTicker] = []
  private(set) var time: TimeInterval = 100
  lazy var reveal = ChatReveal(
    environment: RevealEnvironment(
      reduceMotion: { [unowned self] in self.reduceMotion },
      makeTicker: { [unowned self] _, onFrame in
        let ticker = ManualTicker(onFrame: onFrame)
        self.tickers.append(ticker)
        return ticker
      }))

  var ticker: ManualTicker? { tickers.last }
  var isTicking: Bool { ticker?.isRunning ?? false }

  /// Fires one frame `dt` seconds after the last.
  func frame(_ dt: TimeInterval = 1.0 / 60) {
    time += dt
    ticker?.fire(at: time)
  }

  /// Runs frames until nothing is behind (at most `limit`).
  @discardableResult
  func runUntilIdle(limit: Int = 10_000) -> Int {
    var frames = 0
    while isTicking, frames < limit {
      frame()
      frames += 1
    }
    return frames
  }
}

/// The pacing table the web app's reveal tests share: (backlog, seconds since last frame,
/// characters revealed).
@Suite("Reveal pacing")
struct RevealPacingTests {
  static let cases: [(backlog: Int, elapsed: Double, reveals: Int)] = [
    (0, 1.0 / 60, 0),
    (1, 1.0 / 60, 1),
    (10, 1.0 / 60, 1),
    (45, 1.0 / 60, 1),
    (100, 1.0 / 60, 2),
    (600, 1.0 / 60, 10),
    (3_000, 1.0 / 60, 50),
    (10_000, 1.0 / 60, 50),
    (4_000, 1.0 / 120, 25),
    (10_000, 0.1, 300),
    (2_000, 0.25, 500),
    (30, 0.5, 23),
    (5, 1, 5),
    (200, 0, 1),
    (90, 1.0 / 30, 3),
  ]

  @Test(arguments: cases)
  func revealsPerFrame(backlog: Int, elapsed: Double, reveals: Int) {
    #expect(RevealPacing.step(backlog: backlog, elapsed: elapsed) == reveals)
  }

  @Test func speedIsTheBacklogPerSecondWithinBounds() {
    #expect(RevealPacing.speed(backlog: 0) == 45)
    #expect(RevealPacing.speed(backlog: 45) == 45)
    #expect(RevealPacing.speed(backlog: 100) == 100)
    #expect(RevealPacing.speed(backlog: 3_000) == 3_000)
    #expect(RevealPacing.speed(backlog: 50_000) == 3_000)
  }

  @Test func oddTimeDeltasNeverRevealBackwardsOrTooMuch() {
    #expect(RevealPacing.step(backlog: 10, elapsed: -1) == 1)
    #expect(RevealPacing.step(backlog: 10, elapsed: .infinity) == 1)
    #expect(RevealPacing.step(backlog: 10, elapsed: .nan) == 1)
    #expect(RevealPacing.step(backlog: 10, elapsed: 1e9) == 10)
  }

  /// At 60 Hz: a short reply types a character a frame, a paragraph slows as it catches up, and a
  /// huge one runs at the 3,000/s cap.
  @Test func shortRepliesTypeOutAndLongOnesCatchUp() {
    func frames(for backlog: Int) -> Int {
      var left = backlog
      var count = 0
      while left > 0 {
        left -= RevealPacing.step(backlog: left, elapsed: 1.0 / 60)
        count += 1
      }
      return count
    }
    #expect(frames(for: 20) == 20)
    #expect(frames(for: 300) == 160)
    #expect(frames(for: 3_000) == 297)
    #expect(frames(for: 50_000) == 1_237)
  }
}

@MainActor
@Suite("Revealed text")
struct RevealedTextTests {
  @Test func revealsByGraphemeClustersNeverSplittingOne() {
    let text = "👩‍👩‍👧‍👦 e\u{301} 🇫🇷🇩🇪!"
    let reveal = RevealedText(text: text, streaming: false, revealed: false)
    #expect(reveal.backlog == text.count)
    var seen: [String] = []
    while reveal.advance(by: 0) { seen.append(reveal.visible) }
    seen.append(reveal.visible)
    #expect(seen.first == "👩‍👩‍👧‍👦")
    #expect(seen.contains("👩‍👩‍👧‍👦 e\u{301}"))
    #expect(seen.contains("👩‍👩‍👧‍👦 e\u{301} 🇫🇷"))
    #expect(seen.last == text)
    for prefix in seen { #expect(text.hasPrefix(prefix)) }
    #expect(seen.count == text.count)
  }

  @Test func appendedTextKeepsTheRevealedPrefix() {
    let reveal = RevealedText(text: "Hello", streaming: true, revealed: false)
    reveal.advance(by: 0)
    reveal.advance(by: 0)
    #expect(reveal.visible == "He")
    reveal.update(text: "Hello there", streaming: true)
    #expect(reveal.visible == "He")
    #expect(reveal.backlog == 9)
    #expect(reveal.isActive)
  }

  @Test func anAccentJoiningTheLastShownCharacterMovesTheCutBack() {
    let reveal = RevealedText(text: "cafe", streaming: true, revealed: true)
    reveal.update(text: "cafe\u{301}!", streaming: true)
    #expect(reveal.visible == "caf")
    #expect(reveal.backlog == 2)
    reveal.advance(by: 0)
    #expect(reveal.visible == "cafe\u{301}")
  }

  @Test func aRewriteTypesOnFromTheSharedPrefix() {
    let reveal = RevealedText(text: "Hello world", streaming: true, revealed: false)
    for _ in 0..<8 { reveal.advance(by: 0) }
    #expect(reveal.visible == "Hello wo")
    reveal.update(text: "Hello there", streaming: false)
    #expect(reveal.visible == "Hello ")
    #expect(reveal.backlog == 5)
  }

  @Test func whenCaughtUpAndFinishedTheFinalTextShowsExactly() {
    let reveal = RevealedText(text: "Hi **there**", streaming: true, revealed: false)
    while reveal.advance(by: 1) {}
    #expect(reveal.isActive, "still streaming")
    reveal.update(text: "Hi **there**, done.", streaming: false)
    while reveal.advance(by: 1.0 / 60) {}
    #expect(reveal.visible == "Hi **there**, done.")
    #expect(!reveal.isActive)
  }

  @Test func finishShowsEverything() {
    let reveal = RevealedText(text: "A long answer", streaming: false, revealed: false)
    reveal.finish()
    #expect(reveal.visible == "A long answer")
    #expect(!reveal.isActive)
  }
}

@MainActor
@Suite("Chat reveal")
struct ChatRevealTests {
  func text(_ id: String, _ body: String, streaming: Bool? = nil, role: MessageRole = .agent)
    -> ThreadMessage
  {
    Fixture.text(id, body, streaming: streaming, role: role)
  }

  func textMessage(_ message: ThreadMessage) -> TextMessage {
    guard case .text(let text) = message else { fatalError("not text") }
    return text
  }

  @Test func historyRendersAtOnceAndNeverTicks() {
    let harness = RevealHarness()
    let history = [text("m1", "Earlier answer"), text("m2", "Thanks", role: .user)]
    harness.reveal.open(with: history)
    harness.reveal.sync(history)
    #expect(harness.reveal.presentation(of: textMessage(history[0])) == .whole)
    #expect(harness.reveal.presentation(of: textMessage(history[1])) == .whole)
    #expect(harness.tickers.isEmpty)
    #expect(!harness.reveal.isRevealing)
  }

  @Test func aNewAgentMessageTypesOutAndTheTickerStopsWhenCaughtUp() throws {
    let harness = RevealHarness()
    harness.reveal.open(with: [])
    let reply = text("m1", String(repeating: "word ", count: 120))
    #expect(harness.reveal.presentation(of: textMessage(reply)) == .pending)
    harness.reveal.sync([reply])
    guard case .revealing(let entry) = harness.reveal.presentation(of: textMessage(reply)) else {
      Issue.record("expected a reveal")
      return
    }
    #expect(entry.visible.isEmpty)
    #expect(harness.isTicking)
    #expect(harness.reveal.isRevealing)
    harness.frame()
    #expect(entry.visible.count == 10, "600 waiting at 1/60 s reveals 10")
    harness.frame()
    #expect(entry.visible.count == 20)
    let frames = harness.runUntilIdle()
    #expect(frames > 30)
    #expect(entry.visible == textMessage(reply).text)
    #expect(!harness.isTicking)
    #expect(!harness.reveal.isRevealing)
  }

  @Test func theUsersOwnMessagesNeverAnimate() {
    let harness = RevealHarness()
    harness.reveal.open(with: [])
    let mine = text("m1", "Please book it", role: .user)
    harness.reveal.sync([mine])
    #expect(harness.reveal.presentation(of: textMessage(mine)) == .whole)
    #expect(harness.tickers.isEmpty)
  }

  @Test func textStreamingWhenTheChatOpensTypesOnFromWhatWasThere() {
    let harness = RevealHarness()
    harness.reveal.open(with: [text("m1", "Checking the", streaming: true)])
    guard
      case .revealing(let entry) = harness.reveal.presentation(
        of: textMessage(text("m1", "", streaming: true)))
    else {
      Issue.record("expected a reveal")
      return
    }
    #expect(entry.visible == "Checking the")
    #expect(harness.reveal.isRevealing, "streaming shows the caret")
    #expect(!harness.isTicking, "nothing is behind yet")
    harness.reveal.sync([text("m1", "Checking the menu", streaming: true)])
    #expect(harness.isTicking)
    harness.frame()
    #expect(entry.visible == "Checking the ")
    harness.runUntilIdle()
    #expect(entry.visible == "Checking the menu")
    #expect(harness.reveal.isRevealing)
    harness.reveal.sync([text("m1", "Checking the menu.", streaming: false)])
    harness.runUntilIdle()
    #expect(entry.visible == "Checking the menu.")
    #expect(!harness.reveal.isRevealing)
  }

  @Test func burstsKeepTypingAtThePacedSpeed() throws {
    let harness = RevealHarness()
    harness.reveal.open(with: [])
    harness.reveal.sync([text("m1", String(repeating: "a", count: 45), streaming: true)])
    let entry = try #require(harness.reveal.entries["m1"])
    harness.frame()
    #expect(entry.visible.count == 1)
    harness.reveal.sync([text("m1", String(repeating: "a", count: 3_045), streaming: true)])
    harness.frame()
    #expect(entry.visible.count == 1 + 50, "3,044 waiting reveals at the 3,000/s cap")
  }

  @Test func withReduceMotionTextAppearsAsItArrives() {
    let harness = RevealHarness()
    harness.reduceMotion = true
    harness.reveal.open(with: [])
    let reply = text("m1", "Found three options", streaming: true)
    harness.reveal.sync([reply])
    #expect(harness.reveal.presentation(of: textMessage(reply)) == .whole)
    #expect(harness.tickers.isEmpty)
    #expect(!harness.reveal.isRevealing)
  }

  @Test func turningOnReduceMotionMidRevealShowsEverything() {
    let harness = RevealHarness()
    harness.reveal.open(with: [])
    harness.reveal.sync([text("m1", String(repeating: "x", count: 500))])
    let entry = harness.reveal.entries["m1"]
    harness.frame()
    harness.reduceMotion = true
    harness.frame()
    #expect(entry?.visible.count == 500)
    #expect(!harness.isTicking)
  }

  @Test func theTickerRestartsForNewTextAfterStopping() {
    let harness = RevealHarness()
    harness.reveal.open(with: [])
    harness.reveal.sync([text("m1", "Short.")])
    harness.runUntilIdle()
    #expect(!harness.isTicking)
    harness.reveal.sync([text("m1", "Short."), text("m2", "Another one.")])
    #expect(harness.isTicking)
    #expect(harness.ticker?.starts == 2)
    harness.reveal.close()
    #expect(!harness.isTicking)
  }

  @Test func eachNewApprovalAnnouncesOnce() {
    let harness = RevealHarness()
    harness.reveal.open(with: [text("old", "Earlier")])
    #expect(!harness.reveal.needsAnnouncement("old"))
    #expect(harness.reveal.needsAnnouncement("apr_msg"))
    harness.reveal.markAnnounced("apr_msg")
    #expect(!harness.reveal.needsAnnouncement("apr_msg"))
  }
}
