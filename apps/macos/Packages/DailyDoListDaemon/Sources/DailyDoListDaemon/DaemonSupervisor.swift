import DailyDoListModels
import Foundation
import Observation

/// Starts, supervises and stops the local Node daemon, or attaches to one that is already running.
///
/// - `start()` attaches first: when `GET /api/health` accepts the token in
///   `$DDL_HOME/daemon-token`, that daemon is used as is (`.attached`) and this supervisor never
///   stops it. Otherwise, with `manageProcess`, it launches `node <entry>` (see `NodeLocator` and
///   `DaemonEntryLocator`) and waits for the token file and a healthy health check (`.running`).
///   A port held by something else fails with a message that says so.
/// - A managed daemon that exits unexpectedly, or an attached one that stops answering, is
///   brought back with exponential backoff (`.restarting`) until the `DaemonRestartPolicy` gives
///   up (`.failed`, with the daemon's last output). A managed daemon that exits with
///   `restartExitStatus` asked to be started again (to open another vault): it's relaunched at
///   once (`.starting`), and that doesn't count as a failure.
/// - `stop()` sends SIGTERM to the managed daemon's process group, then SIGKILL after a grace
///   period. `restart()` is `stop()` + `start()`.
///
/// Changes to `configuration` apply on the next `start()`/`restart()`.
@MainActor
@Observable
public final class DaemonSupervisor {
  public private(set) var state: DaemonSupervisorState = .idle
  /// Recent daemon stdout/stderr lines (ring buffer), for the app's daemon log view. Lines from
  /// the supervisor itself start with `[supervisor]`.
  public private(set) var logLines: [String] = []
  /// Typed form of the latest `.failed` reason; nil while a daemon is ready.
  public private(set) var lastError: DaemonSupervisorError?
  /// The daemon's last successful health answer (version, API version, vault, agent mode).
  public private(set) var health: DaemonHealth?
  /// The Node binary of the current (or last) managed launch.
  public private(set) var resolvedNode: ResolvedNode?
  /// The daemon entry of the current (or last) managed launch.
  public private(set) var resolvedEntry: ResolvedDaemonEntry?
  public var configuration: DaemonLaunchConfiguration

  public let dependencies: DaemonSupervisorDependencies

  /// Capacity of `logLines`.
  public static let logCapacity = 1_000
  /// The daemon's `RESTART_EXIT_CODE` (`EX_TEMPFAIL`): it exits with it to be started again.
  public static let restartExitStatus: Int32 = 75
  /// Daemon lines included in failure messages.
  static let failureTailLength = 12

  @ObservationIgnored private var logBuffer = LogRingBuffer(capacity: DaemonSupervisor.logCapacity)
  /// The managed process we own (nil when attached, stopped or between restarts).
  @ObservationIgnored private var process: (any DaemonProcessHandle)?
  /// The most recently launched process, for its last output in failure messages.
  @ObservationIgnored private var lastLaunched: (any DaemonProcessHandle)?
  /// Bumped by every `start()`/`stop()`: async work of an older generation discards its results.
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var startTask: Task<DaemonConnectionInfo?, Never>?
  @ObservationIgnored private var stopTask: Task<Void, Never>?
  /// Restart backoff, or the health watch of an attached daemon.
  @ObservationIgnored private var watchTask: Task<Void, Never>?
  @ObservationIgnored private var failures = FailureHistory()
  @ObservationIgnored private var stateObservers:
    [UUID: AsyncStream<DaemonSupervisorState>.Continuation] = [:]

  public init(
    configuration: DaemonLaunchConfiguration = .standard(),
    dependencies: DaemonSupervisorDependencies = .live
  ) {
    self.configuration = configuration
    self.dependencies = dependencies
  }

  // MARK: - Public API

  /// Attaches to a running daemon, or launches one when `manageProcess` is set. Returns the
  /// connection once the daemon answers health checks, nil on failure (see `state`/`lastError`).
  /// Returns the current connection when already running; while `.restarting`, retries now.
  @discardableResult
  public func start() async -> DaemonConnectionInfo? {
    if let stopTask { await stopTask.value }
    if let connection = state.connection { return connection }
    if let startTask { return await startTask.value }
    watchTask?.cancel()
    watchTask = nil
    failures.reset()
    generation += 1
    let gen = generation
    let task = Task { await self.startUp(gen) }
    startTask = task
    let connection = await task.value
    if generation == gen { startTask = nil }
    return connection
  }

