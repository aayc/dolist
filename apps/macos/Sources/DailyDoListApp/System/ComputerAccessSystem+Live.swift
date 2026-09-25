import AppKit
import ApplicationServices
import Foundation
import Security

extension ComputerAccessSystem {
  /// The real OS: TCC checks and prompts, `NSWorkspace`, the guide panel, and relaunching.
  static func live() -> ComputerAccessSystem {
    let bundle = Bundle.main
    return ComputerAccessSystem(
      probe: LiveComputerAccessProbe(), opener: WorkspaceURLOpener(),
      systemSettings: WorkspaceSystemSettingsWatcher(),
      presenter: ComputerAccessGuidePanelPresenter(), relauncher: WorkspaceAppRelauncher(),
      activateApp: { NSApplication.shared.activate() }, isSignedAdHoc: CodeSignature.isAdHoc,
      macOSMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
      appBundleURL: bundle.bundleURL,
      appIcon: { NSApplication.shared.applicationIconImage ?? NSImage() })
  }
}

/// `AXIsProcessTrusted` and `CGPreflightScreenCaptureAccess`, and their prompting versions.
@MainActor
final class LiveComputerAccessProbe: ComputerAccessProbing {
  func isGranted(_ permission: ComputerPermission) -> Bool {
    switch permission {
    case .accessibility: AXIsProcessTrusted()
    case .screenRecording: CGPreflightScreenCaptureAccess()
    }
  }

  func requestAccess(_ permission: ComputerPermission) -> Bool {
    switch permission {
    case .accessibility:
      // The value of kAXTrustedCheckOptionPrompt, a mutable C global Swift 6 won't read.
      AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    case .screenRecording:
      CGRequestScreenCaptureAccess()
    }
  }
}

@MainActor
final class WorkspaceURLOpener: URLOpening {
  func open(_ url: URL) -> Bool { NSWorkspace.shared.open(url) }
}

@MainActor
final class WorkspaceSystemSettingsWatcher: SystemSettingsWatching {
  /// System Settings kept System Preferences' bundle id; `com.apple.Settings` is the newer one.
  static let bundleIdentifiers: Set<String> = ["com.apple.systempreferences", "com.apple.Settings"]

  var isFrontmost: Bool {
    NSWorkspace.shared.frontmostApplication?.bundleIdentifier.map(Self.bundleIdentifiers.contains)
      ?? false
  }

  var isRunning: Bool {
    Self.bundleIdentifiers.contains {
      !NSRunningApplication.runningApplications(withBundleIdentifier: $0).isEmpty
    }
  }
}

/// Opens a new instance of the app bundle (`createsNewApplicationInstance`), then quits this one.
@MainActor
final class WorkspaceAppRelauncher: AppRelaunching {
  private let bundleURL: URL
  private let configuration: RelaunchConfiguration

  init(
    bundleURL: URL = Bundle.main.bundleURL, arguments: [String] = CommandLine.arguments,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) {
    self.bundleURL = bundleURL
    configuration = RelaunchConfiguration(arguments: arguments, environment: environment)
  }

  var unavailableReason: String? {
    RelaunchConfiguration.unavailableReason(bundleURL: bundleURL)
  }

  func openNewInstance() async throws {
    let open = NSWorkspace.OpenConfiguration()
    open.createsNewApplicationInstance = true
    open.arguments = configuration.arguments
    open.environment = configuration.environment
    let url = bundleURL
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      NSWorkspace.shared.openApplication(at: url, configuration: open) { _, error in
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
      }
    }
  }

  func terminate() {
    NSApplication.shared.terminate(nil)
  }
}

/// What a relaunched copy inherits: this one's arguments (`--demo`) and `DDL_*` settings, not the
/// rest of the environment, which LaunchServices sets up itself.
struct RelaunchConfiguration: Equatable, Sendable {
  var arguments: [String]
  var environment: [String: String]

  /// `arguments` as the process got them (the executable first).
  init(arguments: [String], environment: [String: String]) {
    self.arguments = Array(arguments.dropFirst())
    self.environment = environment.filter { $0.key.hasPrefix("DDL_") }
  }

  static func unavailableReason(bundleURL: URL) -> String? {
    bundleURL.pathExtension == "app"
      ? nil
      : "Only the packaged app can relaunch itself (build it with apps/macos/scripts/build-app.sh). Quit and start it again instead."
  }
}

enum CodeSignature {
  /// Whether this process is signed ad hoc, so macOS forgets its grants when it's rebuilt.
  static func isAdHoc() -> Bool {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return false }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else {
      return false
    }
    var information: CFDictionary?
    guard
      SecCodeCopySigningInformation(
        staticCode, SecCSFlags(rawValue: SecCSFlags.RawValue(kSecCSSigningInformation)),
        &information) == errSecSuccess,
      let values = information as? [String: Any],
      let flags = values[kSecCodeInfoFlags as String] as? UInt32
    else { return false }
    return flags & SecCodeSignatureFlags.adhoc.rawValue != 0
  }
}
