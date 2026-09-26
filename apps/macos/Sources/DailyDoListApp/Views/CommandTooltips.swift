import DailyDoListAgent
import DailyDoListUI
import SwiftUI

extension View {
  /// The tooltip of a control that runs `command`: `label`, then the command's shortcut from the
  /// catalog as keycaps (never written into the text).
  func tooltip(
    _ label: String, command: CommandID, detail: String? = nil,
    placement: TooltipPlacement = .automatic, whenDisabled: String? = nil
  ) -> some View {
    tooltip(
      label, keys: command.shortcut, detail: detail, placement: placement,
      whenDisabled: whenDisabled, command: command.rawValue)
  }
}

extension IconButton {
  /// An icon button that runs `command`; its tooltip shows the command's shortcut.
  init(
    _ systemImage: String, label: String, command: CommandID, detail: String? = nil,
    isActive: Bool = false, isEnabled: Bool = true, size: Size = .regular,
    action: @escaping () -> Void
  ) {
    self.init(
      systemImage, label: label, keys: command.shortcut, command: command.rawValue,
      detail: detail, isActive: isActive, isEnabled: isEnabled, size: size, action: action)
  }
}

extension AgentPanelShortcuts {
  /// The catalog's commands behind the agent panel's buttons (and the Remote switch in Settings).
  static let app = AgentPanelShortcuts(
    hidePanel: CommandID.toggleAgentPanel.shortcut, inbox: CommandID.agentInbox.shortcut,
    stop: Command(.stopTask), routines: Command(.showRoutines), newRoutine: Command(.newRoutine),
    runHere: Command(.runOrchestratorHere), runOnMachine: Command(.runOrchestratorOnMachine))
}

extension AgentPanelShortcuts.Command {
  /// `command`'s id and its shortcut from the catalog.
  init(_ command: CommandID) {
    self.init(id: command.rawValue, keys: command.shortcut)
  }
}

/// A command's shortcut as keycaps, when it has one (menus the app draws, empty states).
struct CommandKeycaps: View {
  let command: CommandID

  var body: some View {
    if let shortcut = command.shortcut { Keycaps(shortcut) }
  }
}
