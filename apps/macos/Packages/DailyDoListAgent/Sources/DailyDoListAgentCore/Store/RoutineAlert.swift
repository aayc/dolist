import DailyDoListClient
import DailyDoListModels
import Foundation

/// Why a routine action (Run Now, Pause, Resume) didn't happen, in words for the routine's view.
public struct RoutineAlert: Identifiable, Hashable, Sendable {
  public enum Kind: Hashable, Sendable {
    /// 409 on Run Now: a run is going, the routine has a problem, or today's extra runs are used.
    case cantRunNow
    /// 503: the agent can't run on this Mac right now.
    case agentUnavailable
    /// Anything else (unreachable daemon, unknown routine…).
    case failed
  }

  public let id: UUID
  public var kind: Kind
  public var title: String
  public var message: String

  public init(id: UUID = UUID(), kind: Kind, title: String, message: String) {
    self.id = id
    self.kind = kind
    self.title = title
    self.message = message
  }

  /// A failed Run Now. The daemon's message says why when it gave one; otherwise the routine's own
  /// state does.
  static func run(_ error: Error, routine: Routine?, agentProblem: String?) -> RoutineAlert {
    let name = routine.map { "“\($0.name)”" } ?? "The routine"
    let daemonMessage = (error as? DaemonClientError)?.daemonMessage
    switch (error as? DaemonClientError)?.httpStatus {
    case 409:
      return RoutineAlert(
        kind: .cantRunNow, title: "\(name) can't run now",
        message: daemonMessage ?? localReason(routine))
    case 503:
      return RoutineAlert(
        kind: .agentUnavailable, title: "The agent can't run routines right now",
        message: daemonMessage ?? agentProblem ?? "The agent isn't running on this Mac.")
    default:
      return RoutineAlert(
        kind: .failed, title: "Couldn't run \(name)", message: AgentAlert.describe(error))
    }
  }

  static func pause(_ error: Error, routine: Routine?, paused: Bool) -> RoutineAlert {
    let name = routine.map { "“\($0.name)”" } ?? "the routine"
    return RoutineAlert(
      kind: .failed, title: paused ? "Couldn't pause \(name)" : "Couldn't resume \(name)",
      message: AgentAlert.describe(error))
  }

  /// Why a routine can't run, from what the app knows about it.
  static func localReason(_ routine: Routine?) -> String {
    guard let routine else { return "It can't run right now." }
    if routine.isRunning { return "A run is still going. Wait for it to finish, or stop it." }
    if let error = routine.error { return "Fix its problem first: \(error)" }
    if routine.extraRunsLeft == 0 {
      return "Today's extra runs are used up. It runs again at its next scheduled time."
    }
    return "It can't run right now."
  }
}

/// Why the daemon didn't create a routine, and which field of the form it's about.
public struct RoutineFormError: Error, Hashable, Sendable {
  public enum Field: String, Hashable, Sendable {
    case name, schedule, instructions, other
  }

  public var field: Field
  public var message: String

  public init(field: Field, message: String) {
    self.field = field
    self.message = message
  }

  /// 409 and `invalid_path` are about the name; other 400s name their field (`→ at schedule`) or
  /// are about the schedule, the one field only the daemon can check.
  init(_ error: Error) {
    let client = error as? DaemonClientError
    let message = client?.daemonMessage ?? AgentAlert.describe(error)
    switch client?.httpStatus {
    case 409:
      self.init(field: .name, message: message)
    case 400 where client?.apiErrorCode == .invalidPath:
      self.init(field: .name, message: message)
    case 400:
      let field = Self.fieldMentioned(in: message) ?? .schedule
      self.init(field: field, message: Self.withoutFieldMarker(message))
    default:
      self.init(field: .other, message: message)
    }
  }

  /// The field of a validation message ending in `→ at <field>`.
  static func fieldMentioned(in message: String) -> Field? {
    guard let marker = message.range(of: "→ at ", options: .backwards) else { return nil }
    let name = message[marker.upperBound...].prefix { $0.isLetter }
    return Field(rawValue: String(name))
  }

  static func withoutFieldMarker(_ message: String) -> String {
    guard let marker = message.range(of: "\n", options: .backwards),
      message[marker.upperBound...].trimmingCharacters(in: .whitespaces).hasPrefix("→ at ")
    else { return message }
    return String(message[..<marker.lowerBound])
  }
}

extension DaemonClientError {
  /// The message of the daemon's error body, when it sent one.
  var daemonMessage: String? {
    guard case .http(_, let body?) = self, let message = body.message, !message.isEmpty else {
      return nil
    }
    return message
  }
}
