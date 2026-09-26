import DailyDoListModels
import Foundation

@testable import DailyDoListDaemon

/// A clock whose sleeps finish instantly (advancing time), except sleeps of at least
/// `parkingThreshold`, which wait for `releaseParked()` — so polling loops with long intervals
/// (the attached-daemon health watch) don't spin, and tests decide when they tick.
final class FakeClock: DaemonClock, @unchecked Sendable {
  private let lock = NSLock()
  private let origin = ContinuousClock.now
  private var elapsed: Duration = .zero
  private var recorded: [Duration] = []
  private var parked: [UUID: (Duration, CheckedContinuation<Bool, Never>)] = [:]
  let parkingThreshold: Duration

  init(parkingThreshold: Duration = .seconds(60)) {
    self.parkingThreshold = parkingThreshold
  }

  var now: ContinuousClock.Instant { lock.withLock { origin + elapsed } }
  var sleeps: [Duration] { lock.withLock { recorded } }
  var parkedCount: Int { lock.withLock { parked.count } }
  var elapsedTime: Duration { lock.withLock { elapsed } }

  func advance(by duration: Duration) {
    lock.withLock { elapsed += duration }
  }

  func sleep(for duration: Duration) async throws {
    try Task.checkCancellation()
    lock.withLock { recorded.append(duration) }
    if duration >= parkingThreshold {
      let id = UUID()
      let released = await withTaskCancellationHandler {
        await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
          lock.lock()
          if Task.isCancelled {
            lock.unlock()
            continuation.resume(returning: false)
          } else {
            parked[id] = (duration, continuation)
            lock.unlock()
          }
        }
      } onCancel: {
        let entry = lock.withLock { parked.removeValue(forKey: id) }
        entry?.1.resume(returning: false)
      }
      guard released else { throw CancellationError() }
    } else {
      lock.withLock { elapsed += duration }
      await Task.yield()
    }
    try Task.checkCancellation()
  }

  /// Finishes every parked sleep (advancing time by the longest one).
  func releaseParked() {
    let entries: [(Duration, CheckedContinuation<Bool, Never>)] = lock.withLock {
      let entries = Array(parked.values)
      parked.removeAll()
      if let longest = entries.map(\.0).max() { elapsed += longest }
      return entries
    }
    for (_, continuation) in entries { continuation.resume(returning: true) }
  }
}

/// In-memory files plus a set of executable paths.
final class FakeFileSystem: DaemonFileSystem, @unchecked Sendable {
  private let lock = NSLock()
  private var files: [String: String] = [:]
  private var executables: Set<String> = []
  private var directories: [String: [String]] = [:]

  func write(_ contents: String, to path: String) { lock.withLock { files[path] = contents } }
  func remove(_ path: String) { lock.withLock { files[path] = nil } }
  func addExecutable(_ path: String) { _ = lock.withLock { executables.insert(path) } }
  func removeExecutable(_ path: String) { _ = lock.withLock { executables.remove(path) } }
  func addFile(_ path: String) { write("", to: path) }
  func setDirectory(_ path: String, entries: [String]) {
    lock.withLock { directories[path] = entries }
  }

  func readString(at url: URL) -> String? { lock.withLock { files[url.path] } }
  func fileExists(at url: URL) -> Bool {
    lock.withLock { files[url.path] != nil || executables.contains(url.path) }
  }
  func isExecutableFile(at url: URL) -> Bool { lock.withLock { executables.contains(url.path) } }
  func contentsOfDirectory(at url: URL) -> [String] {
    lock.withLock { directories[url.path] ?? [] }
  }

  private var fingerprints = false
  private var revisions: [String: Int] = [:]

  /// Opts in to `fingerprint(of:)`, which enables the Node location cache (off by default).
  func enableFingerprints() { lock.withLock { fingerprints = true } }
  /// Simulates replacing a file, which changes its fingerprint.
  func replace(_ path: String) { lock.withLock { revisions[path, default: 0] += 1 } }
  func writeString(_ string: String, to url: URL) { write(string, to: url.path) }
  func fingerprint(of url: URL) -> String? {
    lock.withLock {
      guard fingerprints, files[url.path] != nil || executables.contains(url.path) else {
        return nil
      }
      return "\(url.path)#\(revisions[url.path] ?? 0)"
    }
  }
}

