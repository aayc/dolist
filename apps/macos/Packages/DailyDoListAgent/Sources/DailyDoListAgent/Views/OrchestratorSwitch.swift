import DailyDoListModels
import DailyDoListUI
import SwiftUI

/// The "Remote" row: on, the orchestrator runs on the always-on machine; off, on this device.
/// Only the switch is clickable. Disabled with the reason while the agent is held on this device,
/// an environment variable sets it (`locked`), or it's moving; otherwise its tooltip says what
/// flipping it does, with the host's command that does the same (for its keys).
public struct OrchestratorSwitch: View {
  let store: AgentStore
  let location: OrchestratorLocation
  let shortcuts: AgentPanelShortcuts
  let locked: Bool

  public init(
    store: AgentStore, location: OrchestratorLocation, shortcuts: AgentPanelShortcuts,
    locked: Bool = false
  ) {
    self.store = store
    self.location = location
    self.shortcuts = shortcuts
    self.locked = locked
  }

  public var body: some View {
    let remote = location.selection == .alwaysOnMachine
    let command = remote ? shortcuts.runHere : shortcuts.runOnMachine
    LabeledContent("Remote") {
      Toggle(
        "Remote",
        isOn: Binding(
          get: { remote },
          set: { on in
            Task { await store.moveOrchestrator(to: on ? .alwaysOnMachine : .thisDevice) }
          })
      )
      .toggleStyle(.switch)
      .labelsHidden()
      .pointingHandCursor(enabled)
      .tooltip(
        TooltipContent(
          remote
            ? "Run the orchestrator on this device"
            : "Run the orchestrator on your always-on machine", keys: command.keys),
        whenDisabled: locked
          ? TooltipContent("Set by an environment variable")
          : location.heldTooltip
            ?? (location.isSwitching ? TooltipContent("Moving the orchestrator…") : nil),
        command: command.id
      )
      .disabled(!enabled)
    }
  }

  private var enabled: Bool { location.canSwitch && !locked }
}
