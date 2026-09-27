import DailyDoListClient
import DailyDoListModels
import Foundation
import Observation

/// Session-scoped state. Every request captures the identity and enablement generation; results
/// from a replaced/disconnected host are discarded, and failed mutations are never replayed.
@MainActor
@Observable
final class MobileSettingsStore {
  private(set) var settings: AppSettings?
  private(set) var hostName = "Host"
  private(set) var actionsEnabled = false
  private(set) var device: DeviceSettingsResponse?
  private(set) var sync: SyncStatusResponse?
  private(set) var machine: MachineStatusResponse?
  private(set) var devices: [PairedDevice]?
  private(set) var code: PairingCodeResponse?
  private(set) var agent: AgentStatusResponse?
  private(set) var connectors: [ConnectorStatus]?
  private(set) var health: HealthResponse?
  private(set) var busy = Set<String>()
  private(set) var errors: [String: String] = [:]
  @ObservationIgnored private var client: (any DaemonClient)?
  @ObservationIgnored private var hostID = ""
  @ObservationIgnored private var epoch = 0
  @ObservationIgnored var isCurrentSession: @MainActor () -> Bool = { true }
  @ObservationIgnored var onSettingsSaved: ((AppSettings) -> Void)?
  var canMutate: Bool { actionsEnabled && isCurrentSession() && client != nil && busy.isEmpty }

  func configure(
    client: (any DaemonClient)?, hostID: String, hostName: String, settings: AppSettings?,
    enabled: Bool
  ) {
    let replaced =
      self.client.map(ObjectIdentifier.init) != client.map(ObjectIdentifier.init)
      || self.hostID != hostID
    if replaced {
      epoch += 1
      self.client = client
      self.hostID = hostID
      device = nil
      sync = nil
      machine = nil
      devices = nil
      code = nil
      agent = nil
      connectors = nil
      health = nil
      busy = []
      errors = [:]
      self.settings = settings
    }
    if actionsEnabled != enabled {
      epoch += 1
      busy = []
      code = nil
    }
    actionsEnabled = enabled
    self.hostName = hostName
    if let settings { self.settings = settings }
  }

  func invalidate() {
    epoch += 1
    client = nil
    actionsEnabled = false
    busy = []
    code = nil
  }
  func dismissCode() { code = nil }

  func load() async {
    guard actionsEnabled, isCurrentSession(), let client else { return }
    async let a = fetch("settings") {
      try await client.settings()
    } apply: {
      self.settings = $0
    }
    async let b = fetch("device") {
      try await client.deviceSettings()
    } apply: {
      self.device = $0
    }
    async let c = fetch("sync") {
      try await client.syncStatus()
    } apply: {
      self.sync = $0
    }
    async let d = fetch("machine") {
      try await client.machineStatus()
    } apply: {
      self.machine = $0
    }
    async let e = fetch("devices") {
      try await client.pairedDevices()
    } apply: {
      self.devices = $0
    }
    async let f = fetch("agent") {
      try await client.agentStatus()
    } apply: {
      self.agent = $0
    }
    async let g = fetch("connectors") {
      try await client.connectors()
    } apply: {
      self.connectors = $0
    }
    async let h = fetch("health") {
      try await client.health()
    } apply: {
      self.health = $0
    }
    _ = await (a, b, c, d, e, f, g, h)
  }

  @discardableResult
  func save(_ patch: SettingsPatch, consent: PolicyConsent? = nil) async -> Bool {
    guard canMutate, let client, let current = settings else { return false }
    if let target = patch.agent?.approvalPolicy,
      MobileApprovalPolicy.widens(from: current.agent.approvalPolicy, to: target),
      consent != PolicyConsent(from: current.agent.approvalPolicy, to: target)
    {
      errors["save"] = "Review and confirm the current approval-policy change before saving."
      return false
    }
    return await fetch("save") {
      try await client.updateSettings(patch)
    } apply: {
      self.settings = $0
      self.onSettingsSaved?($0)
    }
  }

  @discardableResult
  func updateDevice(_ patch: DeviceSettingsPatch) async -> Bool {
    guard canMutate, let client else { return false }
    return await fetch("device") {
      try await client.updateDeviceSettings(patch)
    } apply: {
      self.device = $0
    }
  }
  @discardableResult
  func setUpSync(_ request: DeviceSyncSetupRequest) async -> Bool {
    guard canMutate, let client else { return false }
    let saved = await fetch("sync") {
      try await client.setUpSync(request)
    } apply: {
      self.device = $0
    }
    if saved { await load() }
    return saved
  }
  func disableSync() async {
    guard canMutate, let client else { return }
    let saved = await fetch("sync") {
      try await client.turnOffSync()
    } apply: {
      self.device = $0
    }
    if saved { await load() }
  }
  @discardableResult
  func pairMachine(_ request: MachinePairRequest) async -> Bool {
    guard canMutate, let client else { return false }
    let saved = await fetch("machine") {
      try await client.pairMachine(request)
    } apply: {
      self.machine = $0
    }
    if saved { await load() }
    return saved
  }
  func checkMachine() async {
    guard canMutate, let client else { return }
    await fetch("machine") {
      try await client.checkMachine()
    } apply: {
      self.machine = $0
    }
  }
  func forgetMachine() async {
    guard canMutate, let client else { return }
    await fetch("machine") {
      try await client.forgetMachine()
    } apply: {
      self.machine = $0
    }
  }
  func createCode(name: String?) async {
    guard canMutate, let client else { return }
    await fetch("devices") {
      try await client.createPairingCode(PairingCodeRequest(name: name))
    } apply: {
      self.code = $0
    }
  }
  func revoke(_ device: PairedDevice) async {
    guard canMutate, let client, device.current != true else { return }
    await fetch("devices") {
      try await client.revokeDevice(device.id)
      return device.id
    } apply: { id in
      self.devices?.removeAll { $0.id == id }
    }
  }

  @discardableResult
  private func fetch<Value: Sendable>(
    _ key: String, _ operation: @Sendable () async throws -> Value,
    apply: @MainActor (Value) -> Void
  ) async -> Bool {
    guard actionsEnabled, isCurrentSession(), !busy.contains(key) else { return false }
    let generation = epoch
    busy.insert(key)
    defer { if generation == epoch { busy.remove(key) } }
    do {
      let value = try await operation()
      guard generation == epoch, actionsEnabled, isCurrentSession(), !Task.isCancelled else {
        return false
      }
      errors[key] = nil
      apply(value)
      return true
    } catch {
      guard generation == epoch, actionsEnabled, isCurrentSession(), !Task.isCancelled else {
        return false
      }
      errors[key] = Self.message(error)
      return false
    }
  }

  private static func message(_ error: Error) -> String {
    if let error = error as? DaemonClientError {
      switch error {
      case .unauthorized: return "This connection is no longer authorized. Pair the iPhone again."
      case .unreachable:
        return
          "The host could not be reached. The change was not acknowledged; refresh before trying again."
      case .http(let status, let body):
        if status == 403 {
          return "This operation must be performed on the host with local authorization."
        }
        if status == 404 {
          return "This host does not support this operation. Update Daily Do List on the host."
        }
        return body?.message ?? "The host rejected this change."
      default: return error.localizedDescription
      }
    }
    return error.localizedDescription
  }
}
