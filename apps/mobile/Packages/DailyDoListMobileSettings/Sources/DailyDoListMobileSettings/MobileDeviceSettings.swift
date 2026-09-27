#if canImport(UIKit)
  import DailyDoListDomain
  import DailyDoListModels
  import SwiftUI

  struct MobileDeviceSettings: View {
    let store: MobileSettingsStore
    @State private var hostDeviceName = ""
    @State private var newDeviceName = ""
    @State private var revoking: PairedDevice?
    var body: some View {
      Form {
        if let device = store.device {
          Section("Host name") {
            TextField("Name of \(store.hostName)", text: $hostDeviceName)
            Button("Rename host device") {
              guard let normalized = RemoteAccess.normalizeDeviceName(hostDeviceName) else {
                return
              }
              Task { await store.updateDevice(.init(name: normalized)) }
            }.disabled(
              !store.canMutate || RemoteAccess.normalizeDeviceName(hostDeviceName) == nil
                || hostDeviceName == device.device.name)
            Text(
              "This is the daemon's device name, used by sync and agent placement. It does not rename this iPhone."
            ).font(.footnote)
          }.disabled(!store.actionsEnabled || !store.isCurrentSession())
        }
        Section("Devices paired with \(store.hostName)") {
          if let devices = store.devices {
            if devices.isEmpty { Text("No paired devices.") }
            ForEach(devices) { device in
              VStack(alignment: .leading, spacing: 4) {
                Text(device.name).font(.headline)
                Text("\(device.kind.rawValue) · Paired \(date(device.createdAt))").font(.caption)
                  .foregroundStyle(.secondary)
                if let last = device.lastSeenAt {
                  Text("Last used \(date(last))").font(.caption).foregroundStyle(.secondary)
                }
                if device.current == true {
                  Text("This iPhone's connection").font(.caption)
                } else {
                  Button("Revoke access", role: .destructive) { revoking = device }.disabled(
                    !store.canMutate)
                }
              }
            }
          } else {
            Text("Paired-device status is unavailable.")
          }
        }
        Section("Pair a new device with \(store.hostName)") {
          TextField("New device name (optional)", text: $newDeviceName)
          if let code = store.code {
            TimelineView(.periodic(from: .now, by: 1)) { context in
              let seconds = Int(
                max(0, Double(code.expiresAt) / 1000 - context.date.timeIntervalSince1970))
              Text(code.displayCode).font(.title.monospaced()).textSelection(.enabled)
              Text(
                seconds > 0
                  ? "Expires in \(seconds / 60):\(String(format: "%02d", seconds % 60))" : "Expired"
              ).font(.footnote)
              if let url = code.url {
                Text(url).textSelection(.enabled)
              } else {
                Text(
                  "Configure a private-network remote host name before another device can connect."
                ).font(.footnote)
              }
            }
            Button("Hide code") { store.dismissCode() }
          }
          Button(store.code == nil ? "Create pairing code" : "Create another code") {
            let name = newDeviceName.trimmingCharacters(in: .whitespacesAndNewlines)
            Task { await store.createCode(name: name.isEmpty ? nil : name) }
          }.disabled(
            !store.canMutate
              || (!newDeviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && RemoteAccess.normalizeDeviceName(newDeviceName) == nil)
          )
          Text(
            "A code works once, for five minutes. The new device receives a separate credential that can be revoked here."
          ).font(.footnote)
        }.disabled(!store.actionsEnabled || !store.isCurrentSession())
        Section { SettingsErrors(store: store, keys: ["device", "devices"]) }
      }
      .navigationTitle("Devices")
      .onAppear { hostDeviceName = store.device?.device.name ?? "" }
      .onDisappear { store.dismissCode() }
      .alert(
        "Revoke \(revoking?.name ?? "device")?",
        isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } })
      ) {
        if let device = revoking {
          Button("Revoke", role: .destructive) {
            revoking = nil
            Task { await store.revoke(device) }
          }
        }
        Button("Cancel", role: .cancel) { revoking = nil }
      } message: {
        Text(
          "It immediately loses access to \(store.hostName) and must pair again with a new code.")
      }
    }
    private func date(_ value: EpochMillis) -> String {
      Date(timeIntervalSince1970: Double(value) / 1000).formatted(
        date: .abbreviated, time: .shortened)
    }
  }
#endif
