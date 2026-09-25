import AppKit
import DailyDoListDomain
import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// Settings → Always-On → Devices: this device's name, the devices paired with this daemon (and
/// revoking one), and a pairing code for a new device with its expiry and the address to open.
struct DevicesSection: View {
  let model: AppModel
  let remote: RemoteSettingsStore
  @State private var newDeviceName = ""
  @State private var revoking: PairedDevice?

  var body: some View {
    Form {
      if let device = remote.device {
        Section {
          CommitTextField(title: "Name", value: device.device.name, required: true) { name in
            Task { await remote.rename(name) }
          }
          if let error = remote.error(.rename) { SettingsNote(text: error, tone: Theme.danger) }
        } header: {
          Text("This device")
        } footer: {
          SettingsNote(text: "What your other devices and the always-on machine call this one.")
        }
        pairedDevices
        pairNewDevice
      } else {
        Section { AlwaysOnUnavailableNote(model: model, remote: remote) }
      }
    }
    .formStyle(.grouped)
    .alert(
      "Revoke “\(revoking?.name ?? "")”?",
      isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } })
    ) {
      Button("Revoke", role: .destructive) {
        if let device = revoking { Task { await remote.revoke(device) } }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("It's signed out at once, and needs a new pairing code to come back.")
    }
  }

  private var pairedDevices: some View {
    Section {
      if let devices = remote.devices {
        if devices.isEmpty {
          Text("No devices are paired with this daemon.").foregroundStyle(.secondary)
        }
        ForEach(devices) { device in
          PairedDeviceRow(device: device, now: model.environment.now()) { revoking = device }
        }
      } else if remote.isBusy(.devices) || remote.isBusy(.load) {
        ProgressView().controlSize(.small)
      }
      if let error = remote.error(.devices) ?? remote.error(.revoke) {
        SettingsNote(text: error, tone: Theme.danger)
      }
    } header: {
      HStack {
        Text("Paired devices")
        Spacer()
        Button("Refresh") { Task { await remote.loadDevices() } }
          .controlSize(.small)
          .pointingHandCursor()
          .disabled(remote.isBusy(.devices))
      }
    }
  }

  private var pairNewDevice: some View {
    Section {
      if let code = remote.pairingCode {
        PairingCodeCard(
          code: code, now: model.environment.now,
          onNewCode: { Task { await remote.createPairingCode(name: trimmedName) } },
          onDone: { remote.dismissPairingCode() })
      } else {
        TextField("Name", text: $newDeviceName, prompt: Text("Optional, e.g. Phone"))
        HStack {
          Spacer()
          Button(remote.isBusy(.pairingCode) ? "Getting a Code…" : "Get a Pairing Code") {
            Task { await remote.createPairingCode(name: trimmedName) }
          }
          .pointingHandCursor()
          .disabled(remote.isBusy(.pairingCode) || nameIsInvalid)
        }
      }
      if let error = remote.error(.pairingCode) { SettingsNote(text: error, tone: Theme.danger) }
    } header: {
      Text("Pair a new device")
    } footer: {
      SettingsNote(
        text:
          "A code works once, for five minutes. The new device exchanges it for its own credential, which you can revoke here."
      )
    }
  }

  private var trimmedName: String? {
    let name = newDeviceName.trimmingCharacters(in: .whitespaces)
    return name.isEmpty ? nil : name
  }

  private var nameIsInvalid: Bool {
    trimmedName.map { RemoteAccess.normalizeDeviceName($0) == nil } ?? false
  }
}

/// A paired device: what it is, when it paired and was last used, and Revoke.
private struct PairedDeviceRow: View {
  let device: PairedDevice
  let now: Date
  let onRevoke: () -> Void

  var body: some View {
    LabeledContent {
      if device.current != true {
        Button("Revoke…", action: onRevoke).pointingHandCursor()
      }
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Image(systemName: Self.systemImage(device.kind))
          .foregroundStyle(Theme.accent)
          .frame(width: 18)
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text(device.name)
            if device.current == true { Pill(text: "This device", color: Theme.accent) }
          }
          Text(Self.detail(device, now: now))
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }
    }
    .accessibilityElement(children: .combine)
  }

  static func systemImage(_ kind: PairedDeviceKind) -> String {
    switch kind {
    case .browser: "globe"
    case .daemon: "server.rack"
    default: "laptopcomputer.and.iphone"
    }
  }

  static func detail(_ device: PairedDevice, now: Date) -> String {
    let kind =
      switch device.kind {
      case .browser: "Browser"
      case .daemon: "Daemon"
      case .app: "App"
      default: device.kind.rawValue
      }
    let paired = Date(epochMillis: device.createdAt).formatted(.dateTime.month(.abbreviated).day())
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .full
    let used = device.lastSeenAt.map {
      "last used " + formatter.localizedString(for: Date(epochMillis: $0), relativeTo: now)
    }
    return [kind, "paired \(paired)", used ?? "never used"].joined(separator: " · ")
  }
}

/// The pairing code (`XXXX-XXXX`), how long it's still good for, and the address to open.
struct PairingCodeCard: View {
  let code: PairingCodeResponse
  let now: () -> Date
  let onNewCode: () -> Void
  let onDone: () -> Void

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { _ in
      let remaining = Date(epochMillis: code.expiresAt).timeIntervalSince(now())
      VStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 8) {
          Text(code.displayCode)
            .font(.system(size: 28, weight: .semibold, design: .monospaced))
            .foregroundStyle(remaining > 0 ? .primary : .secondary)
            .textSelection(.enabled)
            .accessibilityLabel(
              "Pairing code \(code.displayCode.map(String.init).joined(separator: " "))")
          IconButton("doc.on.doc", label: "Copy code") { Self.copy(code.displayCode) }
          Spacer()
          Text(remaining > 0 ? "Expires in \(Self.countdown(remaining))" : "Expired")
            .font(.callout.monospacedDigit())
            .foregroundStyle(remaining > 30 ? Color.secondary : Theme.warning)
        }
        if let url = code.url {
          HStack(spacing: 8) {
            Text(url).font(.callout).textSelection(.enabled)
            IconButton("doc.on.doc", label: "Copy address", size: .compact) { Self.copy(url) }
          }
          SettingsNote(text: "On the new device, open this address and enter the code.")
        } else {
          SettingsNote(
            text:
              "Other devices can't reach this daemon yet: add the name they reach it by in Remote Access.",
            tone: Theme.warning)
        }
        HStack {
          Spacer()
          if remaining <= 0 {
            Button("Get a New Code", action: onNewCode).pointingHandCursor()
          }
          Button("Done", action: onDone).pointingHandCursor()
        }
      }
      .padding(.vertical, 4)
    }
  }

  /// `4:05`
  static func countdown(_ seconds: TimeInterval) -> String {
    let whole = max(0, Int(seconds.rounded(.up)))
    return "\(whole / 60):" + String(format: "%02d", whole % 60)
  }

  private static func copy(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }
}
