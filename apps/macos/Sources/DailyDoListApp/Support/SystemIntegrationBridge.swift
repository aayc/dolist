import Foundation

/// Whether an OS integration can be used right now, with a user-facing explanation otherwise.
enum IntegrationAvailability: Equatable, Sendable {
  case available
  /// Registered but waiting for the user in System Settings (Login Items).
  case requiresApproval(String)
  case unavailable(String)

  var message: String? {
    switch self {
    case .available: nil
    case .requiresApproval(let message), .unavailable(let message): message
    }
  }
}

/// The OS integrations the shell needs (launch at login, global hotkey), behind a protocol so
/// tests and non-bundled runs can substitute them. `SystemIntegration` is the real one.
@MainActor
protocol SystemIntegrationBridge: AnyObject {
  /// Re-reads OS state (the user can change Login Items in System Settings at any time).
  func refresh()

  var launchAtLoginAvailability: IntegrationAvailability { get }
  var isLaunchAtLoginEnabled: Bool { get }
  func setLaunchAtLogin(_ enabled: Bool) throws

  /// Display form of the default global shortcut (e.g. `⌃⌥⌘D`).
  var defaultGlobalShortcut: String { get }
  var globalHotkeyAvailability: IntegrationAvailability { get }
  /// Registers `shortcut` (display form) to run `handler`; nil unregisters.
  func setGlobalHotkey(_ shortcut: String?, handler: @escaping @MainActor () -> Void) throws

  func openLoginItemsSettings()
}

/// Reports both features as unavailable (tests, previews).
@MainActor
final class UnavailableSystemIntegration: SystemIntegrationBridge {
  private let reason: String

  init(reason: String = "Not available in this build.") {
    self.reason = reason
  }

  func refresh() {}

  var launchAtLoginAvailability: IntegrationAvailability { .unavailable(reason) }
  var isLaunchAtLoginEnabled: Bool { false }
  func setLaunchAtLogin(_ enabled: Bool) throws {}
  var defaultGlobalShortcut: String { GlobalShortcut.openTodaysNote.displayString }
  var globalHotkeyAvailability: IntegrationAvailability { .unavailable(reason) }
  func setGlobalHotkey(_ shortcut: String?, handler: @escaping @MainActor () -> Void) throws {}
  func openLoginItemsSettings() {}
}