  /// Stops a daemon we launched (SIGTERM to its process group, SIGKILL after the grace period).
  /// An attached daemon keeps running; the supervisor just lets go of it.
  public func stop() async {
    generation += 1
    let gen = generation
    startTask?.cancel()
    startTask = nil
    watchTask?.cancel()
    watchTask = nil
    failures.reset()
    let handle = process
    process = nil
    let previous = stopTask
    let task = Task {
      await previous?.value
      if let handle {
        self.log("Stopping the daemon (pid \(handle.pid))")
        await self.terminate(handle)
      }
      if self.generation == gen { self.setState(.stopped) }
    }
    stopTask = task
    await task.value
    if generation == gen { stopTask = nil }
  }

  /// `stop()`, then `start()`.
  @discardableResult
  public func restart() async -> DaemonConnectionInfo? {
    await stop()
    return await start()
  }

  /// Synchronous last resort for app termination: SIGTERM to a managed daemon without waiting
  /// (it finishes shutting down on its own). Prefer `await stop()` from
  /// `applicationShouldTerminate(_:)` returning `.terminateLater`.
  public func terminateForAppExit() {
    generation += 1
    startTask?.cancel()
    startTask = nil
    watchTask?.cancel()
    watchTask = nil
    if let handle = process {
      process = nil
      handle.signal(SIGTERM)
    }
    setState(.stopped)
  }

  /// Every state change, starting with the current state. Finishes when the consumer stops
  /// iterating.
  public func stateUpdates() -> AsyncStream<DaemonSupervisorState> {
    let (stream, continuation) = AsyncStream.makeStream(
      of: DaemonSupervisorState.self, bufferingPolicy: .bufferingNewest(32))
    let id = UUID()
    stateObservers[id] = continuation
    continuation.onTermination = { [weak self] _ in
      Task { @MainActor in self?.stateObservers[id] = nil }
    }
    continuation.yield(state)
    return stream
  }

  /// Empties `logLines`.
  public func clearLogs() {
    logBuffer.removeAll()
    logLines = []
  }

  // MARK: - Acquiring a daemon

  private enum Acquisition {
    case attached(DaemonConnectionInfo, DaemonHealth)
    case launched(any DaemonProcessHandle, DaemonConnectionInfo, DaemonHealth)
    case failed(DaemonSupervisorError)
    case cancelled
  }

  private func startUp(_ gen: Int) async -> DaemonConnectionInfo? {
    setState(.starting)
    let outcome = await acquire(gen, reuseResolvedNode: false)
    guard isCurrent(gen) else { return nil }
    return settle(outcome, gen)
  }

  /// Applies a successful or failed acquisition; returns the connection on success.
  private func settle(_ outcome: Acquisition, _ gen: Int) -> DaemonConnectionInfo? {
    switch outcome {
    case .attached(let connection, let health):
      ready(health)
      log("Attached to the daemon at \(connection.baseURL.absoluteString) (v\(health.version))")
      setState(.attached(connection: connection))
      watchAttached(connection, gen)
      return connection
    case .launched(let handle, let connection, let health):
      ready(health)
      log("The daemon (pid \(handle.pid)) is ready at \(connection.baseURL.absoluteString)")
      setState(.running(pid: handle.pid, connection: connection))
      // An exit noticed while still starting was ignored by the exit watcher.
      if let exit = handle.exitStatus { processExited(handle, exit) }
      return state.connection
    case .failed(let error):
      fail(error)
      return nil
    case .cancelled:
      return nil
    }
  }

  /// Attach if a daemon answers with our token; otherwise launch one (when managing).
  private func acquire(_ gen: Int, reuseResolvedNode: Bool) async -> Acquisition {
    let configuration = configuration
    switch await probe(configuration) {
    case .some(let outcome): return outcome
    case .none: break
    }
    guard isCurrent(gen) else { return .cancelled }
    guard configuration.manageProcess else { return .failed(.notRunning(port: configuration.port)) }
    return await launch(configuration, gen, reuseResolvedNode: reuseResolvedNode)
  }

