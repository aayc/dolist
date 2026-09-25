import DailyDoListDaemon
import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// Daemon connection (managed/external, URL/port, DDL_HOME, vault, agent mode), restart, live
/// status and log, launch at login and the global hotkey.
struct GeneralSettingsPane: View {
  let model: AppModel
  @Bindable var preferences: AppPreferences
  @State private var loginError: String?
  @State private var hotkeyError: String?
  @State private var isApplying = false

  var body: some View {
    Form {
      Section("Daemon") {
        LabeledContent("Daemon") {
          Picker("Daemon", selection: $preferences.daemonMode) {
            ForEach(DaemonMode.allCases) { Text($0.title).tag($0) }
          }
          .pickerStyle(.segmented)
          .labelsHidden()
          .pointingHandCursor()
        }
        if model.isDemo {
          SettingsNote(
            text:
              "Running in demo mode (--demo): an in-memory daemon with sample notes. Connection settings apply on the next normal launch."
          )
        }
        switch preferences.daemonMode {
        case .external:
          CommitTextField(
            title: "URL", value: preferences.externalBaseURL, prompt: "http://127.0.0.1:7331"
          ) {
            preferences.externalBaseURL = $0.trimmingCharacters(in: .whitespaces)
          }
          if preferences.externalURL == nil {
            SettingsNote(text: "Enter an http(s) URL.", tone: Theme.danger)
          }
          SettingsNote(
            text:
              "Connects to a daemon started elsewhere (e.g. `pnpm dev`) using the token in DDL_HOME."
          )
        case .managed:
          CommitTextField(
            title: "Port", value: preferences.managedPortOverride.map(String.init) ?? "",
            prompt: String(DaemonLaunchConfiguration.standard().port)
          ) { text in
            let port = Int(text.trimmingCharacters(in: .whitespaces))
            preferences.managedPortOverride = port.flatMap { (1...65_535).contains($0) ? $0 : nil }
          }
          LabeledContent("Agent mode") {
            Picker("Agent mode", selection: agentModeBinding) {
              Text("Default").tag(AgentMode?.none)
              Text("Live").tag(AgentMode?.some(.live))
              Text("Mock (no model)").tag(AgentMode?.some(.mock))
              Text("Off").tag(AgentMode?.some(.off))
            }
            .labelsHidden()
            .fixedSize()
            .pointingHandCursor()
          }
          LabeledContent("Vault") {
            HStack {
              Text(preferences.vaultPath.map(FolderPicker.display) ?? "Daemon default")
                .foregroundStyle(preferences.vaultPath == nil ? .secondary : .primary)
                .lineLimit(1)
                .truncationMode(.middle)
              Button("Choose…") {
                if let url = FolderPicker.choose(
                  title: "Choose the vault folder", startingAt: preferences.vaultPath)
                {
                  preferences.vaultPath = url.path
                }
              }
              .pointingHandCursor()
              if preferences.vaultPath != nil {
                Button("Reset") { preferences.vaultPath = nil }.pointingHandCursor()
              }
            }
          }
        }
        LabeledContent("DDL_HOME") {
          HStack {
            Text(FolderPicker.display(preferences.homeURL.path))
              .lineLimit(1)
              .truncationMode(.middle)
            Button("Choose…") {
              if let url = FolderPicker.choose(
                title: "Choose DDL_HOME", startingAt: preferences.homeURL.path)
              {
                preferences.homeOverride = url.path
              }
            }
            .pointingHandCursor()
            if preferences.homeOverride != nil {
              Button("Reset") { preferences.homeOverride = nil }.pointingHandCursor()
            }
          }
        }
        HStack {
          Button(isApplying ? "Reconnecting…" : "Apply & Reconnect") {
            run { await model.boot() }
          }
          .pointingHandCursor()
          if preferences.daemonMode == .managed, !model.isDemo {
            Button("Restart Daemon") { run { await model.restartDaemon() } }.pointingHandCursor()
          }
        }
        .disabled(isApplying)
      }

      Section("Status") {
        LabeledContent("Connection") {
          Text(model.connection.label).foregroundStyle(
            model.connection.isOnline ? Theme.success : Theme.warning)
        }
        SettingsNote(text: model.connection.detail)
        if preferences.daemonMode == .managed, !model.isDemo {
          LabeledContent("Supervisor", value: model.supervisor.state.summary)
          if let error = model.supervisor.lastError {
            SettingsNote(text: error.summary, tone: Theme.danger)
          }
        }
        if let health = model.connection.health {
          LabeledContent(
            "Daemon", value: "\(health.version) · API v\(health.apiVersion) · \(health.vaultName)")
        }
        if preferences.daemonMode == .managed, !model.isDemo {
          DaemonLogView(supervisor: model.supervisor)
        }
      }

      Section("Startup") {
        SettingsToggle(
          "Open Daily Do List at login",
          isOn: Binding(
            get: { model.systemIntegration.isLaunchAtLoginEnabled },
            set: { loginError = model.setLaunchAtLogin($0) })
        )
        .disabled(isUnavailable(model.systemIntegration.launchAtLoginAvailability))
        if let message = loginError ?? model.systemIntegration.launchAtLoginAvailability.message {
          SettingsNote(text: message, tone: loginError == nil ? .secondary : Theme.danger)
          if case .requiresApproval = model.systemIntegration.launchAtLoginAvailability {
            Button("Open Login Items Settings…") {
              model.systemIntegration.openLoginItemsSettings()
            }
            .pointingHandCursor()
          }
        }
        SettingsToggle(
          "Global shortcut opens today's note",
          isOn: Binding(
            get: { preferences.globalHotkeyEnabled },
            set: {
              preferences.globalHotkeyEnabled = $0
              hotkeyError = model.applyGlobalHotkeyPreference()
            }))
        if preferences.globalHotkeyEnabled {
          CommitTextField(
            title: "Shortcut",
            value: preferences.globalHotkey ?? model.systemIntegration.defaultGlobalShortcut,
            prompt: model.systemIntegration.defaultGlobalShortcut
          ) { text in
            let trimmed = text.trimmingCharacters(in: .whitespaces)
            preferences.globalHotkey = trimmed.isEmpty ? nil : trimmed
            hotkeyError = model.applyGlobalHotkeyPreference()
          }
          if let keys = model.globalHotkeyKeys {
            LabeledContent("Opens today's note from any app") { Keycaps(keys) }
          }
          if let message = hotkeyError ?? model.systemIntegration.globalHotkeyAvailability.message {
            SettingsNote(text: message, tone: hotkeyError == nil ? .secondary : Theme.danger)
          }
        }
      }
    }
    .formStyle(.grouped)
    .onAppear { model.systemIntegration.refresh() }
  }

