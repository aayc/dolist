#if canImport(UIKit)
  import DailyDoListDomain
  import DailyDoListModels
  import SwiftUI

  struct MobileMachineSettings: View {
    let store: MobileSettingsStore
    @State private var url = ""
    @State private var name = ""
    @State private var code = ""
    @State private var forgetting = false
    var body: some View {
      Form {
        if let status = store.machine {
          Section("\(store.hostName)'s always-on machine") {
            LabeledContent("Name", value: status.machine?.name ?? "Not configured")
            LabeledContent("Address", value: status.machine?.url ?? "Not configured")
            LabeledContent("Paired from \(store.hostName)", value: status.paired ? "Yes" : "No")
            LabeledContent(
              "Reachable", value: status.reachable.map { $0 ? "Yes" : "No" } ?? "Not checked")
            if let version = status.version { LabeledContent("Version", value: version) }
            if let running = status.agent?.runsOn {
              LabeledContent("Agent runs on", value: running.name)
            }
            if let problem = status.agent?.problem ?? status.error {
              Text(problem).foregroundStyle(.orange)
            }
            Button("Check \(status.machine?.name ?? "machine") now") {
              Task { await store.checkMachine() }
            }.disabled(!store.canMutate || status.machine == nil)
            if status.paired {
              Button("Forget credential on \(store.hostName)", role: .destructive) {
                forgetting = true
              }.disabled(!store.canMutate)
            }
          }
          if let readiness = status.readiness {
            Section("Readiness of \(status.machine?.name ?? "the machine")") {
              MobileReadinessRows(readiness: readiness)
            }
          }
        }
        Section("Pair \(store.hostName) with the machine") {
          TextField("HTTPS machine address", text: $url).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          TextField("Machine name (optional)", text: $name)
          SecureField("One-time pairing code", text: $code).textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
          Button("Pair host with machine") {
            guard let normalizedURL = RemoteAccess.normalizeMachineURL(url),
              let normalizedCode = RemoteAccess.normalizePairingCode(code)
            else { return }
            let request = MachinePairRequest(
              url: normalizedURL, code: normalizedCode,
              name: name.trimmingCharacters(in: .whitespaces).isEmpty
                ? nil : RemoteAccess.normalizeDeviceName(name))
            Task { if await store.pairMachine(request) { code = "" } }
          }.disabled(!canPair)
          Text(
            "Get a code in the always-on machine's web app under Settings → Devices, or run its daemon's pair command. This pairs the connected host, not this iPhone. Codes work once for five minutes."
          ).font(.footnote)
        }.disabled(!store.actionsEnabled || !store.isCurrentSession())
        Section { SettingsErrors(store: store, keys: ["machine"]) }
      }
      .navigationTitle("Always-on machine")
      .onAppear {
        url = store.machine?.machine?.url ?? store.settings?.remote.alwaysOnMachine?.url ?? ""
      }
      .onDisappear { code = "" }
      .alert("Forget this credential?", isPresented: $forgetting) {
        Button("Forget", role: .destructive) { Task { await store.forgetMachine() } }
        Button("Cancel", role: .cancel) {}
      } message: {
        Text(
          "\(store.hostName) drops its credential for \(store.machine?.machine?.name ?? "the machine"). Other devices keep their pairings and the shared machine configuration remains."
        )
      }
    }
    private var canPair: Bool {
      store.canMutate && RemoteAccess.normalizeMachineURL(url) != nil
        && RemoteAccess.normalizePairingCode(code) != nil
        && (name.trimmingCharacters(in: .whitespaces).isEmpty
          || RemoteAccess.normalizeDeviceName(name) != nil)
    }
  }
#endif