  /// Who answers on the port: nil when nobody does (free to launch).
  private func probe(_ configuration: DaemonLaunchConfiguration) async -> Acquisition? {
    BootTrace.mark("supervisor: probing port \(configuration.port)")
    let token = readToken(configuration)
    switch await dependencies.healthChecker.check(baseURL: configuration.baseURL, token: token) {
    case .healthy(let health):
      guard let token else {
        return .failed(.portInUse(port: configuration.port, detail: "it answered without a token"))
      }
      return .attached(DaemonConnectionInfo(baseURL: configuration.baseURL, token: token), health)
    case .unauthorized:
      return .failed(
        .tokenRejected(port: configuration.port, tokenFile: display(configuration.tokenFile.path)))
    case .foreign(let detail):
      return .failed(.portInUse(port: configuration.port, detail: detail))
    case .unreachable:
      return nil
    }
  }

  private func launch(
    _ configuration: DaemonLaunchConfiguration, _ gen: Int, reuseResolvedNode: Bool
  ) async -> Acquisition {
    let host = dependencies.host
    let locator = NodeLocator(
      configuredPath: configuration.nodePath, environment: host.variables,
      homeDirectory: host.homeDirectory, fileSystem: dependencies.fileSystem,
      commands: dependencies.commands)
    let nodeCache = NodeLocationCache(
      file: configuration.home.appendingPathComponent("node-location.json"),
      fileSystem: dependencies.fileSystem)
    let nodeCacheKey = NodeLocationCache.key(
      configuredPath: configuration.nodePath, environment: host.variables)
    let node: ResolvedNode
    var nodeFromCache = false
    if reuseResolvedNode, let cached = resolvedNode,
      dependencies.fileSystem.isExecutableFile(at: cached.url)
    {
      node = cached
    } else if let remembered = nodeCache.load(key: nodeCacheKey) {
      node = remembered
      nodeFromCache = true
      resolvedNode = node
    } else {
      do {
        node = try await locator.locate()
      } catch {
        return .failed(error)
      }
      guard isCurrent(gen) else { return .cancelled }
      resolvedNode = node
    }
    BootTrace.mark("supervisor: node \(node.version) from \(node.source.rawValue)")

    let entry: ResolvedDaemonEntry
    do {
      entry = try DaemonEntryLocator(
        configuredEntry: configuration.daemonEntry, environment: host.variables,
        bundleResourceURL: host.bundleResourceURL, executableURL: host.executableURL,
        currentDirectory: host.currentDirectory, homeDirectory: host.homeDirectory,
        fileSystem: dependencies.fileSystem
      ).locate()
    } catch {
      return .failed(error)
    }
    resolvedEntry = entry

    let request = DaemonLaunchRequest(
      executable: node.url,
      arguments: DaemonProcessEnvironment.arguments(
        entry: entry.entry, stopsWhenAppExits: configuration.stopsWhenAppExits),
      environment: DaemonProcessEnvironment.variables(
        base: host.variables, configuration: configuration, node: node),
      workingDirectory: entry.packageDirectory,
      keepsStandardInputOpen: configuration.stopsWhenAppExits)
    let handle: any DaemonProcessHandle
    do {
      handle = try dependencies.launcher.launch(request)
    } catch {
      return .failed(.launchFailed(error.localizedDescription))
    }
    process = handle
    lastLaunched = handle
    log(
      "Launched \(display(node.url.path)) (\(node.version), from \(node.source.rawValue)) "
        + "with \(display(entry.entry.path)) (from \(entry.source.rawValue)) as pid \(handle.pid), "
        + "port \(configuration.port)")
    pumpOutput(of: handle)
    watchExit(of: handle)
    BootTrace.mark("supervisor: spawned pid \(handle.pid)")
    let outcome = await awaitHealthy(handle, configuration, gen)
    switch outcome {
    case .launched:
      // Saved once the daemon has created its home; a cached answer is re-checked off the
      // launch path, so a new Node or PATH is picked up next time.
      if nodeFromCache {
        refreshNodeLocation(locator, nodeCache, key: nodeCacheKey, current: node)
      } else {
        nodeCache.save(node, key: nodeCacheKey)
      }
    case .failed where nodeFromCache:
      nodeCache.clear()
    default:
      break
    }
    return outcome
  }

  private func refreshNodeLocation(
    _ locator: NodeLocator, _ cache: NodeLocationCache, key: String, current: ResolvedNode
  ) {
    Task {
      guard let fresh = try? await locator.locate(), fresh != current else { return }
      cache.save(fresh, key: key)
    }
  }

