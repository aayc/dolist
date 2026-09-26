import Foundation

@testable import DailyDoListDaemon

/// A `DaemonSupervisor` wired to fakes: a Node 24 at `/opt/homebrew/bin/node`, the daemon bundled
/// in a fake app, nothing listening on the port.
@MainActor
struct SupervisorHarness {
  static let homeDirectory = URL(fileURLWithPath: "/Users/me")
  static let nodePath = "/opt/homebrew/bin/node"
  static let appResources = URL(
    fileURLWithPath: "/Applications/Daily Do List.app/Contents/Resources")
  static let bundledEntry = appResources.appendingPathComponent("daemon/dist/main.js").path

  let machine: FakeMachine
  let clock: FakeClock
  let commands: FakeCommandRunner
  let supervisor: DaemonSupervisor

  var files: FakeFileSystem { machine.files }
  var configuration: DaemonLaunchConfiguration { supervisor.configuration }

  init(
    configuration: DaemonLaunchConfiguration? = nil,
    timing: DaemonSupervisorTiming = DaemonSupervisorTiming(
      attachedCheckInterval: .seconds(300)),
    restartPolicy: DaemonRestartPolicy = DaemonRestartPolicy(),
    environment: [String: String] = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
  ) {
    let configuration =
      configuration
      ?? DaemonLaunchConfiguration(
        home: Self.homeDirectory.appendingPathComponent(".daily-do-list"), port: 7444)
    machine = FakeMachine(tokenPath: configuration.tokenFile.path)
    clock = FakeClock()
    commands = FakeCommandRunner()
    commands.setLoginShellOutput("\n\(NodeLocator.pathMarker)/usr/bin:/bin\n")
    machine.files.addExecutable(Self.nodePath)
    commands.setNodeVersion("v24.4.1", at: Self.nodePath)
    machine.files.addFile(Self.bundledEntry)
    let dependencies = DaemonSupervisorDependencies(
      launcher: FakeLauncher(machine: machine),
      healthChecker: FakeHealthChecker(machine: machine),
      fileSystem: machine.files,
      commands: commands,
      clock: clock,
      host: DaemonHostEnvironment(
        variables: environment,
        homeDirectory: Self.homeDirectory,
        bundleResourceURL: Self.appResources,
        executableURL: Self.appResources.deletingLastPathComponent()
          .appendingPathComponent("MacOS/DailyDoList"),
        currentDirectory: URL(fileURLWithPath: "/")),
      timing: timing,
      restartPolicy: restartPolicy)
    supervisor = DaemonSupervisor(configuration: configuration, dependencies: dependencies)
  }

  /// The most recently launched fake process.
  var lastProcess: FakeProcess? { machine.processes.last }
}

struct TimeoutError: Error, CustomStringConvertible {
  let description: String
}

/// Polls `condition` (on the caller's actor, in real time) every few milliseconds until it holds,
/// failing after `timeout`: `DailyDoListClientTestSupport`'s `eventually`, which this package
/// doesn't depend on.
func eventually(
  _ what: @autoclosure () -> String = "condition", timeout: Duration = .seconds(10),
  isolation: isolated (any Actor)? = #isolation, _ condition: () -> Bool
) async throws {
  let deadline = ContinuousClock.now + timeout
  while !condition() {
    guard ContinuousClock.now < deadline else {
      throw TimeoutError(description: "timed out waiting for \(what())")
    }
    try await Task.sleep(for: .milliseconds(2))
  }
}

extension DaemonSupervisorState {
  var isRunning: Bool {
    if case .running = self { return true }
    return false
  }
  var isAttached: Bool {
    if case .attached = self { return true }
    return false
  }
  var isFailed: Bool {
    if case .failed = self { return true }
    return false
  }
  var restartAttempt: Int? {
    if case .restarting(let attempt, _) = self { return attempt }
    return nil
  }
  var pid: Int32? {
    if case .running(let pid, _) = self { return pid }
    return nil
  }
  var failureReason: String? {
    if case .failed(let reason) = self { return reason }
    return nil
  }
}
