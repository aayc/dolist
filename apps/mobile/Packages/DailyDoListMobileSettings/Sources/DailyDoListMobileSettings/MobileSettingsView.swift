#if canImport(UIKit)
  import DailyDoListClient
  import DailyDoListModels
  import SwiftUI

  /// Put this view inside the host's NavigationStack. `hostID` should include the connection
  /// session and workspace identity; switching it destroys all forms, drafts and confirmations.
  public struct MobileSettingsView: View {
    public let client: (any DaemonClient)?
    public let settings: AppSettings?
    public let hostName: String
    public let actionsEnabled: Bool
    public let hostID: String
    public let isCurrentSession: @MainActor () -> Bool
    public let onSettingsSaved: (AppSettings) -> Void

    public init(
      client: (any DaemonClient)?, settings: AppSettings?, hostName: String,
      actionsEnabled: Bool, hostID: String? = nil,
      isCurrentSession: @escaping @MainActor () -> Bool,
      onSettingsSaved: @escaping (AppSettings) -> Void
    ) {
      self.client = client
      self.settings = settings
      self.hostName = hostName
      self.actionsEnabled = actionsEnabled
      self.hostID = hostID ?? hostName
      self.isCurrentSession = isCurrentSession
      self.onSettingsSaved = onSettingsSaved
    }

    public var body: some View {
      MobileSettingsContent(
        client: client, settings: settings, hostName: hostName,
        actionsEnabled: actionsEnabled, hostID: hostID, isCurrentSession: isCurrentSession,
        onSettingsSaved: onSettingsSaved
      )
      .id(SettingsSessionID(hostID: hostID, clientID: client.map(ObjectIdentifier.init)))
    }
  }

  private struct SettingsSessionID: Hashable {
    var hostID: String
    var clientID: ObjectIdentifier?
  }

  private struct MobileSettingsContent: View {
    let client: (any DaemonClient)?
    let settings: AppSettings?
    let hostName: String
    let actionsEnabled: Bool
    let hostID: String
    let isCurrentSession: @MainActor () -> Bool
    let onSettingsSaved: (AppSettings) -> Void
    @State private var store = MobileSettingsStore()

    var body: some View {
      List {
        Section {
          Text("Connected host: \(hostName)").font(.headline)
          Text(
            actionsEnabled
              ? "Changes below apply to this host and its shared vault. They are saved only after the host acknowledges them."
              : "Offline or connecting. Shared settings and host controls are read-only."
          )
          .font(.footnote).foregroundStyle(.secondary)
        }
        if let settings = store.settings ?? settings {
          Section("Shared vault settings") {
            ForEach(SharedSettingsPage.allCases, id: \.self) { page in
              NavigationLink(page.title) {
                SharedSettingsForm(store: store, initial: settings, page: page)
              }
            }
          }
        } else {
          Section { Text("Settings are not available yet.") }
        }
        Section("Host management") {
          NavigationLink("Agent location and readiness") { MobileHostLocation(store: store) }
          NavigationLink("Always-on machine") { MobileMachineSettings(store: store) }
          NavigationLink("Sync on \(hostName)") { MobileSyncSettings(store: store) }
          NavigationLink("Devices and pairing codes") { MobileDeviceSettings(store: store) }
          NavigationLink("Remote host names") { MobileRemoteHosts(store: store) }
        }
        Section("Support") {
          NavigationLink("Connectors") { MobileConnectorSettings(store: store) }
          NavigationLink("Version and diagnostics") { MobileDiagnostics(store: store) }
          NavigationLink("Setup on \(hostName)") { MobileHostSetup(hostName: hostName) }
          Button("Refresh settings and status") { Task { await store.load() } }.disabled(
            !store.canMutate)
          SettingsErrors(store: store)
        }
      }
      .navigationTitle("Host settings")
      .task {
        configure()
        await store.load()
      }
      .onChange(of: actionsEnabled) { _, _ in
        configure()
        if actionsEnabled { Task { await store.load() } }
      }
      .onChange(of: settings) { _, _ in configure() }
      .onChange(of: hostName) { _, _ in configure() }
      .onDisappear { store.dismissCode() }

    }
    private func configure() {
      store.isCurrentSession = isCurrentSession
      store.onSettingsSaved = onSettingsSaved
      store.configure(
        client: client, hostID: hostID, hostName: hostName, settings: settings,
        enabled: actionsEnabled)
    }
  }

  struct SettingsErrors: View {
    let store: MobileSettingsStore
    var keys: [String]? = nil
    var body: some View {
      ForEach((keys ?? store.errors.keys.sorted()).filter { store.errors[$0] != nil }, id: \.self) {
        key in
        Text(store.errors[key] ?? "").foregroundStyle(.red).font(.footnote)
      }
    }
  }
#endif
