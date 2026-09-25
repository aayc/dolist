import AppKit
import Foundation

/// Checks and requests the permissions (`AXIsProcessTrusted`, `CGPreflightScreenCaptureAccess` and
/// their prompting versions).
@MainActor
protocol ComputerAccessProbing: AnyObject {
  /// Whether this process has the permission now. Never prompts.
  func isGranted(_ permission: ComputerPermission) -> Bool
  /// Asks macOS for it. Its prompt, shown once per app, also adds Daily Do List to the list in
  /// System Settings (switched off). Returns whether it's granted.
  func requestAccess(_ permission: ComputerPermission) -> Bool
}

/// Opens URLs: System Settings panes.
@MainActor
protocol URLOpening: AnyObject {
  /// Whether something opened `url`.
  func open(_ url: URL) -> Bool
}

/// System Settings, seen from outside.
@MainActor
protocol SystemSettingsWatching: AnyObject {
  var isFrontmost: Bool { get }
  var isRunning: Bool { get }
}

/// The guide panel beside System Settings.
@MainActor
protocol ComputerAccessGuidePresenting: AnyObject {
  /// Shows the panel, which follows `access.guide` until ``hide()``.
  func show(_ access: ComputerAccessSetup)
  func hide()
}

/// Starting a fresh copy of the app.
@MainActor
protocol AppRelaunching: AnyObject {
  /// Why this copy can't relaunch itself, or nil when it can.
  var unavailableReason: String? { get }
  /// Opens a new instance of the app with this one's arguments and `DDL_*` settings.
  func openNewInstance() async throws
  /// Quits this instance the normal way, which saves notes and stops the managed daemon.
  func terminate()
}

/// Everything ``ComputerAccessSetup`` needs from the OS, injectable so tests never touch it.
@MainActor
struct ComputerAccessSystem {
  var probe: ComputerAccessProbing
  var opener: URLOpening
  var systemSettings: SystemSettingsWatching
  var presenter: ComputerAccessGuidePresenting
  var relauncher: AppRelaunching
  /// Brings Daily Do List to the front.
  var activateApp: @MainActor () -> Void
  /// Whether this copy is signed ad hoc, so its grants don't survive a rebuild.
  var isSignedAdHoc: @MainActor () -> Bool
  /// macOS's major version: System Settings renamed Screen Recording in 15.
  var macOSMajorVersion: Int
  /// The app bundle the guide offers to drag into System Settings' list, and its icon.
  var appBundleURL: URL
  var appIcon: @MainActor () -> NSImage

  /// Reports both permissions as granted and never touches the OS: tests and previews that don't
  /// exercise computer use.
  static var inert: ComputerAccessSystem {
    let inert = InertComputerAccess()
    return ComputerAccessSystem(
      probe: inert, opener: inert, systemSettings: inert, presenter: inert, relauncher: inert,
      activateApp: {}, isSignedAdHoc: { false }, macOSMajorVersion: 26,
      appBundleURL: URL(fileURLWithPath: "/Applications/Daily Do List.app"),
      appIcon: { NSImage(named: NSImage.applicationIconName) ?? NSImage() })
  }
}

@MainActor
private final class InertComputerAccess: ComputerAccessProbing, URLOpening, SystemSettingsWatching,
  ComputerAccessGuidePresenting, AppRelaunching
{
  func isGranted(_ permission: ComputerPermission) -> Bool { true }
  func requestAccess(_ permission: ComputerPermission) -> Bool { true }
  func open(_ url: URL) -> Bool { false }
  var isFrontmost: Bool { false }
  var isRunning: Bool { false }
  func show(_ access: ComputerAccessSetup) {}
  func hide() {}
  var unavailableReason: String? { "Not available in this build." }
  func openNewInstance() async throws {}
  func terminate() {}
}