/// Canned results per executable path (`node --version`) and for the login shell.
final class FakeCommandRunner: CommandRunning, @unchecked Sendable {
  struct Call: Hashable {
    var executable: String
    var arguments: [String]
  }

  private let lock = NSLock()
  private var results: [String: CommandResult] = [:]
  private var recorded: [Call] = []

  var calls: [Call] { lock.withLock { recorded } }

  func setResult(_ result: CommandResult, for executable: String) {
    lock.withLock { results[executable] = result }
  }

  /// Makes `path` answer `node --version` with `version`.
  func setNodeVersion(_ version: String, at path: String) {
    setResult(CommandResult(status: 0, standardOutput: "\(version)\n"), for: path)
  }

  func setLoginShellOutput(_ output: String, timedOut: Bool = false) {
    setResult(
      CommandResult(status: timedOut ? -1 : 0, standardOutput: output, timedOut: timedOut),
      for: "/bin/zsh")
  }

  func run(
    _ executable: URL, arguments: [String], environment: [String: String]?, timeout: Duration
  ) async -> CommandResult {
    lock.withLock {
      recorded.append(Call(executable: executable.path, arguments: arguments))
      return results[executable.path]
        ?? CommandResult(status: 127, standardOutput: "", standardError: "not found")
    }
  }
}

/// Who listens on the port, the token file, and the processes launched so far.
final class FakeMachine: @unchecked Sendable {
  enum Listener: Equatable {
    case nobody
    case daemon(token: String)
    case foreign(String)
  }

  private struct Pending {
    var pid: Int32
    var remainingChecks: Int
    var token: String
    var writesTokenOnListen: Bool
  }

  let files = FakeFileSystem()
  let tokenPath: String
  let health = DaemonHealth(version: "9.9.9", apiVersion: 1, vaultName: "Fake", agentMode: "mock")
  private let lock = NSLock()
  private var currentListener: Listener = .nobody
  private var listeningPid: Int32?
  private var pending: Pending?
  private var nextPid: Int32 = 1_000
  private var processList: [FakeProcess] = []
  private var requestList: [DaemonLaunchRequest] = []
  private var scripted: [FakeProcess.Behavior] = []
  private var checks = 0

  init(tokenPath: String) {
    self.tokenPath = tokenPath
  }

  var listener: Listener {
    get { lock.withLock { currentListener } }
    set {
      lock.withLock {
        currentListener = newValue
        listeningPid = nil
      }
    }
  }
  var processes: [FakeProcess] { lock.withLock { processList } }
  var requests: [DaemonLaunchRequest] { lock.withLock { requestList } }
  var healthChecks: Int { lock.withLock { checks } }

  /// Behaviors of the next launches, in order (then `.healthy()`).
  func script(_ behaviors: FakeProcess.Behavior...) {
    lock.withLock { scripted.append(contentsOf: behaviors) }
  }

  /// A daemon that is already running with `token` (and wrote its token file).
  func runExternalDaemon(token: String = "external-token") {
    files.write("\(token)\n", to: tokenPath)
    listener = .daemon(token: token)
  }

  func launch(_ request: DaemonLaunchRequest) -> FakeProcess {
    let (process, behavior): (FakeProcess, FakeProcess.Behavior) = lock.withLock {
      nextPid += 1
      let behavior = scripted.isEmpty ? .healthy() : scripted.removeFirst()
      let process = FakeProcess(pid: nextPid, behavior: behavior, machine: self)
      processList.append(process)
      requestList.append(request)
      return (process, behavior)
    }
    process.start(behavior)
    return process
  }

  /// Like the real daemon: reuse a valid token file or create one, then listen after `checks`
  /// health checks. A rotated token only lands in the file when it starts listening.
  func willListen(_ process: FakeProcess, afterChecks checks: Int, rotatesToken: Bool) {
    let existing = files.readString(at: URL(fileURLWithPath: tokenPath))?.trimmedNonEmpty
    let token = rotatesToken ? "rotated-\(process.pid)" : (existing ?? "token-\(process.pid)")
    if !rotatesToken { files.write("\(token)\n", to: tokenPath) }
    let listensNow: Bool = lock.withLock {
      guard checks > 0 else {
        currentListener = .daemon(token: token)
        listeningPid = process.pid
        return true
      }
      pending = Pending(
        pid: process.pid, remainingChecks: checks, token: token, writesTokenOnListen: rotatesToken)
      return false
    }
    if listensNow && rotatesToken { files.write("\(token)\n", to: tokenPath) }
  }

