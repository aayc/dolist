import Foundation

/// Everything the helper touches outside itself, so its logic runs against fakes in tests.
public struct ComputerSystem: Sendable {
  public var accessibility: any AccessibilityAPI
  public var workspace: any WorkspaceAPI
  public var windows: any WindowListing
  public var events: any EventPosting
  public var capture: any ScreenCapturing
  public var permissions: any PermissionProbing
  public var processes: any ProcessTreeReading
  public var clock: any ComputerClock

  public init(
    accessibility: any AccessibilityAPI, workspace: any WorkspaceAPI, windows: any WindowListing,
    events: any EventPosting, capture: any ScreenCapturing, permissions: any PermissionProbing,
    processes: any ProcessTreeReading, clock: any ComputerClock
  ) {
    self.accessibility = accessibility
    self.workspace = workspace
    self.windows = windows
    self.events = events
    self.capture = capture
    self.permissions = permissions
    self.processes = processes
    self.clock = clock
  }
}

/// Limits and pacing of `ComputerService`.
public struct ComputerConfiguration: Sendable {
  public var protectedTargets: ProtectedTargets
  /// How long `resolveApp` waits for an app it launched.
  public var launchTimeout: Duration = .seconds(10)
  public var launchPollInterval: Duration = .milliseconds(100)
  /// How long one snapshot may read before it returns what it has (`truncated`).
  public var snapshotTimeBudget: Duration = .seconds(6)
  /// Pause after first enabling an Electron app's accessibility tree, while it builds.
  public var electronWarmUp: Duration = .milliseconds(500)
  /// Pause between synthesized key events.
  public var keyInterval: Duration = .milliseconds(8)
  /// Pause between the clicks of a double or triple click.
  public var clickInterval: Duration = .milliseconds(50)
  public var scrollInterval: Duration = .milliseconds(20)
  /// Pause after focusing an element, before typing into it.
  public var focusSettle: Duration = .milliseconds(50)
  /// How long `activate` and input wait for the app to come to the front.
  public var activationTimeout: Duration = .seconds(2)
  /// Pause after bringing an app to the front for input, while its window becomes key.
  public var activationSettle: Duration = .milliseconds(150)

  public init(protectedTargets: ProtectedTargets = .standard()) {
    self.protectedTargets = protectedTargets
  }
}