  /// Polls for the token file and a healthy answer until the startup timeout.
  private func awaitHealthy(
    _ handle: any DaemonProcessHandle, _ configuration: DaemonLaunchConfiguration, _ gen: Int
  ) async -> Acquisition {
    let clock = dependencies.clock
    let timing = dependencies.timing
    let deadline = clock.now + timing.startupTimeout
    while true {
      guard isCurrent(gen) else {
        await abandon(handle)
        return .cancelled
      }
      if let exit = handle.exitStatus {
        return await startupExit(exit, handle, configuration, gen)
      }
      if let token = readToken(configuration),
        case .healthy(let health) = await dependencies.healthChecker.check(
          baseURL: configuration.baseURL, token: token),
        handle.exitStatus == nil
      {
        guard isCurrent(gen) else {
          await abandon(handle)
          return .cancelled
        }
        BootTrace.mark("supervisor: daemon healthy")
        return .launched(
          handle, DaemonConnectionInfo(baseURL: configuration.baseURL, token: token), health)
      }
      if clock.now >= deadline {
        log(
          "No healthy answer within \(timing.startupTimeout.wholeSeconds) s; stopping pid \(handle.pid)"
        )
        await abandon(handle)
        return .failed(
          .startupTimedOut(seconds: timing.startupTimeout.wholeSeconds, logTail: failureTail()))
      }
      try? await clock.sleep(for: timing.pollInterval)
    }
  }

  /// The launched process died before answering: explain a port conflict, else report its exit.
  private func startupExit(
    _ exit: DaemonProcessExit, _ handle: any DaemonProcessHandle,
    _ configuration: DaemonLaunchConfiguration, _ gen: Int
  ) async -> Acquisition {
    if process === handle { process = nil }
    // Its last words may still be in the pipe.
    try? await dependencies.clock.sleep(for: .milliseconds(200))
    guard isCurrent(gen) else { return .cancelled }
    let portTaken = handle.recentOutput.contains { line in
      line.localizedCaseInsensitiveContains("already in use")
        || line.localizedCaseInsensitiveContains("EADDRINUSE")
    }
    guard portTaken else {
      return .failed(.exitedDuringStartup(exit: exit.description, logTail: failureTail()))
    }
    // Someone else took the port first; it may be a daemon we can use after all.
    if let outcome = await probe(configuration) { return outcome }
    return .failed(
      .portInUse(
        port: configuration.port, detail: "the port was taken when the daemon tried to listen"))
  }

  // MARK: - Supervision

  private func watchExit(of handle: any DaemonProcessHandle) {
    Task { [weak self] in
      guard let exit = await handle.waitForExit() else { return }
      self?.processExited(handle, exit)
    }
  }

  private func processExited(_ handle: any DaemonProcessHandle, _ exit: DaemonProcessExit) {
    log("The daemon (pid \(handle.pid)) \(exit)")
    // Exits during startup and stop are handled by those flows.
    guard process === handle, case .running(let pid, _) = state, pid == handle.pid else { return }
    process = nil
    if exit == .exited(status: Self.restartExitStatus) {
      relaunch()
    } else {
      recover(reason: "The daemon \(exit).")
    }
  }

  /// Starts the daemon again right away, as it asked; only a failure to come back counts.
  private func relaunch() {
    let gen = generation
    log("The daemon asked to be started again (e.g. to open another vault)")
    setState(.starting)
    watchTask?.cancel()
    watchTask = Task { [weak self] in
      guard let self, isCurrent(gen) else { return }
      switch await acquire(gen, reuseResolvedNode: true) {
      case .cancelled:
        return
      case .failed(let error):
        guard isCurrent(gen) else { return }
        recover(reason: error.summary)
      case let outcome:
        guard isCurrent(gen) else { return }
        _ = settle(outcome, gen)
      }
    }
  }

  /// Health-checks an attached daemon (it isn't our child, so we can't watch it exit).
  private func watchAttached(_ connection: DaemonConnectionInfo, _ gen: Int) {
    watchTask?.cancel()
    let clock = dependencies.clock
    let checker = dependencies.healthChecker
    let timing = dependencies.timing
    watchTask = Task { [weak self] in
      var misses = 0
      while !Task.isCancelled {
        do { try await clock.sleep(for: timing.attachedCheckInterval) } catch { return }
        let result = await checker.check(baseURL: connection.baseURL, token: connection.token)
        guard let self, isCurrent(gen), case .attached = state else { return }
        if case .healthy(let health) = result {
          misses = 0
          if self.health != health { self.health = health }
          continue
        }
        misses += 1
        if misses >= timing.attachedMissesAllowed {
          recover(
            reason: "The daemon at \(connection.baseURL.absoluteString) stopped answering "
              + "(\(result.summary)).")
          return
        }
      }
    }
  }

