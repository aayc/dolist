import DailyDoListDomain
import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// Settings → Always-On → Remote Access: the names this daemon answers to besides this Mac (on
/// the always-on machine, its tailnet name). Read-only when `DDL_REMOTE_HOSTS` sets them.
struct RemoteAccessSection: View {
  let model: AppModel
  let remote: RemoteSettingsStore
  @State private var newHost = ""

  var body: some View {
    Form {
      if let device = remote.device {
        let locked = device.isLocked(.remoteHosts)
        Section {
          if device.remoteHosts.isEmpty {
            Text("None: only this Mac can use this daemon.").foregroundStyle(.secondary)
          }
          ForEach(device.remoteHosts, id: \.self) { host in
            LabeledContent {
              if !locked {
                IconButton("minus.circle", label: "Remove \(host)", size: .compact) {
                  Task {
                    await remote.setRemoteHosts(device.remoteHosts.filter { $0 != host })
                  }
                }
                .disabled(remote.isBusy(.remoteHosts))
              }
            } label: {
              Text(host).textSelection(.enabled)
            }
          }
          if locked {
            LockedByEnvNote(variables: "`DDL_REMOTE_HOSTS`")
          } else {
            HStack {
              TextField(
                "Add a name", text: $newHost, prompt: Text("vm-name.tailnet-name.ts.net")
              )
              .onSubmit { Task { await add(to: device.remoteHosts) } }
              Button("Add") { Task { await add(to: device.remoteHosts) } }
                .pointingHandCursor()
                .disabled(
                  Self.problem(newHost, in: device.remoteHosts) != nil
                    || newHost.trimmingCharacters(in: .whitespaces).isEmpty
                    || remote.isBusy(.remoteHosts))
            }
            if let problem = Self.problem(newHost, in: device.remoteHosts) {
              SettingsNote(text: problem, tone: Theme.danger)
            }
          }
          if let error = remote.error(.remoteHosts) {
            SettingsNote(text: error, tone: Theme.danger)
          }
        } header: {
          Text("Names this daemon answers to")
        } footer: {
          SettingsNote(
            text:
              "Other devices reach this daemon only by these names, through your private network (for example its Tailscale name, like `vm-name.tailnet-name.ts.net`), and only once paired with a code from Devices. Without names, only this Mac can use it.",
            markdown: true)
        }
      } else {
        Section { AlwaysOnUnavailableNote(model: model, remote: remote) }
      }
    }
    .formStyle(.grouped)
  }

  private func add(to hosts: [String]) async {
    guard Self.problem(newHost, in: hosts) == nil,
      let host = RemoteAccess.normalizeRemoteHost(newHost)
    else { return }
    if await remote.setRemoteHosts(hosts + [host]) { newHost = "" }
  }

  /// Why `input` can't be added, or nil (also for an empty field).
  static func problem(_ input: String, in hosts: [String]) -> String? {
    guard !input.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
    guard let host = RemoteAccess.normalizeRemoteHost(input) else {
      return
        "Use a DNS name with an optional :port, like vm-name.tailnet-name.ts.net (no https://, path or IP address)."
    }
    if hosts.contains(host) { return "It's already listed." }
    if hosts.count >= RemoteAccess.Limits.remoteHosts {
      return "At most \(RemoteAccess.Limits.remoteHosts) names."
    }
    return nil
  }
}
