import DailyDoListMobileIntegration
import DailyDoListMobileKit
import SwiftUI

struct PhoneRootView: View {
  let model: PhoneAppModel
  @State private var pairing = false
  @State private var choosingHost = false
  @State private var repairing: ConnectionProfile?
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    Group {
      // A protection change must see every workspace view go, including pushed settings pages.
      if let workspace = model.workspace, model.protection?.busy != true {
        PhoneWorkspaceView(
          model: model, workspace: workspace, chooseHost: { choosingHost = true },
          isRootCurrent: { !choosingHost && !pairing }
        )
        .id(ObjectIdentifier(workspace))
      } else if showsStorageProtection {
        NavigationStack {
          Form {
            if let protection = model.protection {
              PhoneStorageProtectionSection(controller: protection)
            } else {
              Section("Stored data") { Text(model.protectionSetupError ?? "") }
            }
          }
          .navigationTitle("Daily Do List")
        }
      } else {
        NavigationStack {
          List {
            Section {
              ContentUnavailableView(
                "Your daily do list", systemImage: "checklist",
                description: Text("Write your tasks. Follow the work. Keep your notes with you."))
              Button("Connect a host", systemImage: "plus.circle") {
                repairing = nil
                pairing = true
              }
            }
            savedConnections
            ConnectionStatusView(connection: model.connection)
          }
          .navigationTitle("Daily Do List")
        }
      }
    }
    .environment(\.recoveryExportStaging, model.exportStaging)
    .task {
      await model.setActive(scenePhase == .active)
      await model.start()
    }
    .onOpenURL { url in Task { await model.openIntegrationURL(url) } }
    .onChange(of: scenePhase) { _, phase in Task { await model.setActive(phase == .active) } }
    .sheet(isPresented: $pairing) {
      ConnectionView(pairing: model.pairing, existingProfile: repairing) { await model.paired($0) }
    }
    .sheet(isPresented: $choosingHost) {
      NavigationStack {
        List {
          savedConnections
          Button("Connect another host", systemImage: "plus") {
            choosingHost = false
            repairing = nil
            pairing = true
          }
        }
        .navigationTitle("Connections")
        .toolbar { Button("Done") { choosingHost = false } }
      }
    }
    .alert(
      "Couldn't open the workspace",
      isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })
    ) {
      Button("OK") { model.error = nil }
    } message: {
      Text(model.error ?? "")
    }
  }

  /// Cold preparation keeps the ordinary start screen; a live change or failure shows its state.
  private var showsStorageProtection: Bool {
    guard let protection = model.protection else { return true }
    return protection.busy ? model.restored : !protection.ready && protection.error != nil
  }

  private var savedConnections: some View {
    Section("Saved connections") {
      ForEach(model.connection.profiles) { profile in
        Button {
          choosingHost = false
          Task { await model.select(profile) }
        } label: {
          VStack(alignment: .leading, spacing: 4) {
            Text(profile.vaultName ?? profile.name).foregroundStyle(.primary)
            Text(profile.origin.url.host() ?? "").font(.caption).foregroundStyle(.secondary)
          }
        }
        .contextMenu {
          Button("Pair again", systemImage: "link") {
            choosingHost = false
            repairing = profile
            pairing = true
          }
        }
      }
    }
  }
}

struct ConnectionStatusView: View {
  let connection: MobileConnection
  var body: some View {
    if let text {
      VStack(alignment: .leading, spacing: 8) {
        Label(text, systemImage: connection.phase == .online ? "checkmark.icloud" : "icloud.slash")
          .font(.footnote).foregroundStyle(.secondary)
        if connection.selected != nil && connection.phase != .online
          && connection.phase != .connecting
        {
          Button("Reconnect") { Task { await connection.reconnect() } }
        }
      }
      .accessibilityIdentifier("connection.status")
    }
  }

  private var text: String? {
    switch connection.phase {
    case .idle: nil
    case .online: "Connected"
    case .connecting: "Connecting…"
    case .offline: "Offline · downloaded notes remain available"
    case .needsPairing: "Pair this iPhone again to reconnect. Local drafts are preserved."
    case .revoked: "This iPhone's access was revoked. Local drafts are preserved."
    case .changedWorkspace:
      "The host is serving a different workspace. Add a new connection; your drafts stay here."
    case .unsupported: "Update the host to a version that supports iPhone workspace protection."
    case .failed(let message): message
    }
  }
}
