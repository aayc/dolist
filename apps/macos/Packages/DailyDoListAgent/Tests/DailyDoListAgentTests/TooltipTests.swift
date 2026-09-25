import AppKit
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

  private func anchors<V: View>(_ view: V, size: CGSize) -> [TooltipAnchorView] {
    let host = NSHostingView(
      rootView: view.frame(width: size.width, height: size.height)
        .environment(\.tooltipCenter, QuietTooltips.makeCenter()))
    host.frame = CGRect(origin: .zero, size: size)
    let window = NSWindow(
      contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = host
    window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
    window.orderFrontRegardless()
    for _ in 0..<4 {
      host.layoutSubtreeIfNeeded()
      window.displayIfNeeded()
      RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    let anchors = tooltipAnchors(in: host)
    window.close()
    return anchors
  }

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
      anchors(
        AgentPanel(
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

  @Test func theOrchestratorsChatNamesItsControlsAndLinks() {
    let inbox = tooltips(
      anchors(
        AgentPanel(store: store, selectedThreadId: .constant(nil)).agentReferenceDate(
          SnapshotTests.now), size: CGSize(width: 400, height: 820)))
    #expect(inbox["Open the orchestrator's chat"] != nil)

    var summary = store.orchestratorSummary!
    summary.status = .working
    store.apply(.threadUpsert(summary))
    let chat = tooltips(
      anchors(
        AgentPanel(
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
