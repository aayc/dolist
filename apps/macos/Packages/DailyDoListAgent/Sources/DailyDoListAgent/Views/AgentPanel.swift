import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// The host's keyboard shortcuts for what the agent panel's buttons do (their tooltips show them).
public struct AgentPanelShortcuts: Hashable, Sendable {
  /// A command of the host: its id (tests match the keys against the host's catalog) and keys.
  public struct Command: Hashable, Sendable {
    public var id: String?
    public var keys: KeyShortcut?

    public init(id: String? = nil, keys: KeyShortcut? = nil) {
      self.id = id
      self.keys = keys
    }
  }

  /// Hides the panel (the header's hide button).
  public var hidePanel: KeyShortcut?
  /// Shows the inbox (a thread's back button).
  public var inbox: KeyShortcut?
  /// Stops the open thread's agent (the chat bar's Stop button).
  public var stop: Command

  public init(hidePanel: KeyShortcut? = nil, inbox: KeyShortcut? = nil, stop: Command = Command()) {
    self.hidePanel = hidePanel
    self.inbox = inbox
    self.stop = stop
  }
}

/// Right-hand agent panel: the inbox, or one thread when `selectedThreadId` is set. Failed
/// actions show as a dismissible toast at the bottom.
public struct AgentPanel: View {
  let store: AgentStore
  @Binding var selectedThreadId: String?
  let onShowInNote: ((TaskLocation) -> Void)?
  let onClose: (() -> Void)?
  let headerHeight: CGFloat
  let onHide: (() -> Void)?
  let noteLinks: AgentNoteLinks
  let shortcuts: AgentPanelShortcuts
  let onOpenOrchestratorWindow: (() -> Void)?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// - Parameters:
  ///   - onShowInNote: opens the task's note at its line (the button is hidden when nil).
  ///   - onClose: hides the panel (the thread's Close button returns to the inbox when nil).
  ///   - headerHeight: height of the header row, to line up with the host's other pane headers.
  ///   - onHide: adds a "hide panel" button to the header. A thread then has no Close button of
  ///     its own: the header already goes back to the inbox and hides the panel.
  ///   - noteLinks: how `[[wikilinks]]` in agent text open and preview notes.
  ///   - shortcuts: the host's shortcuts for hiding the panel and showing the inbox.
  ///   - onOpenOrchestratorWindow: opens the orchestrator's chat in a window of its own (a button
  ///     in its header).
  public init(
    store: AgentStore, selectedThreadId: Binding<String?>,
    onShowInNote: ((TaskLocation) -> Void)? = nil, onClose: (() -> Void)? = nil,
    headerHeight: CGFloat = 40, onHide: (() -> Void)? = nil, noteLinks: AgentNoteLinks = .none,
    shortcuts: AgentPanelShortcuts = AgentPanelShortcuts(),
    onOpenOrchestratorWindow: (() -> Void)? = nil
  ) {
    self.onOpenOrchestratorWindow = onOpenOrchestratorWindow
    self.store = store
    self._selectedThreadId = selectedThreadId
    self.onShowInNote = onShowInNote
    self.onClose = onClose
    self.headerHeight = headerHeight
    self.onHide = onHide
    self.noteLinks = noteLinks
    self.shortcuts = shortcuts
  }

  public var body: some View {
    VStack(spacing: 0) {
      header
      Group {
        if let threadId = selectedThreadId, OrchestratorThread.isOrchestrator(threadId) {
          OrchestratorChatView(
            store: store, onOpenTask: { selectedThreadId = $0 },
            onOpenWindow: onOpenOrchestratorWindow,
            onClose: onHide == nil ? onClose ?? { selectedThreadId = nil } : nil)
        } else if let threadId = selectedThreadId {
          ThreadView(
            store: store, threadId: threadId, onShowInNote: onShowInNote,
            onClose: onHide == nil ? onClose ?? { selectedThreadId = nil } : nil,
            stop: shortcuts.stop
          )
          .id(threadId)
        } else {
          InboxView(store: store) { selectedThreadId = $0 }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .overlay(alignment: .bottom) {
      if let alert = store.lastError {
        AgentErrorBanner(alert: alert) { store.dismissError(alert.id) }
          .padding(10)
          .transition(.move(edge: .bottom).combined(with: .opacity))
          .task(id: alert.id) {
            try? await Task.sleep(for: .seconds(8))
            store.dismissError(alert.id)
          }
      }
    }
    .animation(.snappy(duration: 0.2), value: store.lastError?.id)
    .frame(minWidth: 300)
    .foregroundStyle(AgentTheme.text)
    .tint(AgentTheme.accent)
    .environment(\.agentNoteLinks, noteLinks)
    .environment(\.openURL, LinkPolicy.openURLAction(noteLinks: noteLinks))
  }

  private var header: some View {
    let pending = store.pendingApprovalCount
    return HStack(spacing: 8) {
      if selectedThreadId != nil {
        Button {
          selectedThreadId = nil
        } label: {
          Label("Inbox", systemImage: "chevron.left")
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(AgentTheme.accent)
        }
        .buttonStyle(ChromeButtonStyle(horizontalPadding: 6, verticalPadding: 3))
        .padding(.leading, -6)
        .tooltip("Back to inbox", keys: shortcuts.inbox, accessibility: .keysOnly)
      } else {
        Label("Inbox", systemImage: "tray")
          .font(.system(size: 13, weight: .semibold))
      }
      if pending > 0 {
        CountBadge(count: pending, tone: .warning, systemImage: "exclamationmark.shield.fill")
          .tooltip(pending == 1 ? "1 approval waiting" : "\(pending) approvals waiting")
          .countTransition()
      }
      Spacer(minLength: 8)
      AgentStatusIndicator(store: store)
      if let onHide {
        IconButton(
          "sidebar.right", label: "Hide agent panel", keys: shortcuts.hidePanel, action: onHide)
      }
    }
    .animation(.countAppearance(reduceMotion: reduceMotion), value: pending > 0)
    .padding(.leading, 12)
    .padding(.trailing, onHide == nil ? 12 : 6)
    .frame(height: headerHeight)
    .overlay(alignment: .bottom) { AgentHairline() }
  }
}
