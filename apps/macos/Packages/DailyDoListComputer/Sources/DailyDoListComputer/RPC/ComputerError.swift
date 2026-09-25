import Foundation

/// A failed request, as the protocol reports it: `{"code": "<code>", "message": "<human text>"}`.
public struct ComputerError: LocalizedError, Equatable, Sendable, CustomStringConvertible {
  public enum Code: String, Sendable, CaseIterable {
    /// A macOS permission is missing; the message names it.
    case permission
    /// No such app, window or element.
    case notFound = "not_found"
    /// The snapshot changed (or the element is gone): read the app again.
    case stale
    /// The target is refused (see `ProtectedTargets`).
    case protected
    /// The element can't do that (e.g. its value isn't settable).
    case unsupported
    /// Bad params, or an ambiguous app name (the message lists the candidates).
    case invalid
    /// Anything else.
    case failed
  }

  public var code: Code
  public var message: String

  public init(_ code: Code, _ message: String) {
    self.code = code
    self.message = message
  }

  public var description: String { "\(code.rawValue): \(message)" }

  public var errorDescription: String? { message }

  static func invalid(_ message: String) -> ComputerError { ComputerError(.invalid, message) }
  static func notFound(_ message: String) -> ComputerError { ComputerError(.notFound, message) }
  static func stale(_ message: String) -> ComputerError { ComputerError(.stale, message) }
  static func unsupported(_ message: String) -> ComputerError {
    ComputerError(.unsupported, message)
  }
  static func failed(_ message: String) -> ComputerError { ComputerError(.failed, message) }

  static let accessibilityMissing = ComputerError(
    .permission,
    "Accessibility permission is missing: turn on the app that runs the Daily Do List daemon in "
      + "System Settings → Privacy & Security → Accessibility.")
  static let screenRecordingMissing = ComputerError(
    .permission,
    "Screen Recording permission is missing: turn on the app that runs the Daily Do List daemon "
      + "in System Settings → Privacy & Security → Screen & System Audio Recording.")

  var json: JSONValue { ["code": .string(code.rawValue), "message": .string(message)] }
}
