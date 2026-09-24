import Foundation

/// Everything needed to start the daemon process.
public struct DaemonLaunchRequest: Hashable, Sendable {
  public var executable: URL
  public var arguments: [String]
  public var environment: [String: String]
  public var workingDirectory: URL
  /// Give the process a stdin pipe that stays open for this process's lifetime (the daemon's
  /// watchdog preload treats EOF as "the app is gone"). False = `/dev/null`.
  public var keepsStandardInputOpen: Bool

  public init(
    executable: URL, arguments: [String], environment: [String: String], workingDirectory: URL,
    keepsStandardInputOpen: Bool
  ) {
    self.executable = executable
    self.arguments = arguments
    self.environment = environment
    self.workingDirectory = workingDirectory
    self.keepsStandardInputOpen = keepsStandardInputOpen
  }
}

/// How a process ended.
public enum DaemonProcessExit: Hashable, Sendable, CustomStringConvertible {
  case exited(status: Int32)
  case signaled(signal: Int32)

  /// "exited with status 1" / "was killed by SIGKILL".
  public var description: String {
    switch self {
    case .exited(let status): "exited with status \(status)"
    case .signaled(let signal): "was killed by \(Self.signalName(signal))"
    }
  }

  static func signalName(_ signal: Int32) -> String {
    switch signal {
    case SIGTERM: "SIGTERM"
    case SIGKILL: "SIGKILL"
    case SIGINT: "SIGINT"
    case SIGHUP: "SIGHUP"
    case SIGABRT: "SIGABRT"
    case SIGSEGV: "SIGSEGV"
    case SIGBUS: "SIGBUS"
    default: "signal \(signal)"
    }
  }
}

/// A launched daemon process.
public protocol DaemonProcessHandle: AnyObject, Sendable {
  var pid: Int32 { get }
  /// Output lines (stdout and stderr in arrival order), in batches. Single consumer; finishes
  /// shortly after the process exits.
  var output: AsyncStream<[String]> { get }
  /// The last output lines (up to 50), available without consuming `output`.
  var recentOutput: [String] { get }
  /// Nil while the process runs.
  var exitStatus: DaemonProcessExit? { get }
  /// Waits for the process to end; nil if the waiting task is cancelled first.
  func waitForExit() async -> DaemonProcessExit?
  /// Sends `signal` once: to the process group when the process leads its own group (so helpers
  /// it started get it too), else to the process. No-op after exit.
  func signal(_ signal: Int32)
}

/// Starts daemon processes, injectable for tests.
public protocol DaemonProcessLaunching: Sendable {
  func launch(_ request: DaemonLaunchRequest) throws -> any DaemonProcessHandle
}
