#if canImport(UIKit)
  import DailyDoListDomain
  import SwiftUI

  struct MobileRemoteHosts: View {
    let store: MobileSettingsStore
    @State private var name = ""
    @State private var removing: String?
    var body: some View {
      Form {
        Section("Names accepted by \(store.hostName)") {
          if let device = store.device {
            ForEach(device.remoteHosts, id: \.self) { host in
              HStack {
                Text(host).textSelection(.enabled)
                Spacer()
                Button("Remove", role: .destructive) { removing = host }.disabled(
                  !store.canMutate || device.isLocked(.remoteHosts))
              }
            }
            if device.remoteHosts.isEmpty { Text("Only loopback names are configured.") }
            if device.isLocked(.remoteHosts) {
              Text("DDL_REMOTE_HOSTS fixes these names on the host.").font(.footnote)
            } else {
              TextField("DNS name, optionally :port", text: $name).textInputAutocapitalization(
                .never
              ).autocorrectionDisabled()
              Button("Add host name") {
                guard let normalized = RemoteAccess.normalizeRemoteHost(name) else { return }
                Task {
                  if await store.updateDevice(.init(remoteHosts: device.remoteHosts + [normalized]))
                  {
                    name = ""
                  }
                }
              }.disabled(
                !store.canMutate || normalizedName == nil
                  || device.remoteHosts.count >= RemoteAccess.Limits.remoteHosts
                  || device.remoteHosts.contains(normalizedName ?? ""))
            }
          } else {
            Text("Remote host settings are unavailable.")
          }
          Text(
            "Use a private-network DNS name. Do not include https://, an IP address or a path. Names do not expose a listener; the host still needs a private-network proxy and every device must pair."
          ).font(.footnote)
          SettingsErrors(store: store, keys: ["device"])
        }
      }
      .navigationTitle("Remote host names")
      .alert(
        "Remove \(removing ?? "this name")?",
        isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
      ) {
        if let host = removing {
          Button("Remove", role: .destructive) {
            guard let device = store.device else { return }
            removing = nil
            Task {
              await store.updateDevice(.init(remoteHosts: device.remoteHosts.filter { $0 != host }))
            }
          }
        }
        Button("Cancel", role: .cancel) { removing = nil }
      } message: {
        Text(
          "Devices connecting through that name, including this iPhone, will lose access until the name is restored on \(store.hostName)."
        )
      }
    }
    private var normalizedName: String? { RemoteAccess.normalizeRemoteHost(name) }
  }
#endif
