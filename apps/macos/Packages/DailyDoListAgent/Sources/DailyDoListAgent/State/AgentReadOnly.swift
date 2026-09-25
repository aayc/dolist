import DailyDoListModels
import Foundation

/// The agent's work shows on this device, but actions (approving, replying, stopping, retrying,
/// Run Now) can't reach it: the relay can't reach the always-on machine, this device isn't paired
/// with it (or it no longer accepts this device), another device runs the agent, or the always-on
/// machine isn't running it. The daemon serves the synced copy and answers actions with 503.
/// Actions work where the agent runs, and through the relay to the always-on machine running it,
/// while it connects too (the daemon forwards them then). The web app's `readOnlyReason` and
/// `availabilityBanner` follow the same rules, with the same words.
public struct AgentReadOnly: Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    /// The relay can't reach the always-on machine.
    case unreachable
    /// This device has no credential for the always-on machine.
    case notPaired
    /// The always-on machine refused this device's credential: it has to pair again.
    case rejected
    /// Another device runs the agent.
    case elsewhere
    /// Set to the always-on machine, which isn't running the agent (and no relay to ask it).
    case idle
  }

  public var kind: Kind
  /// Why actions are off: their disabled tooltip.
  public var reason: String
  /// Over the agent panel: what it shows instead. Nil while the location line says enough (the
  /// handover's note, connecting).
  public var banner: String?

  public init(kind: Kind, reason: String, banner: String?) {
    self.kind = kind
    self.reason = reason
    self.banner = banner
  }

  /// Nil while actions work. `problem` is the agent status's, which words the relay's refusals.
  public init?(placement: AgentPlacementStatus?, problem: String? = nil) {
    guard let placement, placement.runsOn?.thisDevice != true else { return nil }
    switch placement.relay {
    case .unreachable:
      self.init(.unreachable, "The always-on machine can't be reached", banner: true)
      return
    case .notPaired:
      if Self.rejected(placement, problem: problem) {
        self.init(.rejected, Self.rejectedReason, banner: true)
      } else {
        self.init(.notPaired, "This device isn't paired with the always-on machine", banner: true)
      }
      return
    default:
      break
    }
    let calm = placement.note?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    guard let runsOn = placement.runsOn else {
      guard Self.machineIdle(placement) else { return nil }
      self.init(.idle, Self.machineIdleReason, banner: !calm)
      return
    }
    let relaying = placement.relay == .connected || placement.relay == .connecting
    if relaying && runsOn.alwaysOnMachine { return nil }
    self.init(
      .elsewhere, "The agent is running on \(runsOn.name)",
      banner: !calm && placement.relay != .connecting)
  }

  private init(_ kind: Kind, _ reason: String, banner: Bool) {
    self.init(kind: kind, reason: reason, banner: banner ? reason + Self.syncedSuffix : nil)
  }

  static let syncedSuffix = " — showing the last synced state"
  static let rejectedReason = "The always-on machine no longer accepts this device"
  static let machineIdleReason = "The always-on machine isn't running the agent right now"

  /// The machine refused this device's credential (the relay's "…no longer accepts this device.
  /// Pair it again.").
  static func rejected(_ placement: AgentPlacementStatus, problem: String?) -> Bool {
    placement.relay == .notPaired && problem?.contains("no longer accepts") == true
  }

  /// Set to the always-on machine, which nobody runs the agent on, and no relay to ask it.
  static func machineIdle(_ placement: AgentPlacementStatus) -> Bool {
    placement.placement == .alwaysOnMachine && placement.heldHere == nil
      && placement.runsOn == nil && placement.relay == .off
  }
}
