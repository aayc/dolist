import Foundation
import Testing

@testable import DailyDoListDaemon

/// Node and the fake daemon script for tests that run real processes.
enum RealProcesses {
  static let node = Task<URL?, Never> {
    let locator = NodeLocator(
      configuredPath: nil, environment: ProcessInfo.processInfo.environment,
      homeDirectory: FileManager.default.homeDirectoryForCurrentUser,
      fileSystem: LocalDaemonFileSystem(), commands: ProcessCommandRunner())
    return try? await locator.locate().url
  }

  static let fakeDaemon = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().appendingPathComponent("Fixtures/fake-daemon.mjs")

  static func isAlive(_ pid: Int32) -> Bool {
    kill(pid, 0) == 0 || errno == EPERM
  }

  /// Starts the fake daemon outside any supervisor (a daemon "someone else" runs).
  static func launchUnsupervised(home: URL, port: Int, extra: [String: String] = [:]) async throws -> Process {
    let nodeURL: URL = try #require(await node.value)
    let process = Process()
    process.executableURL = nodeURL
    process.arguments = [fakeDaemon.path]
    process.environment = ProcessInfo.processInfo.environment.merging(
      ["DDL_HOME": home.path, "DDL_PORT": String(port)].merging(extra) { $1 }) { $1 }
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    let checker = URLSessionHealthChecker()
    let base = URL(string: "http://127.0.0.1:\(port)")!
    for _ in 0..<200 {
      let token = try? String(contentsOf: home.appendingPathComponent("daemon-token"), encoding: .utf8)
      switch await checker.check(baseURL: base, token: token?.trimmingCharacters(in: .whitespacesAndNewlines)) {
      case .healthy, .foreign: return process
      default: try await Task.sleep(for: .milliseconds(50))
      }
    }
    process.terminate()
    throw LocalPort.Failure(description: "the unsupervised fake daemon never answered")
  }
}

@MainActor
@Suite(
  "DaemonSupervisor (real processes)", .serialized,
  .enabled("needs Node.js 24.4+ (install Node 24)") { await RealProcesses.node.value != nil })
struct RealProcessTests {
  /// Runs `body` with a supervisor for the fake daemon in a temporary DDL_HOME on a free port,
  /// then always stops the supervisor and removes the folder.
  func withSupervisor(
    extra: [String: String] = [:],
    timing: DaemonSupervisorTiming = DaemonSupervisorTiming(),
    restartPolicy: DaemonRestartPolicy = DaemonRestartPolicy(initialDelay: .milliseconds(200)),
    port fixedPort: Int? = nil,
    _ body: (DaemonSupervisor, URL) async throws -> Void
  ) async throws {
    let home = FileManager.default.temporaryDirectory
      .appendingPathComponent("ddl-supervisor-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    let port = try fixedPort ?? LocalPort.findFree()
    let configuration = DaemonLaunchConfiguration(
      home: home, port: port, nodePath: await RealProcesses.node.value,
      daemonEntry: RealProcesses.fakeDaemon, extraEnvironment: extra)
    let supervisor = DaemonSupervisor(
      configuration: configuration,
      dependencies: DaemonSupervisorDependencies(timing: timing, restartPolicy: restartPolicy))
    do {
      try await body(supervisor, home)
    } catch {
      await supervisor.stop()
      try? FileManager.default.removeItem(at: home)
      throw error
    }
    await supervisor.stop()
    try? FileManager.default.removeItem(at: home)
  }

  func waitUntil(timeout: Duration = .seconds(20), _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
      if condition() { return true }
      try? await Task.sleep(for: .milliseconds(20))
    }
    return condition()
  }

