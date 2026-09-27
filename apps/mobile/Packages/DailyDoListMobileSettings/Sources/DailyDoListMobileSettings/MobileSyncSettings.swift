#if canImport(UIKit)
  import DailyDoListDomain
  import DailyDoListModels
  import SwiftUI

  struct MobileSyncSettings: View {
    let store: MobileSettingsStore
    @State private var url = ""
    @State private var vault = ""
    @State private var token = ""
    @State private var replacingToken = false
    @State private var confirmingDisable = false
    var body: some View {
      Form {
        Section("Sync on \(store.hostName)") {
          if let device = store.device {
            if device.isLocked(.sync) {
              LabeledContent("Address", value: device.sync.url ?? "Not configured")
              LabeledContent("Vault ID", value: device.sync.vault ?? "Not configured")
              Text("Sync is fixed by DDL_SYNC_URL, DDL_SYNC_VAULT and DDL_SYNC_TOKEN on this host.")
                .font(.footnote)
            } else {
              TextField("HTTPS sync service address", text: $url).textInputAutocapitalization(
                .never
              ).autocorrectionDisabled()
              TextField("Vault ID", text: $vault).textInputAutocapitalization(.never)
                .autocorrectionDisabled()
              if device.sync.hasToken && !replacingToken {
                LabeledContent("Vault token", value: "Saved on \(store.hostName)")
                Button("Replace token") { replacingToken = true }.disabled(!store.canMutate)
              } else {
                SecureField("Vault token", text: $token).textInputAutocapitalization(.never)
              }
              Button(device.sync.url == nil ? "Enable sync" : "Save sync setup") {
                let request = DeviceSyncSetupRequest(
                  url: trimmedURL, vault: trimmedVault,
                  token: needsToken ? token.trimmingCharacters(in: .whitespacesAndNewlines) : nil)
                Task {
                  if await store.setUpSync(request) {
                    token = ""
                    replacingToken = false
                  }
                }
              }.disabled(!canSave)
              if device.sync.url != nil {
                Button("Disable sync on \(store.hostName)", role: .destructive) {
                  confirmingDisable = true
                }.disabled(!store.canMutate)
              }
            }
          } else {
            Text("Sync configuration is unavailable.")
          }
          Text(
            "These settings connect the host's vault to the sync service. The token is written to the host and is never read back. The iPhone's cache and connection are separate."
          ).font(.footnote)
          SettingsErrors(store: store, keys: ["sync", "device"])
        }.disabled(!store.actionsEnabled || !store.isCurrentSession())
        if let sync = store.sync {
          Section("Sync status") {
            LabeledContent("State", value: sync.state.rawValue)
            LabeledContent("Target", value: sync.target.rawValue)
            LabeledContent("Pending changes", value: "\(sync.pendingChanges)")
            if let last = sync.lastSyncedAt {
              LabeledContent(
                "Last synced", value: Date(timeIntervalSince1970: Double(last) / 1000).formatted())
            }
            if let error = sync.lastError { Text(error).foregroundStyle(.red) }
            ForEach(sync.conflicts, id: \.self) {
              Text("Conflict copy: \($0)").textSelection(.enabled)
            }
          }
        }
      }
      .navigationTitle("Sync")
      .onAppear {
        url = store.device?.sync.url ?? ""
        vault = store.device?.sync.vault ?? ""
      }
      .onDisappear { token = "" }
      .alert("Disable sync on \(store.hostName)?", isPresented: $confirmingDisable) {
        Button("Disable sync", role: .destructive) { Task { await store.disableSync() } }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text(
          "The host stops syncing and forgets its sync token. Notes remain on the host. Its agent may run locally instead of using the always-on machine."
        )
      }
    }
    private var trimmedURL: String { url.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedVault: String { vault.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var needsToken: Bool { store.device?.sync.hasToken != true || replacingToken }
    private var canSave: Bool {
      store.canMutate && store.device?.isLocked(.sync) == false
        && RemoteAccess.isSecureServiceURL(trimmedURL) && RemoteAccess.isSyncID(trimmedVault)
        && (!needsToken || !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
  }
#endif
