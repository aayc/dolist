import DailyDoListModels
import SwiftUI

/// Right-hand agent panel: the inbox, or one thread when `selectedThreadId` is set. Failed
/// actions show as a dismissible toast at the bottom.
public struct AgentPanel: View {
  let store: AgentStore
  @Binding var selectedThreadId: String?
  let onShowInNote: ((TaskLocation) -> Void)?
  let onClose: (() -> Void)?
  let headerHeight: CGFloat
  let onHide: (() -> Void)?

  /// - Parameters:
  ///   - onShowInNote: opens the task's note at its line (the button is hidden when nil).
  ///   - onClose: hides the panel (the thread's Close button returns to the inbox when nil).
  ///   - headerHeight: height of the header row, to line up with the host's other pane headers.
  ///   - onHide: adds a "hide panel" button to the header. A thread then has no Close button of
  ///     its own: the header already goes back to the inbox and hides the panel.
  public init(
    store: AgentStore, selectedThreadId: Binding<String?>,
    onShowInNote: ((TaskLocation) -> Void)? = nil, onClose: (() -> Void)? = nil,
    headerHeight: CGFloat = 40, onHide: (() -> Void)? = nil
  ) {
    self.store = store
    self._selectedThreadId = selectedThreadId
    self.onShowInNote = onShowInNote
    self.onClose = onClose
    self.headerHeight = headerHeight
    self.onHide = onHide
  }

  public var body: some View {
    VStack(spacing: 0) {
      header
      Group {
        if let threadId = selectedThreadId {
          ThreadView(
            store: store, threadId: threadId, onShowInNote: onShowInNote,
            onClose: onHide == nil ? onClose ?? { selectedThreadId = nil } : nil
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
    .tint(AgentTheme.accent)
    .environment(\.openURL, LinkPolicy.openURLAction)
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
        }
        .buttonStyle(.borderless)
        .help("Back to the inbox")
      } else {
        Label("Inbox", systemImage: "tray")
          .font(.system(size: 13, weight: .semibold))
      }
      if pending > 0 {
        CountBadge(count: pending, tone: .warning, systemImage: "exclamationmark.shield.fill")
          .help(pending == 1 ? "1 approval waiting" : "\(pending) approvals waiting")
      }
      Spacer(minLength: 8)
      AgentStatusIndicator(store: store)
      if let onHide {
        IconButton(systemImage: "sidebar.right", help: "Hide agent panel (⌘\\)", action: onHide)
      }
    }
    .padding(.leading, 12)
    .padding(.trailing, onHide == nil ? 12 : 6)
    .frame(height: headerHeight)
    .overlay(alignment: .bottom) { AgentHairline() }
  }
}
