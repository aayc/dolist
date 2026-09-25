import ApplicationServices
import CoreGraphics
import Foundation

/// The two macOS permissions computer use needs. macOS checks them for this process's
/// "responsible" app: the Daily Do List app when it runs the daemon, else the terminal or editor
/// the daemon was started from.
public protocol PermissionProbing: Sendable {
  /// Accessibility: reading other apps' UI and sending them input.
  func accessibility() -> Bool
  /// Screen Recording: capturing windows and displays.
  func screenRecording() -> Bool
}

/// Passive checks that never prompt. `AXIsProcessTrustedWithOptions` with the prompt option and
/// `CGRequestScreenCaptureAccess` would; the helper never calls them.
public struct SystemPermissions: PermissionProbing {
  public init() {}

  public func accessibility() -> Bool { AXIsProcessTrusted() }

  public func screenRecording() -> Bool { CGPreflightScreenCaptureAccess() }
}
