import AppKit
import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// Content of the menu bar extra (use `.menuBarExtraStyle(.window)`): agent status, pending
/// approvals with inline Approve / Deny, and quick actions.
public struct AgentMenuBarContent: View {
  let store: AgentStore
  let openTodaysNote: () -> Void
  let openTodaysNoteKeys: KeyShortcut?
  let openMainWindow: (() -> Void)?
  let openThread: ((String) -> Void)?
  let quit: () -> Void

  static let maxApprovals = 5
  /// Quit is ⌘Q everywhere on the Mac.
  static let quitKeys = KeyShortcut("q")

  /// - Parameters:
  ///   - openTodaysNoteKeys: the host's global shortcut for it, while it's on (shown as keycaps).
  ///   - openMainWindow: shows the main window (the item is hidden when nil).
  ///   - openThread: opens a thread in the main window when an approval's text is clicked.
  public init(
    store: AgentStore, openTodaysNote: @escaping () -> Void,
    openTodaysNoteKeys: KeyShortcut? = nil, openMainWindow: (() -> Void)? = nil,
    openThread: ((String) -> Void)? = nil,
    quit: @escaping () -> Void = { NSApp?.terminate(nil) }
  ) {
    self.store = store
    self.openTodaysNote = openTodaysNote
    self.openTodaysNoteKeys = openTodaysNoteKeys
    self.openMainWindow = openMainWindow
    self.openThread = openThread
    self.quit = quit
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      statusSection.padding(12)
      Divider()
      approvalsSection.padding(.vertical, 8)
      Divider()
      actionsSection.padding(6)
    }
    .frame(width: 320)
    .tint(AgentTheme.accent)
  }

  // MARK: Status

  private var statusSection: some View {
    HStack(alignment: .center, spacing: 10) {
      Image(systemName: "checklist")
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(AgentTheme.accent)
        .frame(width: 30, height: 30)
        .background(RoundedRectangle(cornerRadius: 7).fill(AgentTheme.accent.opacity(0.13)))
      VStack(alignment: .leading, spacing: 2) {
        Text("Daily Do List").font(.headline)
        Text(verbatim: statusLine)
          .font(.caption)
          .foregroundStyle(store.status?.problem == nil ? AgentTheme.mutedText : AgentTheme.danger)
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }

  private var statusLine: String {
    guard let status = store.status else { return "Connecting to the agent…" }
    if let problem = status.problem, !problem.isEmpty { return problem }
    let mode = status.mode == .off ? "Off" : status.mode == .mock ? "Mock mode" : "Live"
    var parts = [mode, status.enabled ? "On" : "Paused", "\(status.running) running"]
    if status.queued > 0 { parts.append("\(status.queued) queued") }
    return parts.joined(separator: " · ")
  }

  // MARK: Approvals

  @ViewBuilder private var approvalsSection: some View {
    let pending = store.pendingApprovals
    if pending.isEmpty {
      Label("No approvals waiting", systemImage: "checkmark.shield")
        .font(.callout)
        .foregroundStyle(AgentTheme.mutedText)
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    } else {
      VStack(alignment: .leading, spacing: 2) {
        Text(pending.count == 1 ? "1 approval waiting" : "\(pending.count) approvals waiting")
          .font(.caption.weight(.semibold))
          .foregroundStyle(AgentTheme.warning)
          .padding(.horizontal, 12)
          .padding(.bottom, 2)
        ForEach(pending.prefix(Self.maxApprovals)) { approval in
          MenuApprovalRow(
            approval: approval,
            threadTitle: approval.threadId.flatMap { store.threadTitle($0) },
            isDeciding: store.decidingApprovalIds.contains(approval.id),
            onApprove: { Task { await store.decide(approval.id, .approve, scope: .once) } },
            onDeny: { Task { await store.decide(approval.id, .deny) } },
            onOpen: approval.threadId.flatMap { threadId in
              openThread.map { open in { open(threadId) } }
            })
        }
        if pending.count > Self.maxApprovals {
          Text("+\(pending.count - Self.maxApprovals) more in the app")
            .font(.caption)
            .foregroundStyle(AgentTheme.mutedText)
            .padding(.horizontal, 12)
            .padding(.top, 2)
        }
      }
    }
  }

  // MARK: Actions

  private var actionsSection: some View {
    let enabled = store.status?.enabled ?? false
    return VStack(alignment: .leading, spacing: 0) {
      MenuRowButton(
        title: "Open Today's Note", systemImage: "calendar", shortcut: openTodaysNoteKeys,
        action: openTodaysNote)
      MenuRowButton(
        title: enabled ? "Pause Agent" : "Resume Agent",
        systemImage: enabled ? "pause.circle" : "play.circle"
      ) {
        Task { await store.setEnabled(!enabled) }
      }
      .disabled(store.status == nil || store.status?.mode == .off)
      if let openMainWindow {
        MenuRowButton(title: "Open Daily Do List", systemImage: "macwindow", action: openMainWindow)
      }
      Divider().padding(.vertical, 4).padding(.horizontal, 6)
      MenuRowButton(
        title: "Quit Daily Do List", systemImage: "power", shortcut: Self.quitKeys, action: quit)
    }
  }
}

private struct MenuApprovalRow: View {
  let approval: ApprovalRequest
  let threadTitle: String?
  let isDeciding: Bool
  let onApprove: () -> Void
  let onDeny: () -> Void
  let onOpen: (() -> Void)?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let onOpen {
        Button(action: onOpen) { summary }
          .buttonStyle(RowButtonStyle(cornerRadius: 6))
          .accessibilityHint("Opens the thread")
      } else {
        summary
      }
      HStack(spacing: 6) {
        if isDeciding { ProgressView().controlSize(.small) }
        Spacer()
        Button(role: .destructive, action: onDeny) {
          Text("Deny").foregroundStyle(AgentTheme.danger)
        }
        .controlSize(.small)
        .pointingHandCursor()
        Button("Approve", action: onApprove).buttonStyle(.borderedProminent).controlSize(.small)
          .pointingHandCursor()
      }
      .disabled(isDeciding)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
  }

  /// What's asked and for which task (clicking it opens the thread when the host can).
  private var summary: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: "exclamationmark.shield.fill").foregroundStyle(approval.risk.tone.color)
      VStack(alignment: .leading, spacing: 2) {
        Text(verbatim: approval.summary)
          .font(.callout.weight(.medium))
          .lineLimit(3)
          .fixedSize(horizontal: false, vertical: true)
        Text(
          verbatim: [threadTitle, approval.risk.displayLabel].compactMap { $0 }.joined(
            separator: " · ")
        )
        .font(.caption)
        .foregroundStyle(AgentTheme.mutedText)
        .lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .contentShape(Rectangle())
  }
}

/// A menu row the window draws itself: icon, title and the shortcut's keycaps.
private struct MenuRowButton: View {
  let title: String
  let systemImage: String
  var shortcut: KeyShortcut?
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        Image(systemName: systemImage).frame(width: 18).foregroundStyle(AgentTheme.mutedText)
        Text(title)
        Spacer()
        if let shortcut { Keycaps(shortcut) }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .contentShape(Rectangle())
    }
    .buttonStyle(RowButtonStyle(cornerRadius: 6))
  }
}
