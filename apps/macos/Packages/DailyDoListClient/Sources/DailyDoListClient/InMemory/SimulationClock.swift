import Foundation

/// How time passes inside an `InMemoryDaemonClient`.
///
/// The fake schedules everything it does later (the agent's settle delay, streamed words, tool
/// steps) on a virtual timeline, and runs due actions in a fixed order. Only the way the timeline
/// advances differs, so given the same calls a `.manual` or `.immediate` fake always produces the
/// same events, ids and timestamps.
public struct SimulationClock: Sendable {
  public enum Mode: Sendable, Equatable {
    /// Wall-clock pacing, sped up by `speed` (demo mode, previews).
    case realTime(speed: Double)
    /// Scheduled work runs to completion before each call returns; virtual time jumps ahead.
    case immediate
    /// Nothing runs until the test calls `advance(by:)` or `runUntilIdle()`.
    case manual
  }

  public var mode: Mode
  /// The virtual time at creation (the demo seed and `today` derive from it).
  public var start: Date
  /// Zone of the local calendar (`today`, daily note names, template times).
  public var timeZone: TimeZone

  public init(mode: Mode, start: Date = Date(), timeZone: TimeZone = .current) {
    self.mode = mode
    self.start = start
    self.timeZone = timeZone
  }

  /// Real time from now, in the current time zone.
  public static func realTime(speed: Double = 1) -> SimulationClock {
    SimulationClock(mode: .realTime(speed: max(0.001, speed)))
  }

  public static func immediate(start: Date = referenceDate, timeZone: TimeZone = referenceTimeZone)
    -> SimulationClock
  {
    SimulationClock(mode: .immediate, start: start, timeZone: timeZone)
  }

  public static func manual(start: Date = referenceDate, timeZone: TimeZone = referenceTimeZone)
    -> SimulationClock
  {
    SimulationClock(mode: .manual, start: start, timeZone: timeZone)
  }

  /// Default start of deterministic clocks: 2026-09-23 09:30 UTC (a Wednesday).
  public static let referenceDate = Date(timeIntervalSince1970: 1_790_155_800)
  /// Default zone of deterministic clocks.
  public static let referenceTimeZone = TimeZone(identifier: "UTC") ?? .gmt
}

/// Whether the fake runs its simulated agent.
public enum AgentSimulation: Sendable, Equatable {
  /// New open tasks in watched daily notes get records, threads, streamed messages, tool calls,
  /// artifacts and (for risky verbs) approvals.
  case enabled
  /// Agent mode `off`: no records or threads; thread actions answer 503 `agent_unavailable`.
  case disabled
}
