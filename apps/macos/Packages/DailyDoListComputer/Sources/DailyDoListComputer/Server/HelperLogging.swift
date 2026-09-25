import Darwin
import Foundation

/// The helper's log (stderr). It only ever records method names, durations and error codes:
/// never params, results, messages, UI content or typed text, which is why it takes no strings.
public protocol HelperLogging: Sendable {
  func started(version: Int, pid: Int32)
  /// `method` is a known method name, or nil for a line that wasn't a valid request.
  func handled(method: ComputerService.Method?, duration: Duration, error: ComputerError.Code?)
  func inputClosed()
  func outputClosed()
}

/// `ddl-computer: snapshot 42ms ok`, `ddl-computer: press 3ms error=stale`.
public struct StandardErrorLog: HelperLogging {
  public init() {}

  public func started(version: Int, pid: Int32) {
    write("serving protocol \(version) (pid \(pid))")
  }

  public func handled(
    method: ComputerService.Method?, duration: Duration, error: ComputerError.Code?
  ) {
    write(Self.line(method: method, duration: duration, error: error))
  }

  public func inputClosed() { write("stdin closed; exiting after the requests already read") }

  public func outputClosed() { write("stdout closed, exiting") }

  static func line(method: ComputerService.Method?, duration: Duration, error: ComputerError.Code?)
    -> String
  {
    let milliseconds =
      duration.components.seconds * 1_000
      + duration.components.attoseconds / 1_000_000_000_000_000
    return "\(method?.rawValue ?? "(invalid request)") \(milliseconds)ms "
      + (error.map { "error=\($0.rawValue)" } ?? "ok")
  }

  private func write(_ message: String) {
    let line = "ddl-computer: \(message)\n"
    line.utf8CString.withUnsafeBufferPointer { buffer in
      _ = Darwin.write(STDERR_FILENO, buffer.baseAddress, buffer.count - 1)
    }
  }
}
