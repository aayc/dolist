import DailyDoListAgent
import DailyDoListUI
import SwiftUI

/// A section of Settings → Always-On.
enum AlwaysOnSection: String, CaseIterable, Identifiable {
  case agentLocation, alwaysOnMachine, sync, devices

  var id: String { rawValue }

  /// Short: the segments are as wide as the widest (each section's header says the rest).
  var title: String {
    switch self {
    case .agentLocation: "Location"
    case .alwaysOnMachine: "Machine"
    case .sync: "Sync"
    case .devices: "Devices"
    }
  }

  /// Where the orchestrator control sends the user to set up what's missing.
  init(_ setUp: OrchestratorLocation.SetUp) {
    switch setUp {
    case .alwaysOnMachine: self = .alwaysOnMachine
    case .sync: self = .sync
    }
  }
}

/// Settings → Always-On: where the agent runs, the always-on machine, sync, the devices paired
/// with this daemon, and the names it answers to. A segmented control picks the section.
struct AlwaysOnSettingsPane: View {
  let model: AppModel
  let remote: RemoteSettingsStore

  var body: some View {
    @Bindable var ui = model.ui
    VStack(spacing: 0) {
      if AlwaysOnSection.allCases.count > 1 {
        Picker("Section", selection: $ui.alwaysOnSection) {
          ForEach(AlwaysOnSection.allCases) { Text($0.title).tag($0) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
        .pointingHandCursor()
        .padding(.top, 14)
      }
      Group {
        switch ui.alwaysOnSection {
        case .agentLocation: AgentLocationSection(model: model, remote: remote)
        case .alwaysOnMachine: MachineSection(model: model, remote: remote)
        case .sync: SyncSection(model: model, remote: remote)
        case .devices: DevicesSection(model: model, remote: remote)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
    .background(Color(nsColor: .windowBackgroundColor))
    .task(id: model.client.map(ObjectIdentifier.init)) { await remote.load() }
  }
}

/// What a pane says instead of its controls: not connected, or a daemon without the routes.
struct AlwaysOnUnavailableNote: View {
  let model: AppModel
  let remote: RemoteSettingsStore

  var body: some View {
    if model.client == nil {
      NotConnectedNote()
    } else if remote.isUnsupported {
      SettingsNote(
        text:
          "This daemon doesn't support the always-on machine yet. Update it to set this up here.")
    } else if let error = remote.error(.load) {
      SettingsNote(text: error, tone: Theme.danger)
    } else {
      ProgressView().controlSize(.small)
    }
  }
}

/// A field an environment variable sets: shown read-only, with which variable to change.
struct LockedByEnvNote: View {
  let variables: String

  var body: some View {
    Label {
      Text(SettingsCallout.inlineMarkdown("Set by \(variables) on this device. Change it there."))
    } icon: {
      Image(systemName: "lock.fill")
    }
    .font(.caption)
    .foregroundStyle(.secondary)
  }
}
