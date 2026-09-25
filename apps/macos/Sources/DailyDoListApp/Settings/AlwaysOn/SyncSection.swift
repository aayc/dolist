import DailyDoListDomain
import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// Settings → Always-On → Sync: the sync service's address, the vault and its token (write-only:
/// "Saved", never shown), the sync status, and turning sync off. Values an environment variable
/// sets are read-only.
struct SyncSection: View {
  let model: AppModel
  let remote: RemoteSettingsStore
  @State private var confirmingTurnOff = false

  var body: some View {
    Form {
      if let device = remote.device {
        if device.isLocked(.sync) {
          Section("Sync service") {
            LabeledContent("Address", value: device.sync.url ?? "Not set")
            LabeledContent("Vault", value: device.sync.vault ?? "Not set")
            LabeledContent("Vault token", value: device.sync.hasToken ? "Saved" : "Not set")
            LockedByEnvNote(variables: "`DDL_SYNC_URL`, `DDL_SYNC_VAULT` and `DDL_SYNC_TOKEN`")
          }
        } else {
          SyncSetupForm(remote: remote, setup: device.sync)
            .id(device.sync)
        }
        if device.sync.url != nil {
          SyncStatusRows(status: remote.syncStatus)
          if !device.isLocked(.sync) {
            Section {
              HStack {
                Spacer()
                Button("Turn Off Sync…", role: .destructive) { confirmingTurnOff = true }
                  .pointingHandCursor()
                  .disabled(remote.isBusy(.turnOffSync))
              }
              if let error = remote.error(.turnOffSync) {
                SettingsNote(text: error, tone: Theme.danger)
              }
            }
          }
        }
      } else {
        Section { AlwaysOnUnavailableNote(model: model, remote: remote) }
      }
    }
    .formStyle(.grouped)
    .alert("Turn off sync?", isPresented: $confirmingTurnOff) {
      Button("Turn Off", role: .destructive) { Task { await remote.turnOffSync() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        "This device stops syncing and forgets the vault token. Your notes stay in this folder, and the agent runs on this device."
      )
    }
  }
}

/// The address, the vault and the token, checked as they're typed.
private struct SyncSetupForm: View {
  let remote: RemoteSettingsStore
  let setup: DeviceSyncSetup
  @State private var url = ""
  @State private var vault = ""
  @State private var token = ""
  @State private var replacingToken = false

  var body: some View {
    Section {
      TextField("Address", text: $url, prompt: Text("https://sync.example.com"))
      if let problem = urlProblem { SettingsNote(text: problem, tone: Theme.danger) }
      TextField("Vault", text: $vault, prompt: Text("The vault's id"))
      if let problem = vaultProblem { SettingsNote(text: problem, tone: Theme.danger) }
      if setup.hasToken && !replacingToken {
        LabeledContent("Vault token") {
          HStack(spacing: 10) {
            Label("Saved", systemImage: "checkmark.seal.fill").foregroundStyle(Theme.success)
            Button("Replace…") { replacingToken = true }.pointingHandCursor()
          }
        }
      } else {
        SecureField("Vault token", text: $token, prompt: Text("Paste the vault token"))
      }
      HStack {
        Spacer()
        Button(buttonTitle) { Task { await save() } }
          .buttonStyle(.borderedProminent)
          .pointingHandCursor()
          .disabled(!canSave || remote.isBusy(.sync))
      }
      if let error = remote.error(.sync) { SettingsNote(text: error, tone: Theme.danger) }
    } header: {
      Text("Sync service")
    } footer: {
      SettingsNote(
        text:
          "The address, vault id and token come from the sync service (`ddl-sync vault create`). The always-on machine works from the synced vault. The token stays on this device and is never shown again.",
        markdown: true)
    }
    .onAppear {
      url = setup.url ?? ""
      vault = setup.vault ?? ""
    }
  }

  private var buttonTitle: String {
    if remote.isBusy(.sync) { return "Saving…" }
    return setup.url == nil ? "Turn On Sync" : "Save"
  }

  private var trimmedURL: String { url.trimmingCharacters(in: .whitespaces) }
  private var trimmedVault: String { vault.trimmingCharacters(in: .whitespaces) }
  private var trimmedToken: String { token.trimmingCharacters(in: .whitespacesAndNewlines) }

  private var urlProblem: String? {
    guard !trimmedURL.isEmpty, !RemoteAccess.isSecureServiceURL(trimmedURL) else { return nil }
    return "Use https (plain http only to this Mac), without a user name or password."
  }

  private var vaultProblem: String? {
    guard !trimmedVault.isEmpty, !RemoteAccess.isSyncID(trimmedVault) else { return nil }
    return "A vault id is 1–64 letters, digits, _ or -."
  }

  private var needsToken: Bool { !setup.hasToken || replacingToken }

  private var canSave: Bool {
    guard RemoteAccess.isSecureServiceURL(trimmedURL), RemoteAccess.isSyncID(trimmedVault) else {
      return false
    }
    if needsToken { return !trimmedToken.isEmpty }
    return trimmedURL != setup.url || trimmedVault != setup.vault
  }

  private func save() async {
    let saved = await remote.setUpSync(
      url: trimmedURL, vault: trimmedVault, token: needsToken ? trimmedToken : nil)
    if saved {
      token = ""
      replacingToken = false
    }
  }
}

/// How syncing goes.
private struct SyncStatusRows: View {
  let status: SyncStatusResponse?

  var body: some View {
    Section("Status") {
      if let status {
        LabeledContent("State") {
          Text(Self.stateText(status.state)).foregroundStyle(Self.stateColor(status.state))
        }
        if let lastError = status.lastError {
          SettingsNote(text: lastError, tone: Theme.danger)
        }
        if let lastSyncedAt = status.lastSyncedAt {
          LabeledContent("Last synced") {
            Text("\(Date(epochMillis: lastSyncedAt), style: .relative) ago")
          }
        }
        LabeledContent(
          "Waiting to sync", value: TextMetrics.pluralize(status.pendingChanges, "change"))
        if !status.conflicts.isEmpty {
          LabeledContent("Conflict copies", value: "\(status.conflicts.count)")
        }
        if let name = status.deviceName {
          LabeledContent("This device is called", value: name)
        }
      } else {
        SettingsNote(text: "The sync status isn't available.")
      }
    }
  }

  static func stateText(_ state: SyncState) -> String {
    switch state {
    case .idle: "Up to date"
    case .syncing: "Syncing…"
    case .error: "Failing"
    case .disabled: "Off"
    default: state.rawValue
    }
  }

  static func stateColor(_ state: SyncState) -> Color {
    switch state {
    case .idle: Theme.success
    case .error: Theme.danger
    default: .secondary
    }
  }
}
