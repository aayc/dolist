import Foundation

/// Timeouts and intervals of `DaemonSupervisor`.
public struct DaemonSupervisorTiming: Hashable, Sendable {
  /// How long a launched daemon has to answer a health check.
  public var startupTimeout: Duration
  /// Interval between startup health checks.
  public var pollInterval: Duration
  /// How long `stop()` waits after SIGTERM before SIGKILL.
  public var stopGracePeriod: Duration
  /// How long to wait for the process to disappear after SIGKILL.
  public var killTimeout: Duration
  /// Interval between health checks of an attached daemon (which we can't watch exit).
  public var attachedCheckInterval: Duration
  /// Consecutive failed checks before an attached daemon counts as gone.
  public var attachedMissesAllowed: Int

  public init(
    startupTimeout: Duration = .seconds(20),
    pollInterval: Duration = .milliseconds(100),
    stopGracePeriod: Duration = .seconds(5),
    killTimeout: Duration = .seconds(2),
    attachedCheckInterval: Duration = .seconds(5),
    attachedMissesAllowed: Int = 2
  ) {
    self.startupTimeout = startupTimeout
    self.pollInterval = pollInterval
    self.stopGracePeriod = stopGracePeriod
    self.killTimeout = killTimeout
    self.attachedCheckInterval = attachedCheckInterval
    self.attachedMissesAllowed = max(1, attachedMissesAllowed)
  }
}

/// This process's view of the machine: environment, home folder and where the app runs from.
public struct DaemonHostEnvironment: Sendable {
  public var variables: [String: String]
  public var homeDirectory: URL
  /// `Contents/Resources` of the running app (nil outside an app bundle).
  public var bundleResourceURL: URL?
  public var executableURL: URL?
  public var currentDirectory: URL

  public init(
    variables: [String: String],
    homeDirectory: URL,
    bundleResourceURL: URL?,
    executableURL: URL?,
    currentDirectory: URL
  ) {
    self.variables = variables
    self.homeDirectory = homeDirectory
    self.bundleResourceURL = bundleResourceURL
    self.executableURL = executableURL
    self.currentDirectory = currentDirectory
  }

  /// The running process. `bundleResourceURL` is only set inside a `.app` (a bare SwiftPM
  /// executable's "resources" are its build folder).
  public static var current: DaemonHostEnvironment {
    let bundle = Bundle.main
    return DaemonHostEnvironment(
      variables: ProcessInfo.processInfo.environment,
      homeDirectory: FileManager.default.homeDirectoryForCurrentUser,
      bundleResourceURL: bundle.bundleURL.pathExtension == "app" ? bundle.resourceURL : nil,
      executableURL: bundle.executableURL,
      currentDirectory: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    )
  }
}

/// Everything `DaemonSupervisor` touches outside itself, so its logic runs against fakes in tests.
public struct DaemonSupervisorDependencies: Sendable {
  public var launcher: any DaemonProcessLaunching
  public var healthChecker: any DaemonHealthChecking
  public var fileSystem: any DaemonFileSystem
  public var commands: any CommandRunning
  public var clock: any DaemonClock
  public var host: DaemonHostEnvironment
  public var timing: DaemonSupervisorTiming
  public var restartPolicy: DaemonRestartPolicy

  public init(
    launcher: any DaemonProcessLaunching = FoundationProcessLauncher(),
    healthChecker: any DaemonHealthChecking = URLSessionHealthChecker(),
    fileSystem: any DaemonFileSystem = LocalDaemonFileSystem(),
    commands: any CommandRunning = ProcessCommandRunner(),
    clock: any DaemonClock = SystemDaemonClock(),
    host: DaemonHostEnvironment = .current,
    timing: DaemonSupervisorTiming = DaemonSupervisorTiming(),
    restartPolicy: DaemonRestartPolicy = DaemonRestartPolicy()
  ) {
    self.launcher = launcher
    self.healthChecker = healthChecker
    self.fileSystem = fileSystem
    self.commands = commands
    self.clock = clock
    self.host = host
    self.timing = timing
    self.restartPolicy = restartPolicy
  }

  /// The real system.
  public static var live: DaemonSupervisorDependencies { DaemonSupervisorDependencies() }
}
