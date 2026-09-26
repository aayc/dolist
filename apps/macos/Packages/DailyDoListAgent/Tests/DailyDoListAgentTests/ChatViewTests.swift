import AppKit
import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListModels
import SwiftUI
import Testing

@testable import DailyDoListAgent

/// The chat as a whole, hosted in a window with a manual frame clock: history shows at once, new
/// agent text types out frame by frame, and the live row follows the agent.
@MainActor
@Suite("Chat view", .serialized)
struct ChatViewTests {
  let client = FakeDaemonClient()
  let store: AgentStore
  let harness = RevealHarness()

  init() {
    store = AgentStore(client: client, now: { Date(epochMillis: 1_000) })
  }

  private struct Host: View {
    let store: AgentStore
    let reveal: ChatReveal

    var body: some View {
      if let thread = store.thread("thr_1") {
        ChatView(store: store, thread: thread, reveal: reveal) { _ in }
      }
    }
  }

  private func load(_ messages: [ThreadMessage], status: TaskAgentStatus = .working) async {
    let thread = Fixture.thread(status: status, messages: messages)
    client.script { $0.thread = { _ in ThreadResponse(thread: thread, approvals: []) } }
    await store.loadThread("thr_1")
  }

  private func host() -> (NSHostingView<some View>, NSWindow) {
    let host = NSHostingView(
      rootView: Host(store: store, reveal: harness.reveal)
        .frame(width: 420, height: 600)
        .agentReferenceDate(Date(epochMillis: 1_000)))
    host.frame = CGRect(x: 0, y: 0, width: 420, height: 600)
    let window = NSWindow(
      contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = host
    return (host, window)
  }

  private func settle(_ host: NSView) async throws {
    for _ in 0..<4 {
      host.layoutSubtreeIfNeeded()
      host.displayIfNeeded()
      try await Task.sleep(for: .milliseconds(15))
    }
  }

  /// The text of every block of agent text on screen.
  private func agentText(in view: NSView) -> String {
    var texts: [String] = []
    func walk(_ view: NSView) {
      if let text = view as? CitationTextView { texts.append(text.string) }
      view.subviews.forEach(walk)
    }
    walk(view)
    return texts.joined(separator: "\n")
  }

  @Test func historyShowsAtOnceAndNewAgentTextTypesOut() async throws {
    await load([Fixture.text("m1", "Earlier answer.", streaming: nil)])
    let (host, window) = host()
    defer { window.close() }
    try await settle(host)
    #expect(agentText(in: host).contains("Earlier answer."))
    #expect(harness.tickers.isEmpty, "history never ticks")

    let reply = "I found three tables for Friday at seven, all with a patio."
    store.apply(
      .threadMessage(
        ThreadMessageEvent(
          threadId: "thr_1", message: Fixture.text("m2", reply, streaming: nil, createdAt: 900))))
    try await settle(host)
    let entry = try #require(harness.reveal.entries["m2"])
    #expect(harness.isTicking)
    #expect(!agentText(in: host).contains("I found"), "nothing typed before the first frame")

    for _ in 0..<12 { harness.frame() }
    try await settle(host)
    let partial = agentText(in: host)
    #expect(partial.contains(entry.visible))
    #expect(!partial.contains(reply))

    harness.runUntilIdle()
    try await settle(host)
    #expect(agentText(in: host).contains(reply))
    #expect(!harness.isTicking, "no frames once caught up")
  }

  /// The chat's own scroll view (not the chat bar's or a code block's).
  private func chatScrollView(in view: NSView) -> NSScrollView? {
    var found: [NSScrollView] = []
    func walk(_ view: NSView) {
      if let scroll = view as? NSScrollView { found.append(scroll) }
      view.subviews.forEach(walk)
    }
    walk(view)
    return found.max { $0.frame.height < $1.frame.height }
  }

  @Test func theChatFollowsNewTextAtTheBottomAndLeavesAReaderAlone() async throws {
    let history = (0..<30).map { index in
      Fixture.text("h\(index)", "Update \(index): still looking.", streaming: nil)
    }
    await load(history)
    let (host, window) = host()
    defer { window.close() }
    try await settle(host)
    let scroll = try #require(chatScrollView(in: host))
    let document = try #require(scroll.documentView)
    func distanceFromBottom() -> CGFloat {
      let visible = scroll.contentView.bounds
      return document.isFlipped
        ? document.frame.height - visible.maxY : visible.minY - document.frame.minY
    }
    #expect(document.frame.height > scroll.frame.height * 1.5, "the history overflows")
    #expect(distanceFromBottom() <= 2, "opens at the latest message")

    store.apply(
      .threadMessage(
        ThreadMessageEvent(
          threadId: "thr_1",
          message: Fixture.text(
            "n1", "A longer answer that wraps over a few lines of the chat as it types out.",
            streaming: nil))))
    try await settle(host)
    harness.runUntilIdle()
    try await settle(host)
    #expect(distanceFromBottom() <= 2, "followed the new text")

    let top = document.isFlipped ? 0 : document.frame.height - scroll.contentView.bounds.height
    scroll.contentView.scroll(to: NSPoint(x: 0, y: top))
    scroll.reflectScrolledClipView(scroll.contentView)
    try await settle(host)
    let readingAt = scroll.contentView.bounds.origin
    store.apply(
      .threadMessage(
        ThreadMessageEvent(
          threadId: "thr_1", message: Fixture.text("n2", "One more thing.", streaming: nil))))
    try await settle(host)
    harness.runUntilIdle()
    try await settle(host)
    #expect(scroll.contentView.bounds.origin == readingAt, "the reader stays where they were")
  }

}
