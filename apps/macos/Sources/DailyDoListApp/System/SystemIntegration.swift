import AppKit
import Foundation
import Observation

/// The OS integrations the app shell uses: launch at login and a global "open today's note"
/// hotkey. Main-actor only; observe it from SwiftUI.
///
/// ```swift
/// let system = SystemIntegration()
/// try system.registerGlobalShortcut(.openTodaysNote) { workspace.openToday() }
/// try system.setLaunchAtLogin(true)   // throws a readable error outside a signed .app
/// ```
@MainActor
@Observable
public final class SystemIntegration {
  /// Refreshed by `refresh()`; the user can change Login Items in System Settings at any time.
  public private(set) var launchAtLoginStatus: LaunchAtLoginStatus
  /// The registered global shortcut (nil when none).
  public private(set) var globalShortcut: GlobalShortcut?
  /// Set when the registered shortcut clashes with an enabled macOS shortcut, which wins.
  public private(set) var globalShortcutWarning: String?

  @ObservationIgnored private let launchAtLogin: LaunchAtLoginService
  @ObservationIgnored private let symbolicHotKeys: () -> [String: Any]
  @ObservationIgnored private var hotKeyID: UInt32?

  public convenience init() {
    self.init(bundle: .main, symbolicHotKeys: SystemShortcutConflicts.currentSymbolicHotKeys)
  }

  init(bundle: Bundle, symbolicHotKeys: @escaping () -> [String: Any]) {
    launchAtLogin = LaunchAtLoginService(bundle: bundle)
    self.symbolicHotKeys = symbolicHotKeys
    launchAtLoginStatus = launchAtLogin.status
  }

  // MARK: Launch at login

  /// Re-reads the login item status (call when the app becomes active).
  public func refresh() {
    launchAtLoginStatus = launchAtLogin.status
  }

  public func setLaunchAtLogin(_ enabled: Bool) throws(LaunchAtLoginError) {
    defer { refresh() }
    try launchAtLogin.setEnabled(enabled)
  }

  /// Opens System Settings → General → Login Items (where `.requiresApproval` is resolved).
  public func openLoginItemsSettings() {
    launchAtLogin.openSystemSettings()
  }

  // MARK: Global shortcut

  /// Registers `shortcut` system-wide, replacing the previous one; `action` runs on the main
  /// actor for every press. On failure the previous shortcut stays registered.
  public func registerGlobalShortcut(
    _ shortcut: GlobalShortcut = .openTodaysNote, action: @escaping @MainActor () -> Void
  ) throws(GlobalShortcutError) {
    guard shortcut.isValidGlobalShortcut else { throw .needsModifier(shortcut.displayString) }
    let center = GlobalHotKeyCenter.shared
    if let hotKeyID, globalShortcut == shortcut {
      center.updateAction(hotKeyID, action: action)
    } else {
      let id = try center.register(shortcut, action: action)
      if let previous = hotKeyID { center.unregister(previous) }
      hotKeyID = id
      globalShortcut = shortcut
    }
    globalShortcutWarning = SystemShortcutConflicts.warning(
      for: shortcut, symbolicHotKeys: symbolicHotKeys())
  }

  public func unregisterGlobalShortcut() {
    if let hotKeyID { GlobalHotKeyCenter.shared.unregister(hotKeyID) }
    hotKeyID = nil
    globalShortcut = nil
    globalShortcutWarning = nil
  }

  /// Brings the app forward, e.g. from the global shortcut's action before opening a note.
  public static func activateApp() {
    NSApplication.shared.activate()
  }
}
