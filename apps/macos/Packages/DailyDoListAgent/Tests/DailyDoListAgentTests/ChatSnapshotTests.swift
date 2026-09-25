import AppKit
import DailyDoListClient
import DailyDoListModels
import DailyDoListUI
import SwiftUI
import Testing

@testable import DailyDoListAgent

/// Snapshots of the live chat: the activity row, typing text with its caret, tool groups, the
/// "Jump to latest" pill, the chat bar's states and unsent messages. Looping animations run on
/// Core Animation, so the images show their resting frame.
@MainActor
@Suite("Chat snapshots", .serialized)
struct ChatSnapshotTests {
  static let now = SnapshotTests.now
  let store = SampleData.makeStore(now: ChatSnapshotTests.now)

  private func check(_ rendered: SnapshotRenderer.Rendered, minimumColors: Int = 12) {
    #expect(FileManager.default.fileExists(atPath: rendered.url.path))
    #expect(rendered.bytes > 4_000, "\(rendered.url.lastPathComponent) is not empty")
    #expect(
      rendered.distinctColors >= minimumColors, "\(rendered.url.lastPathComponent) has content")
  }

  /// A working thread: a running tool call as the activity row, the pulsing status, and Stop in
  /// the chat bar.
  @Test(arguments: [false, true])
  func aWorkingThread(dark: Bool) throws {
    let view = AgentPanel(
      store: store, selectedThreadId: .constant(SampleData.coffeeThreadId),
      shortcuts: AgentPanelShortcuts(stop: .init(id: "agent.stop", keys: KeyShortcutFixtures.stop))
    )
    .agentReferenceDate(Self.now)
    check(
      try SnapshotRenderer.render(
        view, name: "chat-working", size: CGSize(width: 440, height: 760), dark: dark))
  }

  @Test(arguments: [false, true])
  func chatPieces(dark: Bool) throws {
    let long = """
      I found **three tables** for Friday at 7pm near you:

      1. Pasta Bar Nord — patio, $$
      2. Trattoria Example — quiet room
      3. Osteria Sample — needs a deposit

      Want me to book the first one? I'll ask before I submit [1](https://pasta-bar-nord.example/book).
      """
    let typing = RevealedText(text: long, streaming: true, revealed: false)
    typing.advance(by: 0.9)
    let calls = (0..<5).map { index in
      ToolCallMessage(
        id: "call_\(index)", author: "subagent:booking",
        createdAt: Self.now.epochMillis - 60_000 + Double(index) * 4_000, toolCallId: "c\(index)",
        toolName: ["web_search", "web_fetch", "browser_navigate", "browser_snapshot", "read_note"][
          index],
        label: ["Search the web", "Fetch web page", nil, nil, "Read note"][index],
        input: [:], status: .ok, endedAt: Self.now.epochMillis - 58_000 + Double(index) * 4_000)
    }
    let since = Self.now.epochMillis - 12_400
    let view = ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        ActivityRow(activity: ChatActivity(kind: .thinking, label: "Thinking…", since: since)) {}
        ActivityRow(
          activity: ChatActivity(
            kind: .tool(name: "computer_open_app"), label: "Opening Safari…", since: since + 11_000)
        ) {}
        ActivityRow(
          activity: ChatActivity(
            kind: .approval(approvalId: "a", messageId: "m"), label: "Waiting for your approval",
            since: since)
        ) {}
        ActivityRow(
          activity: ChatActivity(kind: .waitingToStart, label: "Waiting to start…", since: nil)
        ) {}
        TextMessageView(
          message: TextMessage(
            id: "m_typing", author: "subagent:booking", createdAt: Self.now.epochMillis,
            role: .agent, text: long, streaming: true),
          reveal: .revealing(typing), now: Self.now)
        TextMessageView(
          message: TextMessage(
            id: "m_pending", author: "orchestrator", createdAt: Self.now.epochMillis, role: .agent,
            text: "Next", streaming: true),
          reveal: .pending, now: Self.now)
        ToolGroupRow(calls: calls)
        ToolGroupRow(calls: Array(calls.prefix(3)), expanded: true)
        TextMessageView(
          message: TextMessage(
            id: "local-1", author: "you", createdAt: Self.now.epochMillis, role: .user,
            text: "Book the patio one please"),
          isSending: true, now: Self.now)
        TextMessageView(
          message: TextMessage(
            id: "local-2", author: "you", createdAt: Self.now.epochMillis, role: .user,
            text: "And a table for Saturday too"),
          unsent: "Can't reach the Daily Do List daemon.", now: Self.now)
        HStack {
          JumpToLatestPill(unseen: 0) {}
          JumpToLatestPill(unseen: 3) {}
        }
        .frame(maxWidth: .infinity)
      }
      .padding(16)
    }
    .foregroundStyle(AgentTheme.text)
    .tint(AgentTheme.accent)
    .agentReferenceDate(Self.now)
    check(
      try SnapshotRenderer.render(
        view, name: "chat-pieces", size: CGSize(width: 440, height: 1_120), dark: dark))
  }

  @Test(arguments: [false, true])
  func composerStates(dark: Bool) async throws {
    let working = ComposerModel(store: store, threadId: SampleData.coffeeThreadId)
    let drafting = ComposerModel(store: store, threadId: SampleData.coffeeThreadId)
    drafting.text = "Pick the one with the patio,\nand ask for a table by the window."
    let approval = ComposerModel(store: store, threadId: SampleData.bookingThreadId)
    let finished = ComposerModel(store: store, threadId: SampleData.desksThreadId)
    let view = VStack(spacing: 0) {
      Composer(model: working)
      Composer(model: drafting)
      Composer(model: approval)
      Composer(model: finished)
    }
    .frame(width: 400)
    .background(AgentTheme.panelBackground)
    check(
      try await SnapshotRenderer.renderSettled(
        view, name: "composer-states", size: CGSize(width: 400, height: 350), dark: dark),
      minimumColors: 8)
  }
}

enum KeyShortcutFixtures {
  static let stop = KeyShortcut(".")
}
