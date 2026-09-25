import Foundation

/// A macOS privacy permission computer use needs. It's granted to Daily Do List: the managed daemon
/// is the app's child, so macOS checks the app's grants for it and for the helpers it starts.
enum ComputerPermission: String, CaseIterable, Identifiable, Sendable {
  /// Reading other apps' controls, and clicking and typing in them.
  case accessibility
  /// Seeing other apps' windows.
  case screenRecording

  var id: String { rawValue }

  /// Its name in the app.
  var title: String {
    switch self {
    case .accessibility: "Accessibility"
    case .screenRecording: "Screen Recording"
    }
  }

  /// What it lets agents do.
  var purpose: String {
    switch self {
    case .accessibility: "Read the buttons and fields of other apps, and click and type in them."
    case .screenRecording: "See the windows of other apps."
    }
  }

  var systemImage: String {
    switch self {
    case .accessibility: "accessibility"
    case .screenRecording: "rectangle.dashed.badge.record"
    }
  }

  /// The list in System Settings → Privacy & Security where Daily Do List is switched on.
  func settingsListName(macOSMajorVersion: Int) -> String {
    switch self {
    case .accessibility: "Accessibility"
    case .screenRecording:
      macOSMajorVersion >= 15 ? "Screen & System Audio Recording" : "Screen Recording"
    }
  }

  /// macOS applies an Accessibility grant to the running app; Screen Recording only once the app
  /// relaunches.
  var appliesWithoutRelaunch: Bool { self == .accessibility }

  /// Links to its list in System Settings, the first that opens wins: the Privacy & Security anchor
  /// under the pane's older and newer names, then the pane itself.
  var settingsURLs: [URL] {
    let anchor =
      switch self {
      case .accessibility: "Privacy_Accessibility"
      case .screenRecording: "Privacy_ScreenCapture"
      }
    return [
      "x-apple.systempreferences:com.apple.preference.security?\(anchor)",
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?\(anchor)",
      "x-apple.systempreferences:com.apple.preference.security",
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension",
    ].compactMap(URL.init(string:))
  }
}

/// Where a permission stands for this process.
enum ComputerPermissionStatus: Equatable, Sendable {
  case granted
  case notGranted
  /// Screen Recording after Daily Do List sent the user to System Settings for it. macOS only
  /// applies it once the app relaunches, so whether they turned it on can't be seen before then.
  case awaitingRelaunch
}

/// What the guide panel beside System Settings shows.
struct ComputerAccessGuide: Equatable, Sendable {
  enum Phase: Equatable, Sendable {
    /// Waiting for the user to switch Daily Do List on (and, for Screen Recording, to relaunch).
    case waiting
    /// This permission is on; another one is still missing.
    case granted
    /// Everything is on. The guide closes by itself.
    case allSet
  }

  var permission: ComputerPermission
  var phase: Phase
  /// The permissions this setup walks through, in order.
  var steps: [ComputerPermission]

  /// "Step 1 of 2", when there's more than one step.
  var stepLabel: String? {
    guard steps.count > 1, let index = steps.firstIndex(of: permission) else { return nil }
    return "Step \(index + 1) of \(steps.count)"
  }
}

/// Who started the daemon the app uses, which decides whose permissions it gets: macOS checks the
/// app that started a process.
enum DaemonHost: Equatable, Sendable {
  /// Daily Do List runs it (managed): the app's permissions are the daemon's.
  case thisApp
  /// It was already running when the app started (for example `pnpm dev` in a terminal).
  case otherApp
  /// Settings → General → External.
  case external
  /// Demo mode has no daemon.
  case demo

  /// Why granting Daily Do List the permissions doesn't reach this daemon; nil when it does.
  var permissionsNote: String? {
    switch self {
    case .thisApp:
      nil
    case .otherApp:
      """
      Daily Do List didn't start the daemon it's using: it was already running, for example from \
      `pnpm dev` in a terminal. macOS gives a daemon the permissions of the app that started it, \
      so turn these on for that app (such as your terminal), or quit that daemon and relaunch \
      Daily Do List so it runs its own.
      """
    case .external:
      """
      Daily Do List connects to an external daemon (Settings → General). macOS gives a daemon the \
      permissions of the app that started it, so turn these on for that app instead.
      """
    case .demo:
      "Demo mode runs without a daemon, so agents can't use your apps here."
    }
  }
}
