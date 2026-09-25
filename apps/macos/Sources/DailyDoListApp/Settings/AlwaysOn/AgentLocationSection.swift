import DailyDoListAgent
import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// Settings → Always-On → Agent Location: the same choice as the agent panel's control (this
/// device or the always-on machine; on the machine itself, "this is the always-on machine"), who
/// runs the agent right now, and this device's readiness with what fixes it.
struct AgentLocationSection: View {
  let model: AppModel
  let remote: RemoteSettingsStore

  var body: some View {
    let agent = model.agent
    let location = agent?.orchestratorLocation
    Form {
      Section {
        if let agent, let location {
          if location.isHost {
            SettingsCallout(
              systemImage: "server.rack", tint: Theme.accent,
              text:
                "This is the always-on machine. It runs the agent whenever no device set to run it itself is running."
            )
          } else {
            LabeledContent("The orchestrator runs on") {
              OrchestratorPicker(agent: agent, location: location, locked: isLocked)
            }
            if isLocked {
              LockedByEnvNote(variables: "`DDL_AGENT_PLACEMENT`")
            } else if let reason = location.heldTooltip {
              HeldHereNote(reason: reason, setUp: location.setUp) { setUp in
                model.ui.alwaysOnSection = AlwaysOnSection(setUp)
              }
            }
          }
          LabeledContent("Running now") {
            Text(Self.runsOnText(agent.placement))
              .foregroundStyle(.secondary)
              .multilineTextAlignment(.trailing)
          }
          if let line = location.line, location.heldHere == nil {
            SettingsNote(text: line.text, tone: line.tone.color)
          }
        } else if model.client == nil {
          NotConnectedNote()
        } else {
          SettingsNote(
            text: "This daemon doesn't report where its agent runs. Update it to choose here.")
        }
      } header: {
        Text("Where the agent runs")
      } footer: {
        SettingsNote(
          text:
            "This device runs the agent itself, or hands it to the always-on machine, which keeps working while this device sleeps. Each device chooses for itself."
        )
      }
      Section("This device's readiness") {
        if let readiness = agent?.status?.readiness {
          ReadinessRows(items: ReadinessItem.items(readiness, onThisDevice: true)) { fix in
            switch fix {
            case .agentSettings: model.showSettings(.agent)
            case .computerUse: CommandCatalog(model: model).run(.setUpComputerUse)
            case .connectors: model.showSettings(.connectors)
            }
          }
        } else {
          SettingsNote(text: "This daemon doesn't report its readiness.")
        }
      }
    }
    .formStyle(.grouped)
  }

  private var isLocked: Bool { remote.device?.isLocked(.placement) ?? false }

  /// Who runs the agent now, in words.
  static func runsOnText(_ placement: AgentPlacementStatus?) -> String {
    guard let runsOn = placement?.runsOn else { return "Nobody right now" }
    if runsOn.thisDevice { return runsOn.alwaysOnMachine ? "This machine" : "This device" }
    if runsOn.alwaysOnMachine { return "\(runsOn.name), the always-on machine" }
    return runsOn.name
  }
}

/// The segmented "This device | Always-on machine" control of Settings.
struct OrchestratorPicker: View {
  let agent: AgentStore
  let location: OrchestratorLocation
  let locked: Bool

  var body: some View {
    Picker(
      "The orchestrator runs on",
      selection: Binding(
        get: { location.selection },
        set: { target in Task { await agent.moveOrchestrator(to: target) } })
    ) {
      ForEach([AgentPlacement.thisDevice, .alwaysOnMachine], id: \.self) { placement in
        Text(OrchestratorLocation.title(placement)).tag(placement)
      }
    }
    .pickerStyle(.segmented)
    .labelsHidden()
    .fixedSize()
    .pointingHandCursor(enabled)
    .tooltip(
      TooltipContent("Where the orchestrator runs"),
      whenDisabled: locked
        ? TooltipContent("Set by an environment variable") : location.heldTooltip
    )
    .disabled(!enabled)
  }

  private var enabled: Bool { location.canSwitch && !locked }
}

/// Why the choice waits, and the way to set up what's missing.
private struct HeldHereNote: View {
  let reason: TooltipContent
  let setUp: OrchestratorLocation.SetUp?
  let open: (OrchestratorLocation.SetUp) -> Void

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      VStack(alignment: .leading, spacing: 2) {
        Text(reason.lines.first?.text ?? "").font(.callout)
        if let detail = reason.detail { SettingsNote(text: detail) }
      }
      Spacer()
      if let setUp {
        Button(setUp == .sync ? "Set Up Sync…" : "Set Up the Machine…") { open(setUp) }
          .pointingHandCursor()
      }
    }
  }
}