  /// Counts a failure and retries after the backoff, or gives up.
  private func recover(reason: String) {
    let gen = generation
    let policy = dependencies.restartPolicy
    let clock = dependencies.clock
    let count = failures.record(at: clock.now, window: policy.window)
    guard count < policy.maxFailures else {
      fail(.gaveUp(reason: reason, failures: count, logTail: failureTail()))
      return
    }
    let delay = policy.delay(forAttempt: count)
    log("\(reason) Restarting in \(delay.formatted()) (attempt \(count))")
    setState(.restarting(attempt: count, reason: reason))
    watchTask?.cancel()
    watchTask = Task { [weak self] in
      do { try await clock.sleep(for: delay) } catch { return }
      guard let self, isCurrent(gen) else { return }
      switch await acquire(gen, reuseResolvedNode: true) {
      case .cancelled:
        return
      case .failed(let error):
        guard isCurrent(gen) else { return }
        recover(reason: error.summary)
      case let outcome:
        guard isCurrent(gen) else { return }
        _ = settle(outcome, gen)
      }
    }
  }

  private func ready(_ health: DaemonHealth) {
    self.health = health
    lastError = nil
  }

  private func fail(_ error: DaemonSupervisorError) {
    watchTask?.cancel()
    watchTask = nil
    if let handle = process {
      process = nil
      handle.signal(SIGTERM)
    }
    lastError = error
    log("Failed: \(error.summary)")
    setState(.failed(reason: error.message))
  }

  // MARK: - Processes

  /// Stops a process launched by a flow that no longer owns the supervisor.
  private func abandon(_ handle: any DaemonProcessHandle) async {
    guard process === handle else { return }
    process = nil
    await terminate(handle)
  }

  /// SIGTERM, then SIGKILL after the grace period.
  private func terminate(_ handle: any DaemonProcessHandle) async {
    guard handle.exitStatus == nil else { return }
    let timing = dependencies.timing
    handle.signal(SIGTERM)
    if await waitForExit(handle, timeout: timing.stopGracePeriod) != nil { return }
    log(
      "The daemon (pid \(handle.pid)) didn't stop within "
        + "\(timing.stopGracePeriod.formatted()); sending SIGKILL")
    handle.signal(SIGKILL)
    _ = await waitForExit(handle, timeout: timing.killTimeout)
  }

  private func waitForExit(_ handle: any DaemonProcessHandle, timeout: Duration) async
    -> DaemonProcessExit?
  {
    if let exit = handle.exitStatus { return exit }
    let clock = dependencies.clock
    let first = await withTaskGroup(of: DaemonProcessExit?.self) { group in
      group.addTask { await handle.waitForExit() }
      group.addTask {
        try? await clock.sleep(for: timeout)
        return nil
      }
      let first = await group.next() ?? nil
      group.cancelAll()
      return first
    }
    return first ?? handle.exitStatus
  }

  private func pumpOutput(of handle: any DaemonProcessHandle) {
    Task { [weak self] in
      for await lines in handle.output {
        guard let self else { return }
        logBuffer.append(contentsOf: lines)
        logLines = logBuffer.lines
      }
    }
  }

  // MARK: - Helpers

  private func isCurrent(_ gen: Int) -> Bool { gen == generation }

  private func setState(_ newState: DaemonSupervisorState) {
    guard state != newState else { return }
    state = newState
    for observer in stateObservers.values { observer.yield(newState) }
  }

  private func log(_ message: String) {
    logBuffer.append(contentsOf: ["[supervisor] \(message)"])
    logLines = logBuffer.lines
  }

  private func failureTail() -> [String] {
    Array((lastLaunched?.recentOutput ?? []).suffix(Self.failureTailLength))
  }

  private func readToken(_ configuration: DaemonLaunchConfiguration) -> String? {
    dependencies.fileSystem.readString(at: configuration.tokenFile)?.trimmedNonEmpty
  }

  private func display(_ path: String) -> String {
    DaemonHome.displayPath(path, homeDirectory: dependencies.host.homeDirectory.path)
  }
}

extension DaemonHealthResult {
  /// Short description for messages.
  var summary: String {
    switch self {
    case .healthy: "healthy"
    case .unauthorized: "it rejected the token"
    case .foreign(let detail): detail
    case .unreachable(let detail): detail
    }
  }
}
