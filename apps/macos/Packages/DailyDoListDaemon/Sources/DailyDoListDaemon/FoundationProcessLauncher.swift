import Foundation

/// Launches the daemon with `Foundation.Process`, which on macOS makes the child the leader of a
/// new process group, so stopping it can signal everything it started.
public struct FoundationProcessLauncher: DaemonProcessLaunching {
  public init() {}

  public func launch(_ request: DaemonLaunchRequest) throws -> any DaemonProcessHandle {
    try FoundationDaemonProcess(request: request)
  }
}

final class FoundationDaemonProcess: DaemonProcessHandle, @unchecked Sendable {
  let pid: Int32
  let output: AsyncStream<[String]>

  private let process: Process
  /// Held (never written) so the child's stdin stays open until this process goes away.
  private let standardInput: Pipe?
  private let collector: OutputCollector
  private let exit: OneShot<DaemonProcessExit>

  init(request: DaemonLaunchRequest) throws {
    let process = Process()
    process.executableURL = request.executable
    process.arguments = request.arguments
    process.environment = request.environment
    process.currentDirectoryURL = request.workingDirectory
    let standardInput = request.keepsStandardInputOpen ? Pipe() : nil
    process.standardInput = standardInput ?? FileHandle.nullDevice

    let (stream, continuation) = AsyncStream.makeStream(
      of: [String].self, bufferingPolicy: .bufferingNewest(512))
    let collector = OutputCollector(continuation: continuation)
    let stdout = Pipe()
    let stderr = Pipe()
    process.standardOutput = stdout
    process.standardError = stderr
    collector.read(stdout.fileHandleForReading)
    collector.read(stderr.fileHandleForReading)

    let exit = OneShot<DaemonProcessExit>()
    process.terminationHandler = { process in
      exit.fulfill(
        process.terminationReason == .uncaughtSignal
          ? .signaled(signal: process.terminationStatus)
          : .exited(status: process.terminationStatus))
      collector.processExited()
    }
    do {
      try process.run()
    } catch {
      collector.processExited()
      throw error
    }
    self.process = process
    self.standardInput = standardInput
    self.collector = collector
    self.exit = exit
    self.output = stream
    self.pid = process.processIdentifier
  }

  var exitStatus: DaemonProcessExit? { exit.current }
  var recentOutput: [String] { collector.recentLines }

  func waitForExit() async -> DaemonProcessExit? {
    await exit.wait()
  }

  /// Closes our end of the daemon's stdin, as the kernel does when this process dies (tests).
  func closeStandardInputForTesting() {
    try? standardInput?.fileHandleForWriting.close()
  }

  func signal(_ signal: Int32) {
    guard exit.current == nil else { return }
    // Exactly one delivery: the daemon treats a second SIGTERM as "exit immediately".
    if getpgid(pid) == pid {
      kill(-pid, signal)
    } else {
      kill(pid, signal)
    }
  }
}

/// Splits stdout and stderr into lines and forwards them as batches. The stream finishes when
/// both pipes reach EOF, or shortly after the process exits (a grandchild that inherited a pipe
/// could otherwise keep it open indefinitely).
private final class OutputCollector: @unchecked Sendable {
  private let lock = NSLock()
  private let continuation: AsyncStream<[String]>.Continuation
  private var splitters: [ObjectIdentifier: LineSplitter] = [:]
  private var handles: [FileHandle] = []
  private var tail = LogRingBuffer(capacity: 50)
  private var finished = false

  init(continuation: AsyncStream<[String]>.Continuation) {
    self.continuation = continuation
  }

  var recentLines: [String] { lock.withLock { tail.lines } }

  func read(_ handle: FileHandle) {
    let key = ObjectIdentifier(handle)
    lock.withLock {
      splitters[key] = LineSplitter()
      handles.append(handle)
    }
    handle.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      // At EOF the handle stays "readable": always detach, or this handler would spin.
      if data.isEmpty { handle.readabilityHandler = nil }
      guard let self else {
        handle.readabilityHandler = nil
        return
      }
      if data.isEmpty {
        endOfFile(key)
      } else {
        consume(data, key)
      }
    }
  }

  func processExited() {
    DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(500)) {
      self.finish()
    }
  }

  private func consume(_ data: Data, _ key: ObjectIdentifier) {
    let lines: [String] = lock.withLock {
      guard !finished else { return [] }
      let lines = splitters[key]?.append(data) ?? []
      tail.append(contentsOf: lines)
      return lines
    }
    if !lines.isEmpty { continuation.yield(lines) }
  }

  private func endOfFile(_ key: ObjectIdentifier) {
    let (lines, allDone): ([String], Bool) = lock.withLock {
      guard !finished, var splitter = splitters.removeValue(forKey: key) else { return ([], false) }
      let lines = splitter.flush()
      tail.append(contentsOf: lines)
      return (lines, splitters.isEmpty)
    }
    if !lines.isEmpty { continuation.yield(lines) }
    if allDone { finish() }
  }

  private func finish() {
    let (remaining, handles): ([String], [FileHandle]) = lock.withLock {
      guard !finished else { return ([], []) }
      finished = true
      var remaining: [String] = []
      for var splitter in splitters.values { remaining += splitter.flush() }
      splitters.removeAll()
      tail.append(contentsOf: remaining)
      return (remaining, self.handles)
    }
    for handle in handles { handle.readabilityHandler = nil }
    if !remaining.isEmpty { continuation.yield(remaining) }
    continuation.finish()
  }
}
