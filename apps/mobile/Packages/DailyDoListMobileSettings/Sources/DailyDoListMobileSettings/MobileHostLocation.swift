#if canImport(UIKit)
  import DailyDoListModels
  import SwiftUI

  struct MobileHostLocation: View {
    let store: MobileSettingsStore
    @State private var placement: AgentPlacement = .thisDevice
    var body: some View {
      Form {
        Section("Agent location") {
          if let device = store.device {
            Picker("\(store.hostName) should", selection: $placement) {
              Text("Run the agent on \(store.hostName)").tag(AgentPlacement.thisDevice)
              Text("Hand to \(store.machine?.machine?.name ?? "the always-on machine")").tag(
                AgentPlacement.alwaysOnMachine)
              Text("Be the always-on host").tag(AgentPlacement.alwaysOnHost)
            }.disabled(!store.canMutate || device.isLocked(.placement))
            Button("Apply agent location") {
              Task {
                await store.updateDevice(.init(placement: placement))
                await store.load()
              }
            }
            .disabled(
              !store.canMutate || device.isLocked(.placement) || placement == device.placement)
            if device.isLocked(.placement) {
              Text("DDL_AGENT_PLACEMENT fixes this setting on \(store.hostName).").font(.footnote)
            }
          } else {
            Text("Host device settings are unavailable.")
          }
          LabeledContent(
            "Running now", value: store.agent?.placement?.runsOn?.name ?? "No active owner reported"
          )
          if let note = store.agent?.placement?.note { Text(note).font(.footnote) }
          if let held = store.agent?.placement?.heldHere {
            Text(
              held == .noSync
                ? "\(store.hostName) is retaining the agent because sync is not configured."
                : "\(store.hostName) is retaining the agent because no always-on machine is configured."
            ).foregroundStyle(.orange)
          }
          if let relay = store.agent?.placement?.relay {
            LabeledContent("Relay", value: relay.rawValue)
          }
          Text(
            "The iPhone never runs the daemon or takes the agent lease. This changes the connected host's placement."
          ).font(.footnote)
          SettingsErrors(store: store, keys: ["device", "agent"])
        }
        Section("Readiness on \(store.hostName)") {
          if let readiness = store.agent?.readiness {
            MobileReadinessRows(readiness: readiness)
          } else {
            Text("No readiness report is available.")
          }
          NavigationLink("Host setup instructions") { MobileHostSetup(hostName: store.hostName) }
        }
      }
      .navigationTitle("Agent location")
      .onAppear { placement = store.device?.placement ?? .thisDevice }
      .onChange(of: store.device?.placement) { _, value in if let value { placement = value } }
    }
  }

  struct MobileReadinessRows: View {
    let readiness: AgentReadiness
    var body: some View {
      LabeledContent("Harness", value: readiness.harness.kind)
      LabeledContent("Harness ready", value: readiness.harness.ready ? "Yes" : "No")
      if let problem = readiness.harness.problem {
        Text(problem).font(.footnote).foregroundStyle(.orange)
      }
      LabeledContent(
        "Model credential", value: readiness.modelCredential ? "Present on host" : "Missing on host"
      )
      LabeledContent("Browser", value: readiness.browser ? "Available" : "Unavailable")
      LabeledContent(
        "Desktop control",
        value: readiness.computer.rawValue.replacingOccurrences(of: "_", with: " "))
      LabeledContent(
        "Connectors",
        value: "\(readiness.connectors.connected) of \(readiness.connectors.configured) connected")
    }
  }
#endif