  @Test func spawnsHealthChecksAndStops() async throws {
    try await withSupervisor { supervisor, home in
      let connection = try #require(await supervisor.start(), "\(supervisor.state)")
      let pid = try #require(supervisor.state.pid)

      let token = try String(contentsOf: home.appendingPathComponent("daemon-token"), encoding: .utf8)
      #expect(connection.token == token.trimmingCharacters(in: .whitespacesAndNewlines))
      #expect(await URLSessionHealthChecker().check(baseURL: connection.baseURL, token: connection.token)
        == .healthy(DaemonHealth(version: "0.0.0-fake", apiVersion: 1, vaultName: "Fake", agentMode: "mock")))
      #expect(supervisor.health?.version == "0.0.0-fake")
      #expect(await waitUntil { supervisor.logLines.contains { $0.contains("fake daemon listening") } })
      #expect(await waitUntil { supervisor.logLines.contains("fake daemon stderr line") }, "stderr is captured too")
      #expect(getpgid(pid) == pid, "the daemon leads its own process group")

      await supervisor.stop()

      #expect(supervisor.state == .stopped)
      #expect(!RealProcesses.isAlive(pid))
      guard case .unreachable = await URLSessionHealthChecker().check(baseURL: connection.baseURL, token: connection.token) else {
        Issue.record("the port should be free after stop()")
        return
      }
    }
  }

  @Test func attachesToADaemonItDidNotStartAndLeavesItRunning() async throws {
    try await withSupervisor { supervisor, home in
      let external = try await RealProcesses.launchUnsupervised(home: home, port: supervisor.configuration.port)
      defer { external.terminate() }

      let connection = try #require(await supervisor.start())
      #expect(supervisor.state == .attached(connection: connection))

      await supervisor.stop()

      #expect(supervisor.state == .stopped)
      #expect(external.isRunning)
      guard case .healthy = await URLSessionHealthChecker().check(baseURL: connection.baseURL, token: connection.token) else {
        Issue.record("the external daemon should still answer")
        return
      }
    }
  }

  @Test func restartsAfterACrash() async throws {
    try await withSupervisor(extra: ["FAKE_DAEMON_CRASH_AFTER_MS": "300", "FAKE_DAEMON_CRASH_TIMES": "1"]) {
      supervisor, _ in
      let first = try #require(await supervisor.start())
      let firstPid = try #require(supervisor.state.pid)
      var sawRestarting = false
      let updates = supervisor.stateUpdates()
      let watcher = Task { @MainActor in
        for await state in updates {
          if state.restartAttempt == 1 { sawRestarting = true }
          if let pid = state.pid, pid != firstPid { return pid }
        }
        return Int32(0)
      }

      let secondPid = await watcher.value

      #expect(sawRestarting)
      #expect(secondPid != 0 && secondPid != firstPid)
      #expect(!RealProcesses.isAlive(firstPid))
      #expect(supervisor.state.connection == first, "same port and token file")
      #expect(supervisor.logLines.contains { $0.contains("crashing on purpose") })
      #expect(supervisor.logLines.contains { $0.contains("exited with status 3") })
    }
  }

  @Test func escalatesToSIGKILLWhenSIGTERMIsIgnored() async throws {
    try await withSupervisor(
      extra: ["FAKE_DAEMON_IGNORE_SIGTERM": "1"],
      timing: DaemonSupervisorTiming(stopGracePeriod: .seconds(1))
    ) { supervisor, _ in
      _ = try #require(await supervisor.start())
      let pid = try #require(supervisor.state.pid)

      await supervisor.stop()

      #expect(!RealProcesses.isAlive(pid))
      #expect(supervisor.logLines.contains { $0.contains("fake daemon ignoring SIGTERM") })
      #expect(supervisor.logLines.contains { $0.contains("sending SIGKILL") })
    }
  }

  @Test func reportsAnotherProgramOnThePort() async throws {
    try await withSupervisor { supervisor, home in
      let foreignHome = home.appendingPathComponent("other")
      let foreign = try await RealProcesses.launchUnsupervised(
        home: foreignHome, port: supervisor.configuration.port, extra: ["FAKE_DAEMON_FOREIGN": "1"])
      defer { foreign.terminate() }

      #expect(await supervisor.start() == nil)

      guard case .portInUse(let port, let detail) = supervisor.lastError else {
        Issue.record("expected portInUse, got \(supervisor.state)")
        return
      }
      #expect(port == supervisor.configuration.port)
      #expect(detail.contains("HTTP 404"))
      #expect(detail.contains("FakeForeign"))
    }
  }

  @Test func reportsADaemonThatRejectsTheToken() async throws {
    try await withSupervisor { supervisor, home in
      let other = try await RealProcesses.launchUnsupervised(
        home: home.appendingPathComponent("other-home"), port: supervisor.configuration.port)
      defer { other.terminate() }

      #expect(await supervisor.start() == nil)

      guard case .tokenRejected = supervisor.lastError else {
        Issue.record("expected tokenRejected, got \(supervisor.state)")
        return
      }
    }
  }

  @Test func exitDuringStartupShowsTheDaemonsOutput() async throws {
    try await withSupervisor(extra: ["DDL_PORT": "0"]) { supervisor, _ in
      #expect(await supervisor.start() == nil)

      let reason = try #require(supervisor.state.failureReason)
      #expect(reason.contains("exited with status 2 while starting"))
      #expect(reason.contains("DDL_HOME and DDL_PORT are required"))
    }
  }

  @Test func watchdogStopsTheDaemonWhenTheAppGoesAway() async throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("ddl-watchdog-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: home) }
    let port = try LocalPort.findFree()
    let launcher = FoundationProcessLauncher()
    let process = try launcher.launch(
      DaemonLaunchRequest(
        executable: try #require(await RealProcesses.node.value),
        arguments: DaemonProcessEnvironment.arguments(entry: RealProcesses.fakeDaemon, stopsWhenAppExits: true),
        environment: ProcessInfo.processInfo.environment.merging(["DDL_HOME": home.path, "DDL_PORT": String(port)]) { $1 },
        workingDirectory: FileManager.default.temporaryDirectory,
        keepsStandardInputOpen: true))
    defer { process.signal(SIGKILL) }
    #expect(await waitUntil { process.recentOutput.contains { $0.contains("listening") } })
    #expect(process.exitStatus == nil, "an open stdin keeps it running")

    // What the kernel does when the app dies: the last write end of the daemon's stdin closes.
    let handle = try #require(process as? FoundationDaemonProcess)
    handle.closeStandardInputForTesting()

    let exit = await withTaskGroup(of: DaemonProcessExit?.self) { group in
      group.addTask { await process.waitForExit() }
      group.addTask {
        try? await Task.sleep(for: .seconds(10))
        return nil
      }
      let first = await group.next() ?? nil
      group.cancelAll()
      return first
    }
    #expect(exit == .exited(status: 0))
    #expect(process.recentOutput.contains("fake daemon received SIGTERM"))
  }
}
