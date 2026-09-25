import DailyDoListAgent
import DailyDoListClient
import DailyDoListEditor
import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// Status line under the note, quiet by default (``StatusBarVisibility``) and drawn on the note's
/// own background: the agent's state (``AgentStatusPresentation``, + mode unless live), running
/// count, approvals (→ inbox), save state while not saved, word count, connection while not
/// connected (or a "Demo" marker). Items that do something highlight under the pointer.
struct StatusBar: View {
  let model: AppModel
  let workspace: Workspace

  var body: some View {
    let visibility = StatusBarVisibility(
      saveState: workspace.tabs.active.flatMap { workspace.notes.saveStates[$0] },
      connection: model.connection.state, isDemo: model.connection.isDemo,
      agentMode: model.agent?.status?.mode)
    HStack(spacing: 14) {
      if let agent = model.agent {
        AgentStatusItems(model: model, agent: agent, mode: visibility.agentMode)
      }
      Spacer(minLength: 8)
      if let state = visibility.saveState {
        SaveIndicator(state: state)
      }
      if model.settings.settings.editor.vimMode, workspace.tabs.active != nil {
        VimIndicator(status: workspace.editor.vimStatus)
      }
      if workspace.tabs.active != nil, let words = workspace.editor.wordCount {
        Text(TextMetrics.pluralize(words, "word"))
          .foregroundStyle(Theme.mutedText)
      }
      switch visibility.connection {
      case .demo:
        Pill(text: "Demo", color: Theme.mutedText)
          .tooltip(TooltipContent.sentence(model.connection.detail))
      case .problem:
        ConnectionIndicator(connection: model.connection)
      case nil:
        EmptyView()
      }
    }
    .lineLimit(1)
    .font(.system(size: 11))
    .foregroundStyle(Theme.mutedText)
    // The agent items bring 6 pt of their own (their hover highlight).
    .padding(.leading, 6)
    .padding(.trailing, 12)
    .frame(height: Theme.statusBarHeight)
  }
}

extension ButtonStyle where Self == ChromeButtonStyle {
  /// A status bar item that does something: a rounded highlight under the pointer.
  fileprivate static var statusItem: ChromeButtonStyle {
    ChromeButtonStyle(cornerRadius: 5, horizontalPadding: 6, verticalPadding: 3)
  }
}

struct AgentStatusItems: View {
  let model: AppModel
  let agent: AgentStore
  /// Shown next to the agent's state while it isn't live (mock).
  let mode: AgentMode?
  @State private var explaining = false
  @Environment(\.openSettings) private var openSettings
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    if let presentation = AgentStatusPresentation(status: agent.status) {
      Button {
        if presentation.toggles, let status = agent.status {
          Task { await model.setAgentEnabled(!status.enabled) }
        } else {
          explaining = true
        }
      } label: {
        HStack(spacing: 5) {
          Image(systemName: presentation.systemImage).foregroundStyle(iconColor(presentation.state))
          Text(presentation.label)
            .foregroundStyle(presentation.state == .unavailable ? Theme.danger : Theme.mutedText)
          if let mode, mode != .off {
            Text(mode.rawValue).foregroundStyle(Theme.faintText)
          }
        }
      }
      .buttonStyle(.statusItem)
      .tooltip(presentation.tooltip, accessibility: .none)
      .accessibilityLabel(accessibilityLabel(presentation))
      .popover(isPresented: $explaining, arrowEdge: .top) {
        AgentProblemPopover(presentation: presentation) {
          explaining = false
          model.ui.settingsPane = .agent
          openSettings()
        }
      }
    }

    if agent.runningCount > 0 {
      HStack(spacing: 4) {
        ProgressView().controlSize(.mini)
        Text("\(agent.runningCount) running")
      }
      .foregroundStyle(Theme.mutedText)
      .tooltip(runningTooltip)
    }
    Group {
      if agent.pendingApprovalCount > 0 {
        Button {
          model.ui.showInbox()
        } label: {
          Label("\(agent.pendingApprovalCount) to approve", systemImage: "exclamationmark.shield")
            .foregroundStyle(Theme.warning)
            .popOnChange(of: agent.pendingApprovalCount)
        }
        .buttonStyle(.statusItem)
        .tooltip("Open agent inbox", command: .agentInbox)
        .countTransition()
      }
    }
    .animation(
      .countAppearance(reduceMotion: reduceMotion), value: agent.pendingApprovalCount > 0)

