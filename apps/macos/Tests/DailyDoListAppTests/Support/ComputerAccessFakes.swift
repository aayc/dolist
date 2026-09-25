import AppKit
import Foundation

@testable import DailyDoListApp

/// Fakes for every OS seam of computer use: permissions the test grants, System Settings links
/// that open or not, System Settings' state, the guide panel, relaunching and activation. They
/// share one ordered log of what the app asked for.
@MainActor
final class ComputerAccessFakes {
  let probe = FakeComputerAccessProbe()
  let opener = FakeURLOpener()
  let systemSettings = FakeSystemSettings()
  let presenter = FakeGuidePresenter()
  let relauncher = FakeRelauncher()
  private(set) var log: [String] = []
  private(set) var activations = 0

  init(granted: Set<ComputerPermission> = []) {
    probe.granted = granted
    for fake in [probe, opener, relauncher] as [any LoggingFake] {
      fake.record = { [unowned self] entry in self.log.append(entry) }
    }
  }

  func system(macOSMajorVersion: Int = 26, adHoc: Bool = false) -> ComputerAccessSystem {
    ComputerAccessSystem(
      probe: probe, opener: opener, systemSettings: systemSettings, presenter: presenter,
      relauncher: relauncher,
      activateApp: { [unowned self] in
        activations += 1
        log.append("activate")
      },
      isSignedAdHoc: { adHoc }, macOSMajorVersion: macOSMajorVersion,
      appBundleURL: URL(fileURLWithPath: "/Applications/Daily Do List.app"),
      appIcon: { Self.appIcon })
  }

  /// The app's real icon (the repository's rendered source), for snapshots.
  static let appIcon: NSImage = {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Resources/AppIcon-1024.png")
    return NSImage(contentsOf: url) ?? NSImage(size: NSSize(width: 64, height: 64))
  }()
}

@MainActor
protocol LoggingFake: AnyObject {
  var record: (@MainActor (String) -> Void)? { get set }
}

/// Permissions the test grants and revokes; macOS's prompts are recorded, never shown.
@MainActor
final class FakeComputerAccessProbe: ComputerAccessProbing, LoggingFake {
  var granted: Set<ComputerPermission> = []
  /// Permissions macOS grants the moment they're requested (an app it already trusts).
  var grantsOnRequest: Set<ComputerPermission> = []
  private(set) var prompts: [ComputerPermission] = []
  var record: (@MainActor (String) -> Void)?

  func isGranted(_ permission: ComputerPermission) -> Bool { granted.contains(permission) }

  func requestAccess(_ permission: ComputerPermission) -> Bool {
    prompts.append(permission)
    record?("prompt \(permission.rawValue)")
    if grantsOnRequest.contains(permission) { granted.insert(permission) }
    return granted.contains(permission)
  }
}

/// Opens every URL except the ones it rejects, and records each attempt.
@MainActor
final class FakeURLOpener: URLOpening, LoggingFake {
  var rejected: Set<URL> = []
  private(set) var attempts: [URL] = []
  var record: (@MainActor (String) -> Void)?

  func open(_ url: URL) -> Bool {
    attempts.append(url)
    guard !rejected.contains(url) else { return false }
    record?("open \(url.absoluteString)")
    return true
  }
}

@MainActor
final class FakeSystemSettings: SystemSettingsWatching {
  var isFrontmost = false
  var isRunning = false
}

@MainActor
final class FakeGuidePresenter: ComputerAccessGuidePresenting {
  private(set) var showCount = 0
  private(set) var hideCount = 0
  var isShowing: Bool { showCount > hideCount }

  func show(_ access: ComputerAccessSetup) { showCount += 1 }
  func hide() { hideCount += 1 }
}

struct RelaunchFailed: Error, LocalizedError {
  var errorDescription: String? { "The app couldn't be opened." }
}

@MainActor
final class FakeRelauncher: AppRelaunching, LoggingFake {
  var unavailableReason: String?
  var failure: Error?
  /// Runs when a new instance is opened (tests check what happened before).
  var onOpen: (@MainActor () -> Void)?
  private(set) var openCount = 0
  private(set) var terminateCount = 0
  var record: (@MainActor (String) -> Void)?

  func openNewInstance() async throws {
    openCount += 1
    record?("open new instance")
    onOpen?()
    if let failure { throw failure }
  }

  func terminate() {
    terminateCount += 1
    record?("terminate")
  }
}
