import DailyDoListModels
import Foundation

/// The agent's work shows on this device, but actions (approving, replying, stopping, retrying,
/// Run Now) can't reach it: the always-on machine can't be reached or this device isn't paired
/// with it, another device runs the agent, or it's moving between devices. The daemon serves
/// the synced copy and answers actions with 503.
public struct AgentReadOnly: Equatable, Sendable {
  /// Why, short: the tooltip of a disabled action ("Can't reach vm-name").
  public var reason: String
  /// The banner over the agent panel: what it means for you.
  public var banner: String

  public init(reason: String, banner: String) {
    self.reason = reason
    self.banner = banner
  }

  /// Nil while actions work (the agent runs here, or the relay to it is up).
  public init?(placement: AgentPlacementStatus?, machineName: String? = nil) {
    guard let placement else { return nil }
    let machine =
      machineName
      ?? (placement.runsOn?.alwaysOnMachine == true ? placement.runsOn?.name : nil)
      ?? "the always-on machine"
    if let note = placement.note, !note.trimmingCharacters(in: .whitespaces).isEmpty {
      self.init(
        reason: "The agent is moving",
        banner:
          "Read-only for a moment, while the agent moves. Approvals and replies wait until it's there."
      )
      return
    }
    if let runsOn = placement.runsOn, !runsOn.thisDevice, !runsOn.alwaysOnMachine {
      self.init(
        reason: "\(runsOn.name) runs the agent",
        banner: "Read-only: \(runsOn.name) runs the agent. Approve and reply there.")
      return
    }
    guard placement.heldHere == nil, placement.placement == .alwaysOnMachine else { return nil }
    switch placement.relay {
    case .unreachable:
      self.init(
        reason: "Can't reach \(machine)",
        banner:
          "Read-only: this is the last synced copy. Approvals, replies and runs wait until \(machine) is back."
      )
    case .notPaired:
      self.init(
        reason: "Not paired with \(machine)",
        banner: "Read-only until this device is paired with \(machine).")
    case .connecting:
      self.init(
        reason: "Connecting to \(machine)",
        banner: "Read-only for a moment, while this device connects to \(machine).")
    default:
      return nil
    }
  }
}
