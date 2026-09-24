import DailyDoListAgent
import DailyDoListClient
import DailyDoListModels
import SwiftUI

/// Bottom bar, quiet by default (``StatusBarVisibility``): agent on/off (+ mode unless live),
/// running count, approvals (→ inbox), daemon problem, save state while not saved, word count,
/// connection while not connected (or a "Demo" marker).
struct StatusBar: View {
  let model: AppModel
  let workspace: Workspace

  var body: some View {
    let visibility = StatusBarVisibility(
      saveState: workspace.tabs.active.flatMap { workspace.notes.saveStates[$0] },
      connection: model.connection.state, isDemo: model.connection.isDemo, agentMode: model.agent?.status?.mode)
    HStack(spacing: 14) {
      if let agent = model.agent {
        AgentStatusItems(model: model, agent: agent, mode: visibility.agentMode)
      }
      Spacer(minLength: 8)
      if let state = visibility.saveState {
        SaveIndicator(state: state)
      }
      if workspace.tabs.active != nil, let words = workspace.editor.wordCount {
        Text(TextMetrics.pluralize(words, "word"))
          .foregroundStyle(Theme.mutedText)
      }
      switch visibility.connection {
      case .demo:
        Pill(text: "Demo", color: Theme.mutedText)
          .help(model.connection.detail)
      case .problem:
        ConnectionIndicator(connection: model.connection)
      case nil:
        EmptyView()
      }
    }
    .lineLimit(1)
    .font(.system(size: 11))
    .padding(.horizontal, 10)
    .frame(height: Theme.statusBarHeight)
    .background(Theme.secondaryBackground)
  }
}

struct AgentStatusItems: View {
  let model: AppModel
  let agent: AgentStore
  /// Shown next to "Agent on/off" (nil while the agent is live).
  let mode: AgentMode?

  var body: some View {
    let status = agent.status
    Button {
      guard let status else { return }
      Task { await model.setAgentEnabled(!status.enabled) }
    } label: {
      HStack(spacing: 5) {
        Image(systemName: status?.enabled == false ? "pause.circle" : "sparkles")
          .foregroundStyle(status?.enabled == false ? Theme.faintText : Theme.accent)
        Text(status.map { $0.enabled ? "Agent on" : "Agent off" } ?? "Agent")
        if let mode {
          Text(mode.rawValue).foregroundStyle(Theme.faintText)
        }
      }
    }
    .buttonStyle(.plain)
    .help(agentHelp(status))
    .accessibilityLabel(status.map { $0.enabled ? "Pause agent" : "Resume agent" } ?? "Agent")

    if agent.runningCount > 0 {
      HStack(spacing: 4) {
        ProgressView().controlSize(.mini)
        Text("\(agent.runningCount) running")
      }
      .foregroundStyle(Theme.mutedText)
      .help("\(status?.queued ?? 0) queued")
    }
    if agent.pendingApprovalCount > 0 {
      Button {
        model.ui.showInbox()
      } label: {
        Label("\(agent.pendingApprovalCount) to approve", systemImage: "exclamationmark.shield")
          .foregroundStyle(Theme.warning)
      }
      .buttonStyle(.plain)
      .help("Open the agent inbox (⇧⌘A)")
    }
    if let problem = status?.problem {
      Label("Agent problem", systemImage: "exclamationmark.triangle.fill")
        .foregroundStyle(Theme.danger)
        .help(problem + "\n\nCheck the daemon's OpenRouter key (DDL_HOME/.env) and Settings → Agent.")
    }
  }

  private func agentHelp(_ status: AgentStatusResponse?) -> String {
    guard let status else { return "Agent status unknown" }
    if let problem = status.problem { return problem }
    return status.enabled
      ? "The agent is watching your daily notes — click to pause"
      : "The agent is paused — click to resume"
  }
}

/// The active note's save state while it isn't saved.
struct SaveIndicator: View {
  let state: SaveState

  var body: some View {
    HStack(spacing: 4) {
      switch state {
      case .saved: EmptyView()
      case .saving: ProgressView().controlSize(.mini)
      case .dirty: Circle().fill(Theme.mutedText).frame(width: 6, height: 6)
      case .conflict: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warning)
      case .error: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.danger)
      }
      Text(state.label)
    }
    .foregroundStyle(state == .error ? Theme.danger : Theme.mutedText)
    .help(state == .error ? "Retrying automatically" : state.label)
  }
}

/// The daemon connection while it isn't connected: connecting, reconnecting, offline, incompatible.
struct ConnectionIndicator: View {
  let connection: ConnectionStore

  var body: some View {
    HStack(spacing: 5) {
      Circle().fill(color).frame(width: 7, height: 7)
      Text(connection.label)
    }
    .foregroundStyle(Theme.mutedText)
    .help(connection.detail)
  }

  private var color: Color {
    switch connection.state {
    case .connected: connection.isDemo ? Theme.info : Theme.success
    case .connecting, .idle, .reconnecting: Theme.warning
    case .incompatible, .disconnected: Theme.danger
    }
  }
}
