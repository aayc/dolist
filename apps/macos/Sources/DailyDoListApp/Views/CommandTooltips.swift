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

/// A command's shortcut as keycaps, when it has one (menus the app draws, empty states).
struct CommandKeycaps: View {
  let command: CommandID

  var body: some View {
    if let shortcut = command.shortcut { Keycaps(shortcut) }
  }
}
