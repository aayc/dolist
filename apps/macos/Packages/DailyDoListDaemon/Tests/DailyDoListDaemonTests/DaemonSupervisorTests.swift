import Foundation
import Testing

@testable import DailyDoListDaemon

@MainActor
@Suite("DaemonSupervisor (fakes)")
struct DaemonSupervisorTests {
  // MARK: Attach vs spawn

  @Test func attachesToARunningDaemonWithoutLaunching() async {
    let harness = SupervisorHarness()
    harness.machine.runExternalDaemon(token: "abc")

    let connection = await harness.supervisor.start()

    #expect(connection == DaemonConnectionInfo(baseURL: harness.configuration.baseURL, token: "abc"))
    #expect(harness.supervisor.state == .attached(connection: connection!))
    #expect(harness.supervisor.health?.version == "9.9.9")
    #expect(harness.machine.requests.isEmpty)
    #expect(harness.commands.calls.isEmpty, "attaching needs no Node")
  }

  @Test func launchesTheDaemonWhenNothingAnswers() async throws {
    var configuration = DaemonLaunchConfiguration(
      home: URL(fileURLWithPath: "/Users/me/.ddl-test"),
      vaultPath: URL(fileURLWithPath: "/Users/me/Notes"),
      port: 7555, agentMode: "mock", extraEnvironment: ["DDL_LOG_LEVEL": "debug"])
    configuration.stopsWhenAppExits = true
    let harness = SupervisorHarness(
      configuration: configuration,
      environment: ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8", "DDL_PORT": "1"])

    let connection = try #require(await harness.supervisor.start())

    let process = try #require(harness.lastProcess)
    #expect(harness.supervisor.state == .running(pid: process.pid, connection: connection))
    #expect(connection.token == "token-\(process.pid)")
    #expect(connection.baseURL.absoluteString == "http://127.0.0.1:7555")
    let request = try #require(harness.machine.requests.first)
    #expect(request.executable.path == SupervisorHarness.nodePath)
    #expect(request.arguments == ["--import", DaemonProcessEnvironment.watchdogPreload, SupervisorHarness.bundledEntry])
    #expect(request.keepsStandardInputOpen)
    #expect(request.workingDirectory.path == SupervisorHarness.appResources.appendingPathComponent("daemon").path)
    #expect(request.environment["DDL_HOME"] == "/Users/me/.ddl-test")
    #expect(request.environment["DDL_VAULT"] == "/Users/me/Notes")
    #expect(request.environment["DDL_PORT"] == "7555", "the configured port wins over the inherited one")
    #expect(request.environment["DDL_AGENT_MODE"] == "mock")
    #expect(request.environment["DDL_LOG_LEVEL"] == "debug")
    #expect(request.environment["LANG"] == "en_US.UTF-8")
    #expect(request.environment["PATH"] == "/opt/homebrew/bin:/usr/bin:/bin")
    #expect(harness.supervisor.resolvedNode?.version == NodeVersion(major: 24, minor: 4, patch: 1))
    #expect(harness.supervisor.resolvedEntry?.source == .appBundle)
    #expect(harness.supervisor.logLines.contains { $0.hasPrefix("[supervisor] Launched") })
    #expect(await harness.waitUntil { harness.supervisor.logLines.contains("listening") }, "output is pumped asynchronously")
  }

  @Test func withoutTheWatchdogStdinIsNotKeptOpen() async throws {
    var configuration = DaemonLaunchConfiguration(
      home: URL(fileURLWithPath: "/Users/me/.daily-do-list"), port: 7444)
    configuration.stopsWhenAppExits = false
    let harness = SupervisorHarness(configuration: configuration)

    _ = try #require(await harness.supervisor.start())

    let request = try #require(harness.machine.requests.first)
    #expect(request.arguments == [SupervisorHarness.bundledEntry])
    #expect(!request.keepsStandardInputOpen)
  }

  @Test func waitsUntilTheDaemonAnswersAndRereadsARotatedToken() async throws {
    let harness = SupervisorHarness()
    harness.files.write("stale\n", to: harness.configuration.tokenFile.path)
    harness.machine.script(.healthy(afterChecks: 6, rotatesToken: true))

    let connection = try #require(await harness.supervisor.start())

    let process = try #require(harness.lastProcess)
    #expect(connection.token == "rotated-\(process.pid)")
    #expect(harness.supervisor.state.isRunning)
    #expect(harness.clock.elapsedTime >= .milliseconds(500), "polled every 100 ms")
    #expect(harness.clock.sleeps.allSatisfy { $0 == .milliseconds(100) })
  }

  @Test func startIsIdempotent() async {
    let harness = SupervisorHarness()
    async let first = harness.supervisor.start()
    async let second = harness.supervisor.start()
    let (a, b) = await (first, second)

    #expect(a != nil && a == b)
    #expect(harness.machine.requests.count == 1)
    #expect(await harness.supervisor.start() == a)
    #expect(harness.machine.requests.count == 1)
  }

  // MARK: Startup failures

  @Test func healthTimeoutFailsAndStopsTheProcess() async throws {
    let harness = SupervisorHarness()
    harness.machine.script(.neverHealthy)

    let connection = await harness.supervisor.start()

    #expect(connection == nil)
    #expect(harness.supervisor.lastError == .startupTimedOut(seconds: 20, logTail: ["starting…"]))
    let reason = try #require(harness.supervisor.state.failureReason)
    #expect(reason.contains("didn't answer health checks within 20 s"))
    #expect(reason.contains("starting…"), "the failure shows the daemon's last output")
    #expect(harness.clock.elapsedTime >= .seconds(20))
    #expect(harness.lastProcess?.signals == [SIGTERM])
  }

  @Test func exitDuringStartupReportsTheExitAndOutput() async throws {
    let harness = SupervisorHarness()
    harness.machine.script(
      .exits(status: 1, output: ["Daily Do List daemon failed to start: Invalid config.json"]))

    #expect(await harness.supervisor.start() == nil)

    let reason = try #require(harness.supervisor.state.failureReason)
    #expect(reason.hasPrefix("The daemon exited with status 1 while starting."))
    #expect(reason.contains("Invalid config.json"))
    #expect(harness.machine.requests.count == 1, "a failed first start is not retried")
  }

  @Test func portHeldByAnotherProgramFailsWithoutLaunching() async throws {
    let harness = SupervisorHarness()
    harness.machine.listener = .foreign("HTTP 404, Server: nginx")

    #expect(await harness.supervisor.start() == nil)

    #expect(harness.supervisor.lastError == .portInUse(port: 7444, detail: "HTTP 404, Server: nginx"))
    let reason = try #require(harness.supervisor.state.failureReason)
    #expect(reason.contains("Port 7444 on 127.0.0.1 is in use by another program"))
    #expect(reason.contains("nginx"))
    #expect(harness.machine.requests.isEmpty)
  }

  @Test func portConflictNoticedByTheDaemonIsExplained() async throws {
    let harness = SupervisorHarness()
    harness.machine.script(
      .exits(
        status: 1,
        output: [
          "Daily Do List daemon failed to start: Port 7444 is already in use. Is another daemon running? Set DDL_PORT."
        ]))

    #expect(await harness.supervisor.start() == nil)

    guard case .portInUse(let port, _) = harness.supervisor.lastError else {
      Issue.record("expected a port conflict, got \(String(describing: harness.supervisor.lastError))")
      return
    }
    #expect(port == 7444)
  }

  @Test func aDaemonThatRejectsOurTokenIsReported() async throws {
    let harness = SupervisorHarness()
    harness.machine.listener = .daemon(token: "theirs")
    harness.files.write("ours\n", to: harness.configuration.tokenFile.path)

    #expect(await harness.supervisor.start() == nil)

    guard case .tokenRejected(let port, let tokenFile) = harness.supervisor.lastError else {
      Issue.record("expected tokenRejected")
      return
    }
    #expect(port == 7444)
    #expect(tokenFile == "~/.daily-do-list/daemon-token")
    #expect(harness.machine.requests.isEmpty)
  }

  @Test func attachOnlyModeFailsWhenNothingRuns() async throws {
    let harness = SupervisorHarness(
      configuration: DaemonLaunchConfiguration(
        home: URL(fileURLWithPath: "/Users/me/.daily-do-list"), port: 7444, manageProcess: false))

    #expect(await harness.supervisor.start() == nil)

    #expect(harness.supervisor.lastError == .notRunning(port: 7444))
    #expect(harness.machine.requests.isEmpty)
  }

  @Test func missingNodeFailsClearly() async throws {
    let harness = SupervisorHarness()
    harness.files.removeExecutable(SupervisorHarness.nodePath)

    #expect(await harness.supervisor.start() == nil)

    let reason = try #require(harness.supervisor.state.failureReason)
    #expect(reason.contains("Node.js v24.4.0 or newer is required"))
    #expect(reason.contains("/opt/homebrew/bin/node"), "lists where it looked")
  }

  @Test func tooOldNodeFailsClearly() async throws {
    let harness = SupervisorHarness()
    harness.commands.setNodeVersion("v22.11.0", at: SupervisorHarness.nodePath)

    #expect(await harness.supervisor.start() == nil)

    #expect(harness.supervisor.lastError == .nodeUnsupported(found: ["v22.11.0 at /opt/homebrew/bin/node"]))
  }

  @Test func missingDaemonEntryFailsClearly() async throws {
    let harness = SupervisorHarness()
    harness.files.remove(SupervisorHarness.bundledEntry)

    #expect(await harness.supervisor.start() == nil)

    let reason = try #require(harness.supervisor.state.failureReason)
    #expect(reason.contains("The daemon (dist/main.js) was not found"))
    #expect(reason.contains("pnpm --filter @ddl/daemon build"))
  }

  // MARK: Supervision

  @Test func unexpectedExitRestartsAfterABackoff() async throws {
    let harness = SupervisorHarness()
    _ = try #require(await harness.supervisor.start())
    let first = try #require(harness.lastProcess)
    var states: [DaemonSupervisorState] = []
    let updates = harness.supervisor.stateUpdates()
    let collector = Task { @MainActor in
      for await state in updates {
        states.append(state)
        if states.count == 3 { break }
      }
    }

    first.crash(status: 1)

    #expect(await harness.waitUntil { harness.machine.processes.count == 2 && harness.supervisor.state.isRunning })
    await collector.value
    let second = try #require(harness.lastProcess)
    #expect(second.pid != first.pid)
    #expect(states.first?.pid == first.pid)
    #expect(states.dropFirst().first?.restartAttempt == 1)
    #expect(states.last?.pid == second.pid)
    #expect(harness.clock.sleeps.contains(.seconds(1)), "first backoff is 1 s")
    #expect(harness.supervisor.lastError == nil)
    #expect(await harness.waitUntil { harness.supervisor.logLines.contains("fatal: something broke") })
    #expect(harness.commands.calls.filter { $0.arguments == ["--version"] }.count == 1, "restarts reuse the resolved Node")
  }

  @Test func givesUpAfterFiveFailuresWithinTwoMinutes() async throws {
    let harness = SupervisorHarness()
    _ = try #require(await harness.supervisor.start())
    for index in 1...4 {
      harness.machine.script(.exits(status: 7, output: ["boom \(index)"]))
    }

    harness.lastProcess?.crash(status: 1)

    #expect(await harness.waitUntil { harness.supervisor.state.isFailed })
    let backoffs = harness.clock.sleeps.filter { $0 >= .seconds(1) }
    #expect(backoffs == [.seconds(1), .seconds(2), .seconds(4), .seconds(8)])
    #expect(harness.machine.requests.count == 5)
    guard case .gaveUp(_, let failures, let tail) = harness.supervisor.lastError else {
      Issue.record("expected gaveUp, got \(String(describing: harness.supervisor.lastError))")
      return
    }
    #expect(failures == 5)
    #expect(tail.contains("boom 4"))
    let reason = try #require(harness.supervisor.state.failureReason)
    #expect(reason.contains("Gave up restarting the daemon after 5 failures"))
    #expect(reason.contains("exited with status 7"))
    #expect(reason.contains("Last daemon output:\nboom 4"))
  }

  @Test func failuresOutsideTheWindowDontAccumulate() async throws {
    let harness = SupervisorHarness()
    _ = try #require(await harness.supervisor.start())

    for round in 1...6 {
      let process = try #require(harness.lastProcess)
      process.crash()
      #expect(await harness.waitUntil { harness.machine.processes.count == round + 1 && harness.supervisor.state.isRunning })
      harness.clock.advance(by: .seconds(121))
    }

    #expect(harness.clock.sleeps.filter { $0 >= .seconds(1) }.allSatisfy { $0 == .seconds(1) })
    #expect(harness.supervisor.state.isRunning)
  }

  @Test func anAttachedDaemonThatGoesAwayIsReplacedByAManagedOne() async throws {
    let harness = SupervisorHarness()
    harness.machine.runExternalDaemon(token: "ext")
    _ = try #require(await harness.supervisor.start())
    #expect(harness.supervisor.state.isAttached)

    harness.machine.listener = .nobody
    #expect(await harness.waitUntil { harness.clock.parkedCount == 1 })
    harness.clock.releaseParked()
    #expect(await harness.waitUntil { harness.clock.parkedCount == 1 })
    #expect(harness.supervisor.state.isAttached, "one missed check is tolerated")
    harness.clock.releaseParked()

    #expect(await harness.waitUntil { harness.supervisor.state.isRunning })
    #expect(harness.machine.requests.count == 1)
    #expect(harness.supervisor.state.connection?.token == "ext", "the new daemon reuses the token file")
  }

  @Test func attachedDaemonHealthUpdatesAreQuietWhenUnchanged() async throws {
    let harness = SupervisorHarness()
    harness.machine.runExternalDaemon()
    _ = try #require(await harness.supervisor.start())

    #expect(await harness.waitUntil { harness.clock.parkedCount == 1 })
    harness.clock.releaseParked()
    #expect(await harness.waitUntil { harness.clock.parkedCount == 1 })

    #expect(harness.supervisor.state.isAttached)
    #expect(harness.machine.healthChecks == 2)
  }

  // MARK: Stop & restart

  @Test func stopTerminatesTheManagedProcessOnce() async throws {
    let harness = SupervisorHarness()
    _ = try #require(await harness.supervisor.start())
    let process = try #require(harness.lastProcess)

    await harness.supervisor.stop()

    #expect(harness.supervisor.state == .stopped)
    #expect(process.signals == [SIGTERM], "a second SIGTERM would make the daemon skip its graceful shutdown")
    #expect(process.exitStatus == .signaled(signal: SIGTERM))
    try? await Task.sleep(for: .milliseconds(50))
    #expect(harness.machine.requests.count == 1, "a requested stop is not a crash")
    #expect(harness.supervisor.state == .stopped)
  }

  @Test func stopEscalatesToSIGKILLAfterTheGracePeriod() async throws {
    let harness = SupervisorHarness()
    harness.machine.script(.healthy(ignoresSIGTERM: true))
    _ = try #require(await harness.supervisor.start())
    let process = try #require(harness.lastProcess)

    await harness.supervisor.stop()

    #expect(process.signals == [SIGTERM, SIGKILL])
    #expect(harness.clock.sleeps.contains(.seconds(5)))
    #expect(harness.supervisor.state == .stopped)
    #expect(harness.supervisor.logLines.contains { $0.contains("sending SIGKILL") })
  }

  @Test func stopNeverStopsAnAttachedDaemon() async throws {
    let harness = SupervisorHarness()
    harness.machine.runExternalDaemon()
    _ = try #require(await harness.supervisor.start())

    await harness.supervisor.stop()

    #expect(harness.supervisor.state == .stopped)
    #expect(harness.machine.listener == .daemon(token: "external-token"))
    #expect(harness.clock.parkedCount == 0, "the health watch ended")
  }

  @Test func stopDuringStartupCancelsTheLaunch() async throws {
    let harness = SupervisorHarness(
      timing: DaemonSupervisorTiming(pollInterval: .seconds(90), attachedCheckInterval: .seconds(300)))
    harness.machine.script(.neverHealthy)
    let start = Task { await harness.supervisor.start() }
    #expect(await harness.waitUntil { harness.clock.parkedCount == 1 })
    let process = try #require(harness.lastProcess)

    await harness.supervisor.stop()

    #expect(await start.value == nil)
    #expect(harness.supervisor.state == .stopped)
    #expect(process.signals == [SIGTERM])
  }

  @Test func stopDuringBackoffCancelsTheRestart() async throws {
    let harness = SupervisorHarness(
      restartPolicy: DaemonRestartPolicy(initialDelay: .seconds(100), maxDelay: .seconds(100)))
    _ = try #require(await harness.supervisor.start())
    harness.lastProcess?.crash()
    #expect(await harness.waitUntil { harness.supervisor.state.restartAttempt == 1 && harness.clock.parkedCount == 1 })

    await harness.supervisor.stop()

    #expect(harness.supervisor.state == .stopped)
    #expect(harness.clock.parkedCount == 0)
    #expect(harness.machine.requests.count == 1)
  }

  @Test func startDuringBackoffRetriesImmediately() async throws {
    let harness = SupervisorHarness(
      restartPolicy: DaemonRestartPolicy(initialDelay: .seconds(100), maxDelay: .seconds(100)))
    _ = try #require(await harness.supervisor.start())
    harness.lastProcess?.crash()
    #expect(await harness.waitUntil { harness.clock.parkedCount == 1 })

    let connection = await harness.supervisor.start()

    #expect(connection != nil)
    #expect(harness.supervisor.state.isRunning)
    #expect(harness.machine.requests.count == 2)
  }

  @Test func restartRelaunchesTheManagedDaemon() async throws {
    let harness = SupervisorHarness()
    _ = try #require(await harness.supervisor.start())
    let first = try #require(harness.lastProcess)

    let connection = await harness.supervisor.restart()

    let second = try #require(harness.lastProcess)
    #expect(first.signals == [SIGTERM])
    #expect(second.pid != first.pid)
    #expect(harness.supervisor.state == .running(pid: second.pid, connection: connection!))
    #expect(connection?.token == "token-\(first.pid)", "the token file survives restarts")
  }

  @Test func restartReattachesToAnAttachedDaemon() async throws {
    let harness = SupervisorHarness()
    harness.machine.runExternalDaemon()
    _ = try #require(await harness.supervisor.start())

    await harness.supervisor.restart()

    #expect(harness.supervisor.state.isAttached)
    #expect(harness.machine.requests.isEmpty)
  }

  @Test func terminateForAppExitSignalsWithoutWaiting() async throws {
    let harness = SupervisorHarness()
    harness.machine.script(.healthy(ignoresSIGTERM: true))
    _ = try #require(await harness.supervisor.start())
    let process = try #require(harness.lastProcess)

    harness.supervisor.terminateForAppExit()

    #expect(process.signals == [SIGTERM])
    #expect(harness.supervisor.state == .stopped)
  }

  @Test func startAfterAFailureTriesAgain() async throws {
    let harness = SupervisorHarness()
    harness.machine.script(.exits(status: 1, output: ["nope"]))
    #expect(await harness.supervisor.start() == nil)

    let connection = await harness.supervisor.start()

    #expect(connection != nil)
    #expect(harness.supervisor.lastError == nil)
    #expect(harness.supervisor.state.isRunning)
  }

  // MARK: Observation & logs

  @Test func stateUpdatesStartWithTheCurrentState() async throws {
    let harness = SupervisorHarness()
    var iterator = harness.supervisor.stateUpdates().makeAsyncIterator()
    #expect(await iterator.next() == .idle)

    _ = await harness.supervisor.start()

    #expect(await iterator.next() == .starting)
    #expect(await iterator.next()?.isRunning == true)
  }

  @Test func logLinesKeepTheLastThousand() async throws {
    let harness = SupervisorHarness()
    _ = try #require(await harness.supervisor.start())
    let process = try #require(harness.lastProcess)

    process.emit((1...1_500).map { "line \($0)" })

    #expect(await harness.waitUntil { harness.supervisor.logLines.last == "line 1500" })
    #expect(harness.supervisor.logLines.count == DaemonSupervisor.logCapacity)
    #expect(harness.supervisor.logLines.first == "line 501")
    harness.supervisor.clearLogs()
    #expect(harness.supervisor.logLines.isEmpty)
  }
}
