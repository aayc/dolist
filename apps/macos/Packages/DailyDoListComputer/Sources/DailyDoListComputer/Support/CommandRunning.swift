import Foundation

public struct CommandResult: Equatable, Sendable {
  public var status: Int32
  public var timedOut: Bool

  public init(status: Int32, timedOut: Bool = false) {
    self.status = status
    self.timedOut = timedOut
  }
}

/// Runs a program without a shell (the `screencapture` fallback).
public protocol CommandRunning: Sendable {
  func run(_ executable: URL, arguments: [String], timeout: Duration) async -> CommandResult
}

/// `Process`, with its output discarded and a timeout after which it's terminated.
public struct ProcessCommandRunner: CommandRunning {
  public init() {}

  public func run(_ executable: URL, arguments: [String], timeout: Duration) async -> CommandResult
  {
    let process = Process()
    process.executableURL = executable
    process.arguments = arguments
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
    } catch {
      return CommandResult(status: -1)
    }
    let deadline = ContinuousClock.now + timeout
    while process.isRunning {
      if ContinuousClock.now >= deadline {
        process.terminate()
        return CommandResult(status: -1, timedOut: true)
      }
      try? await Task.sleep(for: .milliseconds(20))
    }
    return CommandResult(status: process.terminationStatus)
  }
}

/// Runs `operation`, giving up after `limit`. The operation isn't awaited past the deadline: it
/// finishes (or hangs) detached, which is what a stuck system call needs.
func withDeadline<Value: Sendable>(
  _ limit: Duration, _ operation: @escaping @Sendable () async throws -> Value
) async throws -> Value {
  let race = DeadlineRace<Value>()
  return try await withCheckedThrowingContinuation { continuation in
    race.start(continuation)
    Task {
      do {
        race.finish(.success(try await operation()))
      } catch {
        race.finish(.failure(error))
      }
    }
    Task {
      try? await Task.sleep(for: limit)
      race.finish(.failure(DeadlineExceeded()))
    }
  }
}

struct DeadlineExceeded: Error, LocalizedError {
  var errorDescription: String? { "it took too long" }
}

private final class DeadlineRace<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Value, any Error>?

  func start(_ continuation: CheckedContinuation<Value, any Error>) {
    lock.withLock { self.continuation = continuation }
  }

  func finish(_ result: Result<Value, any Error>) {
    let waiting = lock.withLock {
      defer { continuation = nil }
      return continuation
    }
    waiting?.resume(with: result)
  }
}
