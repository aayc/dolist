import Foundation
import Observation

/// Whether Daily Do List has the macOS permissions computer use needs, and the setup that gets
/// them: macOS's own prompt first (it adds the app to the list), then System Settings on the exact
/// list, with a guide panel beside it that checks each permission off the moment it's granted.
///
/// Accessibility applies live (`AXIsProcessTrusted`), Screen Recording only after a relaunch
/// (`CGPreflightScreenCaptureAccess`), which the guide and Settings offer. It polls only while the
/// Computer Use settings or the guide are showing, or System Settings is in front, and stops once
/// everything is granted. The app also refreshes it whenever it becomes active.
@MainActor
@Observable
final class ComputerAccessSetup {
  static let pollInterval: TimeInterval = 0.5
  /// How long "All set" shows before the guide closes and Daily Do List comes back.
  static let allSetDuration: TimeInterval = 1.5

  private(set) var accessibility: ComputerPermissionStatus = .notGranted
  private(set) var screenRecording: ComputerPermissionStatus = .notGranted
  /// What the guide panel shows; nil while it's closed.
  private(set) var guide: ComputerAccessGuide?
  /// Why the last request couldn't open System Settings.
  private(set) var problem: String?
  private(set) var isRelaunching = false

  @ObservationIgnored let system: ComputerAccessSystem
  @ObservationIgnored private let scheduler: AppScheduler
  /// Sent to System Settings for these in this run (Screen Recording then waits for a relaunch).
  @ObservationIgnored private(set) var requested: Set<ComputerPermission> = []
  @ObservationIgnored private var isSettingsPaneVisible = false
  @ObservationIgnored private var pollTimer: ScheduledAction?
  @ObservationIgnored private var closeTimer: ScheduledAction?
  /// System Settings was seen running since the guide opened (it takes a moment to launch).
  @ObservationIgnored private var sawSystemSettingsRunning = false
  @ObservationIgnored private var adHocSignature: Bool?
  /// The app sent the user to System Settings for a permission.
  @ObservationIgnored var onRequest: (@MainActor (ComputerPermission) -> Void)?
  /// Relaunches the app; returns only if that failed.
  @ObservationIgnored var onRelaunch: (@MainActor () async -> Void)?

  init(system: ComputerAccessSystem, scheduler: AppScheduler) {
    self.system = system
    self.scheduler = scheduler
    refresh()
  }

  // MARK: State

  func status(_ permission: ComputerPermission) -> ComputerPermissionStatus {
    switch permission {
    case .accessibility: accessibility
    case .screenRecording: screenRecording
    }
  }

  /// Every permission is granted.
  var isComplete: Bool { ComputerPermission.allCases.allSatisfy { status($0) == .granted } }

  /// The permissions not granted yet, in setup order.
  var missing: [ComputerPermission] {
    ComputerPermission.allCases.filter { status($0) != .granted }
  }

  /// Screen Recording waits for a relaunch.
  var needsRelaunch: Bool { screenRecording == .awaitingRelaunch }

  /// Why the app can't relaunch itself, or nil when it can.
  var relaunchUnavailableReason: String? { system.relauncher.unavailableReason }

  /// Whether this copy is signed ad hoc (checked when first asked).
  var isSignedAdHoc: Bool {
    if let adHocSignature { return adHocSignature }
    let value = system.isSignedAdHoc()
    adHocSignature = value
    return value
  }

  /// The permission's list in System Settings, named as this macOS names it.
  func settingsListName(_ permission: ComputerPermission) -> String {
    permission.settingsListName(macOSMajorVersion: system.macOSMajorVersion)
  }

  /// The missing permission the guide offers after the one it shows.
  var nextPermission: ComputerPermission? {
    guard let guide else { return nil }
    return missing.first { $0 != guide.permission }
  }

  var isPolling: Bool { pollTimer != nil }

  // MARK: Actions

  /// Re-reads both permissions.
  func refresh() {
    let accessibility = probedStatus(.accessibility)
    if accessibility != self.accessibility { self.accessibility = accessibility }
    let screenRecording = probedStatus(.screenRecording)
    if screenRecording != self.screenRecording { self.screenRecording = screenRecording }
    advanceGuide()
  }

