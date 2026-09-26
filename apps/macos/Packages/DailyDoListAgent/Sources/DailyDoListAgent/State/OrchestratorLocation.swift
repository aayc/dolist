import DailyDoListModels
import DailyDoListUI
import Foundation

/// What the orchestrator's Remote switch row shows, from the daemon's placement status: on for
/// the always-on machine, off for this device, disabled with the reason while the agent is held
/// on this device, the handover as it happens, and what to do when the always-on machine can't be
/// reached.
public struct OrchestratorLocation: Equatable, Sendable {
  /// What's missing before the always-on machine can run the orchestrator (a Settings pane).
  public enum SetUp: String, Equatable, Sendable {
    case alwaysOnMachine, sync
  }

  /// A line under the control.
  public struct Line: Equatable, Sendable {
    public var text: String
    public var tone: Tone
    /// Something is under way (a handover, connecting).
    public var inProgress: Bool

    public init(_ text: String, tone: Tone, inProgress: Bool = false) {
      self.text = text
      self.tone = tone
      self.inProgress = inProgress
    }
  }

  /// This is the always-on machine: there's nothing to choose.
  public var isHost: Bool
  /// Where the switch says it runs: `.alwaysOnMachine` (on) or `.thisDevice` (off).
  public var selection: AgentPlacement
  /// The switch can be flipped (not held here, not switching, not the host).
  public var canSwitch: Bool
  /// A change is on its way to the daemon.
  public var isSwitching: Bool
  public var heldHere: HeldHereReason?
  /// Why the control is disabled while the agent is held here.
  public var heldTooltip: TooltipContent?
  /// The setup that would make the always-on machine usable.
  public var setUp: SetUp?
  /// The always-on machine no longer accepts this device: the setup is pairing again.
  public var pairsAgain: Bool
  /// The handover, the relay's trouble, or who else runs the agent.
  public var line: Line?
  /// The always-on machine can't be reached: offer to run the orchestrator here instead.
  public var offersRunHere: Bool

  /// Nil when the daemon doesn't report placement (older daemons). `problem` is the agent
  /// status's, which words the relay's refusals.
  public init?(
    status: AgentPlacementStatus?, machineName: String? = nil, problem: String? = nil,
    pending: AgentPlacement? = nil
  ) {
    guard let status else { return nil }
    let machine =
      machineName
      ?? (status.runsOn?.alwaysOnMachine == true ? status.runsOn?.name : nil)
      ?? "the always-on machine"
    isHost = status.placement == .alwaysOnHost
    heldHere = isHost ? nil : status.heldHere
    let stored: AgentPlacement =
      status.placement == .alwaysOnMachine ? .alwaysOnMachine : .thisDevice
    selection = pending ?? (heldHere == nil ? stored : .thisDevice)
    isSwitching = pending != nil
    canSwitch = !isHost && heldHere == nil && pending == nil
    offersRunHere = false
    setUp = nil
    pairsAgain = false
    heldTooltip = nil
    line = nil

    switch heldHere {
    case .noMachine:
      setUp = .alwaysOnMachine
      heldTooltip = TooltipContent(
        "No always-on machine is set up",
        detail: Self.heldDetail("Set one up to run the orchestrator there.", stored: stored))
    case .noSync:
      setUp = .sync
      heldTooltip = TooltipContent(
        "This device doesn't sync",
        detail: Self.heldDetail(
          "The always-on machine works from the synced vault: set up sync to run the orchestrator there.",
          stored: stored))
    default:
      break
    }

    // The relay reports only while the always-on machine applies; what it says comes first. With
    // sync on and no machine yet, another device asking with the same priority can hold the
    // agent while this one is "held here": say who runs it before what this one waits for.
    let other = status.runsOn.flatMap { $0.thisDevice || $0.alwaysOnMachine ? nil : $0.name }
    if let note = status.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
      line = Line(note, tone: .info, inProgress: true)
    } else if status.relay == .unreachable {
      line = Line("\(machineName ?? "The always-on machine") can't be reached", tone: .warning)
      offersRunHere = pending == nil
    } else if status.relay == .notPaired {
      pairsAgain = AgentReadOnly.rejected(status, problem: problem)
      line = Line(
        pairsAgain
          ? AgentReadOnly.rejectedReason : "This device isn't paired with the always-on machine",
        tone: .warning)
      setUp = .alwaysOnMachine
    } else if status.relay == .connecting {
      line = Line("Connecting to \(machine)…", tone: .info, inProgress: true)
    } else if let other {
      line = Line("\(other) runs the agent now", tone: .faint)
    } else if heldHere == .noMachine {
      line = Line("Runs here until an always-on machine is set up", tone: .faint)
    } else if heldHere == .noSync {
      line = Line("Runs here until this device syncs", tone: .faint)
    } else if isHost, let runsOn = status.runsOn, !runsOn.thisDevice {
      line = Line("\(runsOn.name) runs the agent now", tone: .faint)
    }
  }

  private static func heldDetail(_ reason: String, stored: AgentPlacement) -> String {
    stored == .alwaysOnMachine
      ? reason + " It moves there, as you chose, once that's done." : reason
  }
}
