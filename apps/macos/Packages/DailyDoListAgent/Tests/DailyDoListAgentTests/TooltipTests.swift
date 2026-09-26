import AppKit
import DailyDoListAgentTestSupport
import DailyDoListModels
import DailyDoListUI
import DailyDoListUITestSupport
import SwiftUI
import Testing

@testable import DailyDoListAgent

/// The agent panel's tooltips: the host's shortcuts as keycaps, names on icon buttons, counts
/// explained, and no shortcut spelled out.
@MainActor
@Suite("Agent tooltips", .serialized)
struct TooltipTests {
  let store = SampleData.makeStore(now: SnapshotTests.now)

  private func tooltips(_ anchors: [TooltipAnchorView]) -> [String: TooltipContent] {
    var byLabel: [String: TooltipContent] = [:]
    for anchor in anchors {
      if let content = anchor.tooltipContent(), let label = content.lines.first?.text {
        byLabel[label] = content
      }
    }
    return byLabel
  }

  @Test func aThreadShowsTheHostsShortcutsAndNamesItsButtons() {
    let shortcuts = AgentPanelShortcuts(
      hidePanel: KeyShortcut("\\"), inbox: KeyShortcut("a", [.shift, .command]))
    let found = tooltips(
      tooltipAnchors(
        of: AgentPanel(
          store: store, selectedThreadId: .constant(SampleData.bookingThreadId),
          onShowInNote: { _ in }, onHide: {}, shortcuts: shortcuts
        ).agentReferenceDate(SnapshotTests.now),
        size: CGSize(width: 440, height: 900)))
    #expect(found["Hide agent panel"]?.lines.first?.keys == shortcuts.hidePanel)
    #expect(found["Back to inbox"]?.lines.first?.keys == shortcuts.inbox)
    #expect(found["Show task in note"] != nil)
    #expect(
      found.keys.contains { $0.hasSuffix("approval waiting") || $0.hasSuffix("approvals waiting") })
    for content in found.values {
      #expect(!content.plainText.contains { "⌘⌥⌃⇧".contains($0) }, "\(content.plainText)")
    }
  }

  @Test func stopShowsTheHostsCommandBesideSendAndInTheHeaderElsewhere() throws {
    let stop = AgentPanelShortcuts.Command(id: "agent.stop", keys: KeyShortcut("."))
    func stops(tab: ThreadTab) -> [TooltipAnchorView] {
      tooltipAnchors(
        of: ThreadView(store: store, threadId: SampleData.coffeeThreadId, tab: tab, stop: stop)
          .agentReferenceDate(SnapshotTests.now),
        size: CGSize(width: 440, height: 700)
      ).filter { $0.tooltipContent()?.lines.first?.text == "Stop" }
    }
    let inChat = stops(tab: .chat)
    #expect(inChat.count == 1, "only the chat bar's")
    let button = try #require(inChat.first)
    #expect(button.command == "agent.stop")
    #expect(button.tooltipContent()?.lines.first?.keys == KeyShortcut("."))
    let inArtifacts = stops(tab: .artifacts)
    #expect(inArtifacts.count == 1, "the header's")
    #expect(inArtifacts.first?.command == "agent.stop")
  }

  @Test func messagesAndCodeBlocksOfferCopy() {
    let found = tooltips(
      tooltipAnchors(
        of: VStack {
          TextMessageView(
            message: TextMessage(
              id: "m", author: "orchestrator", createdAt: 0, role: .agent,
              text: "Run this:\n\n```sh\nls -la\n```"),
            now: SnapshotTests.now)
        }, size: CGSize(width: 400, height: 240)))
    #expect(found["Copy message"] != nil)
    #expect(found["Copy code"] != nil)
  }

  @Test func theOrchestratorsChatNamesItsControlsAndLinks() {
    let inbox = tooltips(
      tooltipAnchors(
        of: AgentPanel(store: store, selectedThreadId: .constant(nil)).agentReferenceDate(
          SnapshotTests.now), size: CGSize(width: 400, height: 820)))
    #expect(inbox["Open the orchestrator's chat"] != nil)

    var summary = store.orchestratorSummary!
    summary.status = .working
    store.apply(.threadUpsert(summary))
    let chat = tooltips(
      tooltipAnchors(
        of: AgentPanel(
          store: store, selectedThreadId: .constant(OrchestratorThread.id), onHide: {},
          onOpenOrchestratorWindow: {}
        ).agentReferenceDate(SnapshotTests.now), size: CGSize(width: 440, height: 1_300)))
    for name in ["Stop this run", "Open in a separate window", "Open this task's thread"] {
      #expect(chat[name] != nil, "\(name) has a tooltip")
    }
    for content in chat.values {
      #expect(!content.plainText.contains { "⌘⌥⌃⇧".contains($0) }, "\(content.plainText)")
    }
  }

  @Test func sendExplainsReturnAndShiftReturn() {
    #expect(
      Composer.sendTooltip.lines == [
        .init("Send", keys: .returnKey), .init("New line", keys: .shiftReturn),
      ])
  }

  @Test func theMenuBarWindowDrawsItsShortcutsAsKeycaps() {
    #expect(AgentMenuBarContent.quitKeys.caps == ["⌘", "Q"])
  }
}