    if let policy = ApprovalPolicyIndicator(model.settings.settings.agent.approvalPolicy) {
      Button {
        CommandCatalog(model: model).run(.approvalPolicy)
      } label: {
        Label(policy.label, systemImage: policy.systemImage)
          .foregroundStyle(policy.isWarning ? Theme.warning : Theme.mutedText)
      }
      .buttonStyle(.statusItem)
      .tooltip(policy.tooltip, command: .approvalPolicy)
    }
  }

  /// "2 agent tasks running · 1 queued" (the web app's wording).
  private var runningTooltip: String {
    let running = agent.runningCount
    let queued = agent.status?.queued ?? 0
    let tasks = running == 1 ? "1 agent task" : "\(running) agent tasks"
    return "\(tasks) running" + (queued > 0 ? " · \(queued) queued" : "")
  }

  private func iconColor(_ state: AgentStatusPresentation.State) -> Color {
    switch state {
    case .on: Theme.accent
    case .paused, .off: Theme.faintText
    case .unavailable: Theme.danger
    }
  }

  private func accessibilityLabel(_ presentation: AgentStatusPresentation) -> String {
    switch presentation.state {
    case .on: "Agent on. Pause agent"
    case .paused: "Agent paused. Resume agent"
    case .off, .unavailable: "\(presentation.label). Show details"
    }
  }
}

/// Why the agent isn't running, and the way to Settings → Agent.
private struct AgentProblemPopover: View {
  let presentation: AgentStatusPresentation
  let openAgentSettings: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Label(
        presentation.state == .off ? "The agent is off" : "The agent can't run right now",
        systemImage: presentation.systemImage
      )
      .font(.system(size: 13, weight: .semibold))
      .foregroundStyle(presentation.state == .off ? Theme.text : Theme.danger)
      Text(presentation.detail)
        .font(.system(size: 12))
        .foregroundStyle(Theme.text)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
      HStack {
        Spacer()
        Button("Agent Settings…", action: openAgentSettings)
          .controlSize(.small)
          .pointingHandCursor()
      }
    }
    .padding(14)
    .frame(width: 320)
  }
}

/// Vim's mode line, like the web app's: macro recording, pending keys ("showcmd") and the mode,
/// in the accent color (insert and replace green, visual modes amber).
struct VimIndicator: View {
  let status: EditorVimStatus?

  var body: some View {
    HStack(spacing: 6) {
      if let recording = status?.recording {
        Text("recording @\(recording)").fontWeight(.regular).foregroundStyle(Theme.danger)
      }
      if let pending = status?.pending, !pending.isEmpty {
        Text(pending).fontWeight(.regular).foregroundStyle(Theme.mutedText)
      }
      Text(status?.mode.label ?? "VIM").foregroundStyle(Self.color(status?.mode))
    }
    .font(.system(size: 11, weight: .semibold, design: .monospaced))
    .tracking(0.4)
    .tooltip("Vim mode", accessibility: .none)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Vim \(status?.mode.label.lowercased() ?? "mode")")
  }

  static func color(_ mode: EditorVimStatus.Mode?) -> Color {
    switch mode {
    case .insert, .replace: Theme.success
    case .visual, .visualLine, .visualBlock: Theme.warning
    case .normal, nil: Theme.accent
    }
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
      case .conflict:
        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warning)
      case .error: Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.danger)
      }
      Text(state.label)
    }
    .foregroundStyle(state == .error ? Theme.danger : Theme.mutedText)
    .tooltip(Self.tooltip(for: state))
  }

  /// What the label doesn't say (nothing while it saves).
  static func tooltip(for state: SaveState) -> TooltipContent? {
    switch state {
    case .saved, .saving: nil
    case .dirty: TooltipContent("Saves automatically")
    case .conflict: TooltipContent("Changed elsewhere too: resolved on the next save")
    case .error: TooltipContent("Retrying automatically")
    }
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
    .tooltip(TooltipContent.sentence(connection.detail))
  }

  private var color: Color {
    switch connection.state {
    case .connected: connection.isDemo ? Theme.info : Theme.success
    case .connecting, .idle, .reconnecting: Theme.warning
    case .incompatible, .disconnected: Theme.danger
    }
  }
}
