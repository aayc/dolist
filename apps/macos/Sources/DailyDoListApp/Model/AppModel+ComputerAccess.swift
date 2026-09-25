import AppKit
import DailyDoListModels
import Foundation

/// The main window's banner about computer use, if it shows one.
enum ComputerAccessBannerKind: Equatable, Sendable {
  /// "Let the agent use your apps".
  case setUp
  /// Screen Recording is waiting for a relaunch.
  case relaunch

  /// Shown while access is missing and the agent is on and able to run, until dismissed. Only for a
  /// daemon the app runs itself: the app's permissions don't reach any other.
  init?(
    accessibility: ComputerPermissionStatus, screenRecording: ComputerPermissionStatus,
    agent: AgentStatusResponse?, host: DaemonHost, dismissed: Bool
  ) {
    guard !dismissed, host == .thisApp, let agent, agent.enabled, agent.mode != .off,
      agent.problem == nil
    else { return nil }
    switch (accessibility, screenRecording) {
    case (.granted, .granted): return nil
    case (.granted, .awaitingRelaunch): self = .relaunch
    default: self = .setUp
    }
  }
}

extension AppModel {
  /// A launch this soon after Screen Recording was requested is taken as its relaunch.
  static let computerAccessResumeWindow: TimeInterval = 10 * 60

  /// Who started the daemon the app uses, which decides whose permissions it gets.
  var daemonHost: DaemonHost {
    if isDemo { return .demo }
    guard preferences.daemonMode == .managed else { return .external }
    if case .attached = supervisor.state { return .otherApp }
    return .thisApp
  }

  var computerAccessBanner: ComputerAccessBannerKind? {
    ComputerAccessBannerKind(
      accessibility: computerAccess.accessibility, screenRecording: computerAccess.screenRecording,
      agent: agent?.status, host: daemonHost, dismissed: preferences.computerAccessBannerDismissed)
  }

  func dismissComputerAccessBanner() {
    preferences.computerAccessBannerDismissed = true
  }

  /// Opens the Settings window on `pane`.
  func showSettings(_ pane: SettingsPane) {
    ui.settingsPane = pane
    guard environment.enablesSystemServices else { return }
    NSApplication.shared.activate()
    windows.openSettings?()
  }

  /// Opens Settings → Always-On on `section`.
  func showAlwaysOnSettings(_ section: AlwaysOnSection) {
    ui.alwaysOnSection = section
    showSettings(.alwaysOn)
  }

  /// Connects the model's callbacks (once, from `init`).
  func connectComputerAccess() {
    computerAccess.onRequest = { [weak self] permission in
      guard let self, !permission.appliesWithoutRelaunch else { return }
      preferences.computerAccessRequestedAt = environment.now()
    }
    computerAccess.onRelaunch = { [weak self] in await self?.relaunch() }
  }

  /// Relaunches the app so Screen Recording applies. It saves and stops the managed daemon first,
  /// so the new instance starts its own daemon (its child, which gets its grants) instead of
  /// attaching to this one's. If the new instance can't open, this one reconnects and says why.
  func relaunch() async {
    let relauncher = computerAccess.system.relauncher
    guard relauncher.unavailableReason == nil else { return }
    await waitAtMost(AppDelegate.terminationTimeout) { [weak self] in
      await self?.prepareForTermination()
    }
    do {
      try await relauncher.openNewInstance()
    } catch {
      toasts.error("Couldn't relaunch Daily Do List", error)
      await boot()
      return
    }
    relauncher.terminate()
  }

  /// After the relaunch that finishes Screen Recording, the setup continues where it left off: the
  /// Computer Use settings open once. Called when the main window appears.
  func resumeComputerAccessSetup() {
    // A request from this run means the main window reopened, not that the app relaunched.
    guard !computerAccess.requested.contains(.screenRecording),
      let requestedAt = preferences.computerAccessRequestedAt
    else { return }
    preferences.computerAccessRequestedAt = nil
    guard environment.now().timeIntervalSince(requestedAt) < Self.computerAccessResumeWindow
    else { return }
    showSettings(.computerUse)
  }

  /// Waits for `operation`, at most `seconds` (it keeps running after that).
  private func waitAtMost(
    _ seconds: TimeInterval, _ operation: @escaping @MainActor () async -> Void
  ) async {
    let scheduler = environment.scheduler
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let once = ResumeOnce(continuation)
      let timeout = scheduler.schedule(after: seconds) { once.resume() }
      Task { @MainActor in
        await operation()
        timeout.cancel()
        once.resume()
      }
    }
  }
}

/// Resumes a continuation the first time it's asked to.
@MainActor
private final class ResumeOnce {
  private var continuation: CheckedContinuation<Void, Never>?

  init(_ continuation: CheckedContinuation<Void, Never>) {
    self.continuation = continuation
  }

  func resume() {
    continuation?.resume()
    continuation = nil
  }
}