  /// "Allow…": macOS's prompt, then System Settings on the permission's list, with the guide
  /// beside it until the permission comes through.
  func request(_ permission: ComputerPermission) {
    problem = nil
    refresh()
    guard status(permission) != .granted else { return }
    if system.probe.requestAccess(permission) {
      refresh()
      return
    }
    guard permission.settingsURLs.contains(where: { system.opener.open($0) }) else {
      problem =
        "Couldn't open System Settings. Open it and go to Privacy & Security → \(settingsListName(permission))."
      return
    }
    requested.insert(permission)
    onRequest?(permission)
    refresh()
    showGuide(permission)
    startPolling()
  }

  /// The guide's "Next": the following permission.
  func continueGuide() {
    guard let next = nextPermission else { return }
    request(next)
  }

  /// The guide's "Done" and "Later": closes it and brings Daily Do List back.
  func finishGuide() {
    refresh()
    closeGuide(returnToApp: true)
  }

  /// "Relaunch Now", so Screen Recording applies.
  func relaunch() {
    guard !isRelaunching, relaunchUnavailableReason == nil, let onRelaunch else { return }
    isRelaunching = true
    Task {
      await onRelaunch()
      isRelaunching = false
    }
  }

  /// The Computer Use settings came on screen: poll while they show.
  func settingsPaneAppeared() {
    isSettingsPaneVisible = true
    refresh()
    startPolling()
  }

  func settingsPaneDisappeared() {
    isSettingsPaneVisible = false
  }

  // MARK: Private

  private func probedStatus(_ permission: ComputerPermission) -> ComputerPermissionStatus {
    if system.probe.isGranted(permission) { return .granted }
    return !permission.appliesWithoutRelaunch && requested.contains(permission)
      ? .awaitingRelaunch : .notGranted
  }

  private func showGuide(_ permission: ComputerPermission) {
    closeTimer?.cancel()
    closeTimer = nil
    // A setup that starts with Accessibility continues to Screen Recording from the guide; Screen
    // Recording can't be seen before the relaunch, so nothing follows it.
    let steps =
      guide.flatMap { $0.steps.contains(permission) ? $0.steps : nil }
      ?? [permission]
      + (permission.appliesWithoutRelaunch ? missing.filter { $0 != permission } : [])
    let wasOpen = guide != nil
    guide = ComputerAccessGuide(permission: permission, phase: .waiting, steps: steps)
    sawSystemSettingsRunning = false
    if !wasOpen { system.presenter.show(self) }
  }

  /// Moves the guide on when its permission comes through.
  private func advanceGuide() {
    guard var guide, guide.phase != .allSet else { return }
    if isComplete {
      guide.phase = .allSet
      self.guide = guide
      closeTimer = scheduler.schedule(after: Self.allSetDuration) { [weak self] in
        self?.closeGuide(returnToApp: true)
      }
    } else if guide.phase == .waiting, status(guide.permission) == .granted {
      guide.phase = .granted
      self.guide = guide
    }
  }

  private func closeGuide(returnToApp: Bool) {
    closeTimer?.cancel()
    closeTimer = nil
    guard guide != nil else { return }
    guide = nil
    system.presenter.hide()
    if returnToApp { system.activateApp() }
  }

  private var shouldPoll: Bool {
    !isComplete && (isSettingsPaneVisible || guide != nil || system.systemSettings.isFrontmost)
  }

  private func startPolling() {
    guard pollTimer == nil, shouldPoll else { return }
    schedulePoll()
  }

  private func schedulePoll() {
    pollTimer = scheduler.schedule(after: Self.pollInterval) { [weak self] in self?.poll() }
  }

  private func poll() {
    pollTimer = nil
    refresh()
    closeGuideIfSystemSettingsQuit()
    if shouldPoll { schedulePoll() }
  }

  /// The user quit System Settings without finishing: the guide has nothing left to point at.
  private func closeGuideIfSystemSettingsQuit() {
    guard guide != nil else { return }
    if system.systemSettings.isRunning {
      sawSystemSettingsRunning = true
    } else if sawSystemSettingsRunning {
      closeGuide(returnToApp: false)
    }
  }
}