  private var agentModeBinding: Binding<AgentMode?> {
    Binding(get: { preferences.agentMode }, set: { preferences.agentMode = $0 })
  }

  private func isUnavailable(_ availability: IntegrationAvailability) -> Bool {
    if case .unavailable = availability { return true }
    return false
  }

  private func run(_ action: @escaping @MainActor () async -> Void) {
    isApplying = true
    Task {
      await action()
      isApplying = false
    }
  }
}

/// The managed daemon's recent output.
struct DaemonLogView: View {
  let supervisor: DaemonSupervising

  var body: some View {
    DisclosureGroup("Daemon log (\(supervisor.logLines.count) lines)") {
      ScrollViewReader { proxy in
        ScrollView {
          Text(supervisor.logLines.suffix(500).joined(separator: "\n"))
            .font(.system(size: 11, design: .monospaced))
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
            .id("log-end")
        }
        .frame(height: 160)
        .onAppear { proxy.scrollTo("log-end", anchor: .bottom) }
      }
      HStack {
        Button("Copy") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(
            supervisor.logLines.joined(separator: "\n"), forType: .string)
        }
        .pointingHandCursor()
        Button("Clear") { supervisor.clearLogs() }.pointingHandCursor()
      }
      .controlSize(.small)
    }
  }
}