  func processDidExit(_ process: FakeProcess) {
    lock.withLock {
      if pending?.pid == process.pid { pending = nil }
      if listeningPid == process.pid {
        currentListener = .nobody
        listeningPid = nil
      }
    }
  }

  func check(token: String?) -> DaemonHealthResult {
    var tokenToWrite: String?
    let result: DaemonHealthResult = lock.withLock {
      checks += 1
      if var next = pending {
        next.remainingChecks -= 1
        if next.remainingChecks <= 0 {
          currentListener = .daemon(token: next.token)
          listeningPid = next.pid
          pending = nil
          if next.writesTokenOnListen { tokenToWrite = next.token }
        } else {
          pending = next
        }
      }
      switch currentListener {
      case .nobody: return .unreachable("Could not connect to the server.")
      case .foreign(let detail): return .foreign(detail)
      case .daemon(let expected): return token == expected ? .healthy(health) : .unauthorized
      }
    }
    if let tokenToWrite { files.write("\(tokenToWrite)\n", to: tokenPath) }
    return result
  }
}

final class FakeProcess: DaemonProcessHandle, @unchecked Sendable {
  enum Behavior {
    /// Answers health checks after `afterChecks` of them; `rotatesToken` replaces the token file.
    case healthy(
      afterChecks: Int = 0, rotatesToken: Bool = false, output: [String] = ["listening"],
      ignoresSIGTERM: Bool = false)
    /// Prints `output` and exits right away.
    case exits(status: Int32, output: [String])
    /// Runs, but never answers.
    case neverHealthy
  }

  let pid: Int32
  let output: AsyncStream<[String]>
  private let continuation: AsyncStream<[String]>.Continuation
  private let exit = OneShot<DaemonProcessExit>()
  private let behavior: Behavior
  private weak var machine: FakeMachine?
  private let lock = NSLock()
  private var receivedSignals: [Int32] = []
  private var emitted: [String] = []

  init(pid: Int32, behavior: Behavior, machine: FakeMachine) {
    self.pid = pid
    self.behavior = behavior
    self.machine = machine
    let (stream, continuation) = AsyncStream.makeStream(of: [String].self)
    output = stream
    self.continuation = continuation
  }

  var signals: [Int32] { lock.withLock { receivedSignals } }
  var exitStatus: DaemonProcessExit? { exit.current }
  var recentOutput: [String] { lock.withLock { Array(emitted.suffix(50)) } }

  func start(_ behavior: Behavior) {
    switch behavior {
    case .healthy(let afterChecks, let rotatesToken, let output, _):
      emit(output)
      machine?.willListen(self, afterChecks: afterChecks, rotatesToken: rotatesToken)
    case .exits(let status, let output):
      emit(output)
      finish(.exited(status: status))
    case .neverHealthy:
      emit(["starting…"])
    }
  }

  func emit(_ lines: [String]) {
    guard !lines.isEmpty else { return }
    lock.withLock { emitted.append(contentsOf: lines) }
    continuation.yield(lines)
  }

  /// The process dies on its own.
  func crash(status: Int32 = 1, output: [String] = ["fatal: something broke"]) {
    emit(output)
    finish(.exited(status: status))
  }

  func waitForExit() async -> DaemonProcessExit? { await exit.wait() }

  func signal(_ signal: Int32) {
    lock.withLock { receivedSignals.append(signal) }
    guard exit.current == nil else { return }
    if signal == SIGTERM, case .healthy(_, _, _, true) = behavior { return }
    finish(.signaled(signal: signal))
  }

  private func finish(_ status: DaemonProcessExit) {
    guard exit.current == nil else { return }
    machine?.processDidExit(self)
    exit.fulfill(status)
    continuation.finish()
  }
}

struct FakeLauncher: DaemonProcessLaunching {
  let machine: FakeMachine
  func launch(_ request: DaemonLaunchRequest) throws -> any DaemonProcessHandle {
    machine.launch(request)
  }
}

struct FakeHealthChecker: DaemonHealthChecking {
  let machine: FakeMachine
  func check(baseURL: URL, token: String?) async -> DaemonHealthResult {
    machine.check(token: token)
  }
}
