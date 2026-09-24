import DailyDoListModels
import Foundation

/// The status bar's one agent item. It never says "on" while the agent can't act: a daemon
/// problem is "Agent unavailable", with the problem itself as the explanation.
struct AgentStatusPresentation: Equatable {
  enum State: Equatable {
    /// Watching the daily notes; clicking pauses.
    case on
    /// Paused by the user; clicking resumes.
    case paused
    /// The daemon runs with the agent turned off (`DDL_AGENT_MODE=off`).
    case off
    /// It should run but can't (missing key, CLI signed out, a failed start…).
    case unavailable
  }

  var state: State
  var label: String
  var systemImage: String
  /// Tooltip, and the explanation shown when the item can't simply be toggled.
  var detail: String

  /// Nil until the daemon reported a status (nothing is shown rather than a guess).
  init?(status: AgentStatusResponse?) {
    guard let status else { return nil }
    let problem = status.problem?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    if status.mode == .off {
      self.init(
        .off, "Agent off", "moon.zzz", problem ?? "The agent is turned off for this daemon.")
    } else if let problem {
      self.init(.unavailable, "Agent unavailable", "exclamationmark.triangle.fill", problem)
    } else if !status.enabled {
      self.init(.paused, "Agent paused", "pause.circle", "The agent is paused. Click to resume.")
    } else {
      self.init(
        .on, "Agent on", "sparkles", "The agent is watching your daily notes. Click to pause.")
    }
  }

  private init(_ state: State, _ label: String, _ systemImage: String, _ detail: String) {
    self.state = state
    self.label = label
    self.systemImage = systemImage
    self.detail = detail
  }

  /// Clicking pauses or resumes; otherwise it explains what's wrong.
  var toggles: Bool { state == .on || state == .paused }
}
