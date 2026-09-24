import Foundation

/// The shell talks to OS integrations through `SystemIntegrationBridge` (display strings in,
/// availability messages out).
extension SystemIntegration: SystemIntegrationBridge {
  var launchAtLoginAvailability: IntegrationAvailability {
    switch launchAtLoginStatus {
    case .enabled, .disabled:
      .available
    case .requiresApproval:
      .requiresApproval(
        "Allow “Daily Do List” in System Settings → General → Login Items to open it at login.")
    case .unavailable(let reason):
      .unavailable(reason)
    }
  }

  /// Registered (approved or waiting for approval).
  var isLaunchAtLoginEnabled: Bool {
    launchAtLoginStatus == .enabled || launchAtLoginStatus == .requiresApproval
  }

  var defaultGlobalShortcut: String { GlobalShortcut.openTodaysNote.displayString }

  /// Carbon hotkeys need no permission; a clash with an enabled macOS shortcut needs the user in
  /// System Settings.
  var globalHotkeyAvailability: IntegrationAvailability {
    globalShortcutWarning.map { .requiresApproval($0) } ?? .available
  }

  func setGlobalHotkey(_ shortcut: String?, handler: @escaping @MainActor () -> Void) throws {
    guard let shortcut else {
      unregisterGlobalShortcut()
      return
    }
    guard let parsed = GlobalShortcut(parsing: shortcut) else {
      throw GlobalShortcutError.unrecognized(shortcut)
    }
    try registerGlobalShortcut(parsed, action: handler)
  }
}
