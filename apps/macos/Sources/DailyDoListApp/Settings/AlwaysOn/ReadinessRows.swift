import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// One line of a machine's readiness to run the agent: what, its state, and how to fix it.
struct ReadinessItem: Equatable, Identifiable {
  enum State: Equatable {
    case ready
    case problem
    /// Not available here, and not a problem (desktop control on Linux, no connectors).
    case absent
  }

  /// What fixes it on this device.
  enum Fix: Equatable {
    case agentSettings, computerUse, connectors
  }

  var id: String { title }
  var title: String
  var state: State
  var detail: String
  var fix: Fix?

  /// The rows for a readiness report. `onThisDevice` adds the fixes this app can open; another
  /// machine's problems only get their hint.
  static func items(_ readiness: AgentReadiness, onThisDevice: Bool) -> [ReadinessItem] {
    let harness = readiness.harness.knownKind
    var items: [ReadinessItem] = [
      ReadinessItem(
        title: "Agent", state: readiness.harness.ready ? .ready : .problem,
        detail: readiness.harness.ready
          ? harness?.settingsLabel ?? readiness.harness.kind
          : readiness.harness.problem ?? "Not ready.",
        fix: readiness.harness.ready || !onThisDevice ? nil : .agentSettings),
      ReadinessItem(
        title: "Model credential", state: readiness.modelCredential ? .ready : .problem,
        detail: readiness.modelCredential
          ? "Present" : credentialHint(harness)),
      ReadinessItem(
        title: "Browser", state: readiness.browser ? .ready : .problem,
        detail: readiness.browser ? "Available" : "Not available. Install Google Chrome."),
    ]
    switch readiness.computer {
    case .available:
      items.append(ReadinessItem(title: "Desktop control", state: .ready, detail: "Available"))
    case .needsPermissions:
      items.append(
        ReadinessItem(
          title: "Desktop control", state: .problem,
          detail: "Needs Accessibility and Screen Recording.",
          fix: onThisDevice ? .computerUse : nil))
    default:
      items.append(
        ReadinessItem(title: "Desktop control", state: .absent, detail: "Not on this machine"))
    }
    let connectors = readiness.connectors
    if connectors.configured == 0 {
      items.append(ReadinessItem(title: "Connectors", state: .absent, detail: "None configured"))
    } else {
      items.append(
        ReadinessItem(
          title: "Connectors",
          state: connectors.connected >= connectors.configured ? .ready : .problem,
          detail: "\(connectors.connected) of \(connectors.configured) connected",
          fix: onThisDevice && connectors.connected < connectors.configured ? .connectors : nil))
    }
    return items
  }

  static func credentialHint(_ harness: AgentHarnessKind?) -> String {
    switch harness {
    case .cursor?: "Missing. Sign in to the Cursor CLI: run `agent login` in a terminal."
    default:
      "Missing. Add `OPENROUTER_API_KEY` to `~/.daily-do-list/.env`, then restart the daemon."
    }
  }
}

/// A machine's readiness as grouped-form rows.
struct ReadinessRows: View {
  let items: [ReadinessItem]
  var onFix: ((ReadinessItem.Fix) -> Void)?

  var body: some View {
    ForEach(items) { item in
      LabeledContent {
        if let fix = item.fix, let onFix {
          fixButton(fix) { onFix(fix) }
        }
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          icon(item.state)
          VStack(alignment: .leading, spacing: 2) {
            Text(item.title)
            Text(SettingsCallout.inlineMarkdown(item.detail))
              .font(.caption)
              .foregroundStyle(item.state == .problem ? Theme.warning : .secondary)
              .fixedSize(horizontal: false, vertical: true)
              .textSelection(.enabled)
          }
        }
      }
      .accessibilityElement(children: .combine)
    }
  }

  @ViewBuilder private func icon(_ state: ReadinessItem.State) -> some View {
    switch state {
    case .ready:
      Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.success)
    case .problem:
      Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warning)
    case .absent:
      Image(systemName: "minus.circle").foregroundStyle(Theme.faintText)
    }
  }

  @ViewBuilder
  private func fixButton(_ fix: ReadinessItem.Fix, action: @escaping () -> Void) -> some View {
    switch fix {
    case .agentSettings:
      Button("Agent Settings…", action: action).pointingHandCursor()
    case .computerUse:
      Button("Set Up…", action: action)
        .pointingHandCursor()
        .tooltip("Open Settings → Computer Use", command: .setUpComputerUse)
    case .connectors:
      Button("Connectors…", action: action).pointingHandCursor()
    }
  }
}
