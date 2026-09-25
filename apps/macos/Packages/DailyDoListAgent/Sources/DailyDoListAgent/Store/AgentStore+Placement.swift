import DailyDoListClient
import DailyDoListModels
import Foundation

/// Where the orchestrator runs: this device or the always-on machine (a device setting the daemon
/// applies live, announcing the handover with `agent.status`).
extension AgentStore {
  /// This device's placement and who runs the agent now; nil from daemons that don't report it.
  public var placement: AgentPlacementStatus? { status?.placement }

  /// What the "where the orchestrator runs" control shows; nil without placement.
  public var orchestratorLocation: OrchestratorLocation? {
    OrchestratorLocation(
      status: placement, machineName: alwaysOnMachineName, problem: status?.problem,
      pending: pendingPlacement)
  }

  /// Agent actions can't be taken from this device right now, and why; nil when they can.
  public var readOnly: AgentReadOnly? {
    AgentReadOnly(placement: placement, problem: status?.problem)
  }

  /// Whether the orchestrator can be moved to `target` now (the command's availability).
  public func canMoveOrchestrator(to target: AgentPlacement) -> Bool {
    guard let location = orchestratorLocation else { return false }
    return location.canSwitch && location.selection != target
  }

  /// Runs the orchestrator on this device or the always-on machine. The daemon hands the agent
  /// over in the background; `placement.note` says how it's going. Returns whether the daemon
  /// took the change.
  @discardableResult
  public func moveOrchestrator(to target: AgentPlacement) async -> Bool {
    guard canMoveOrchestrator(to: target) else { return false }
    pendingPlacement = target
    defer { pendingPlacement = nil }
    let mark = eventSeq
    do {
      _ = try await client.updateDeviceSettings(DeviceSettingsPatch(placement: target))
    } catch {
      report(
        error,
        title: target == .thisDevice
          ? "Couldn't move the orchestrator to this device"
          : "Couldn't move the orchestrator to the always-on machine")
      return false
    }
    // Shows the new choice without waiting for the handover's `agent.status` event.
    if let status = try? await client.agentStatus() { applyFetchedStatus(status, since: mark) }
    return true
  }
}
