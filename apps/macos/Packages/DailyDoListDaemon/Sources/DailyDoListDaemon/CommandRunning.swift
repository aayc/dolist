import Foundation

/// Outcome of a short helper command (`node --version`, the login-shell probe).
public struct CommandResult: Hashable, Sendable {
  /// Exit status; -1 when the command could not be launched or was killed after the timeout.
  public var status: Int32
  public var standardOutput: String
  public var standardError: String
  public var timedOut: Bool

  public init(status: Int32, standardOutput: String, standardError: String = "", timedOut: Bool = false) {
    self.status = status
    self.standardOutput = standardOutput
    self.standardError = standardError
    self.timedOut = timedOut
  }

  public var succeeded: Bool { status == 0 && !timedOut }
}

/// Runs short helper commands with a timeout, injectable for tests.
public protocol CommandRunning: Sendable {
  /// `environment` nil = inherit this process's environment. Never throws: launch failures and
  /// timeouts are reported in the result.
  func run(
    _ executable: URL, arguments: [String], environment: [String: String]?, timeout: Duration
  ) async -> CommandResult
}

/// Runs commands with `Foundation.Process`: stdin is `/dev/null`, output is collected until the
/// process exits (not until EOF, which a background grandchild could hold open forever), and a
/// command that outlives its timeout gets SIGTERM, then SIGKILL.
public struct ProcessCommandRunner: CommandRunning {
  public init() {}

  public func run(
    _ executable: URL, arguments: [String], environment: [String: String]?, timeout: Duration
  ) async -> CommandResult {
    let process = Process()
    process.executableURL = executable
    process.arguments = arguments
    if let environment { process.environment = environment }
    process.standardInput = FileHandle.nullDevice
    let stdout = OutputAccumulator()
    let stderr = OutputAccumulator()
    process.standardOutput = stdout.pipe
    process.standardError = stderr.pipe
    let exit = OneShot<Int32>()
    process.terminationHandler = { exit.fulfill($0.terminationStatus) }
    do {
      try process.run()
    } catch {
      stdout.close()
      stderr.close()
      return CommandResult(status: -1, standardOutput: "", standardError: "\(error.localizedDescription)")
    }
    let clock = SystemDaemonClock()
    var status = await exit.wait(timeout: timeout, clock: clock)
    let timedOut = status == nil
    if timedOut {
      process.terminate()
      status = await exit.wait(timeout: .seconds(1), clock: clock)
      if status == nil {
        kill(process.processIdentifier, SIGKILL)
        _ = await exit.wait(timeout: .seconds(1), clock: clock)
      }
    }
    // Output written just before exit may still be in flight.
    try? await Task.sleep(for: .milliseconds(20))
    return CommandResult(
      status: timedOut ? -1 : (status ?? -1),
      standardOutput: stdout.close(),
      standardError: stderr.close(),
      timedOut: timedOut
    )
  }
}

/// Collects everything written to a pipe (capped) without blocking on EOF.
private final class OutputAccumulator: @unchecked Sendable {
  let pipe = Pipe()
  private let lock = NSLock()
  private var data = Data()
  private static let limit = 256 * 1024

  init() {
    pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let chunk = handle.availableData
      // At EOF the handle stays "readable": always detach, or this handler would spin.
      guard let self, !chunk.isEmpty else {
        handle.readabilityHandler = nil
        return
      }
      lock.withLock {
        if data.count < Self.limit { data.append(chunk.prefix(Self.limit - data.count)) }
      }
    }
  }

  /// Stops reading and returns what arrived, decoded as UTF-8. (The descriptor closes when the
  /// pipe is released; closing it here could race a handler that is still reading.)
  @discardableResult
  func close() -> String {
    pipe.fileHandleForReading.readabilityHandler = nil
    return lock.withLock { String(decoding: data, as: UTF8.self) }
  }
}
