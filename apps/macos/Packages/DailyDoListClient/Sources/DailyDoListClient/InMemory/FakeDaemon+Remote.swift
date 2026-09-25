import DailyDoListDomain
import DailyDoListModels
import Foundation

/// Device settings, sync setup, pairing, the always-on machine and placement, like the daemon's
/// `/api/device*`, `/api/pair*`, `/api/devices*` and `/api/machine*` (validated with the core's
/// rules), and the agent status's `placement` and `readiness`.
extension FakeDaemon {
  // MARK: - Placement

  var machine: AlwaysOnMachine? { settings.remote.alwaysOnMachine }

  /// Why the stored placement can't apply: no always-on machine, or no sync on this device.
  var heldHere: HeldHereReason? {
    if machine == nil { return .noMachine }
    if !remote.syncs { return .noSync }
    return nil
  }

  var effectivePlacement: AgentPlacement { heldHere == nil ? remote.placement : .thisDevice }

  var relayState: RelayState {
    guard effectivePlacement == .alwaysOnMachine else { return .off }
    if !remote.machinePaired { return .notPaired }
    if remote.handover != nil { return .connecting }
    return remote.machineReachable ? .connected : .unreachable
  }

  func placementStatus() -> AgentPlacementStatus {
    AgentPlacementStatus(
      placement: remote.placement, heldHere: heldHere, runsOn: runsOn(remote.holder),
      relay: relayState, note: remote.handover?.note)
  }

  func runsOn(_ holder: FakeHolder) -> AgentRunsOn? {
    guard remote.syncs else {
      return simulation == .enabled
        ? AgentRunsOn(
          deviceId: FakeRemote.deviceId, name: remote.deviceName, thisDevice: true,
          alwaysOnMachine: remote.placement == .alwaysOnHost) : nil
    }
    switch holder {
    case .thisDevice:
      return AgentRunsOn(
        deviceId: FakeRemote.deviceId, name: remote.deviceName, thisDevice: true,
        alwaysOnMachine: remote.placement == .alwaysOnHost)
    case .machine:
      guard let machine else { return nil }
      return AgentRunsOn(
        deviceId: FakeRemote.machineDeviceId, name: machine.name, thisDevice: false,
        alwaysOnMachine: true)
    case .other(let name):
      return AgentRunsOn(
        deviceId: "dev_other", name: name, thisDevice: false, alwaysOnMachine: false)
    }
  }

  /// This daemon's readiness: the harness from settings, a credential, the browser, desktop
  /// control that still needs permissions, and the connectors as the status reports them.
  func readiness() -> AgentReadiness {
    let enabled = simulation == .enabled
    let connectors = enabled ? Self.connectors : []
    return AgentReadiness(
      harness: .init(
        kind: settings.agent.harness, ready: enabled,
        problem: enabled ? nil : "The agent runtime is not running"),
      modelCredential: enabled, browser: enabled,
      computer: enabled ? .needsPermissions : .unsupported,
      connectors: .init(
        configured: connectors.count,
        connected: connectors.filter { $0.state == .connected }.count))
  }

  /// Why agent actions can't run from this device right now (the relay answers 503).
  var readOnlyReason: String? {
    guard remote.syncs else { return nil }
    if case .other(let name) = remote.holder {
      return "The agent is running on \(name). Its work shows here read-only."
    }
    let name = machine?.name ?? "the always-on machine"
    if let handover = remote.handover, handover.to == .thisDevice {
      return "The agent is moving to this device. Try again in a moment."
    }
    guard effectivePlacement == .alwaysOnMachine else { return nil }
    switch relayState {
    case .notPaired: return "This device isn't paired with \(name), so its work shows read-only."
    case .unreachable: return "Can't reach \(name). Its work shows here read-only."
    case .connecting: return "Connecting to \(name). Try again in a moment."
    default: return nil
    }
  }

  func requireAgentReachable() throws(DaemonClientError) {
    guard let reason = readOnlyReason else { return }
    throw .http(status: 503, body: ApiErrorBody(error: .agentUnavailable, message: reason))
  }

  /// Moves the agent to where the placement wants it: at once while held here, else through a
  /// simulated handover whose note shows until it's done. Another device that runs the agent
  /// itself keeps it (equal priority: first come, first served).
  func reconcilePlacement() {
    let desired: FakeHolder = effectivePlacement == .alwaysOnMachine ? .machine : .thisDevice
    if case .other = remote.holder { return }
    if let handover = remote.handover, handover.to == desired { return }
    if remote.handover == nil && remote.holder == desired { return }
    guard heldHere == nil, let machine else {
      remote.holder = desired
      remote.handover = nil
      return
    }
    remote.handoverGeneration += 1
    let taking = desired == .thisDevice
    remote.handover = FakeRemote.Handover(
      to: desired,
      note: taking ? "Taking over from \(machine.name)…" : "Handing the agent to \(machine.name)…",
      generation: remote.handoverGeneration)
    schedule(.handover(generation: remote.handoverGeneration), after: taking ? 3_000 : 2_000)
  }

  func finishHandover(generation: Int) {
    guard let handover = remote.handover, handover.generation == generation else { return }
    remote.holder = handover.to
    remote.handover = nil
    emitStatus()
  }

  /// Settings changed the machine (paired, set up elsewhere, removed): placement may apply now.
  func placementInputsChanged() {
    reconcilePlacement()
    emitStatus()
  }

  // MARK: - Device settings

  func deviceSettings() -> DeviceSettingsResponse {
    DeviceSettingsResponse(
      device: .init(id: FakeRemote.deviceId, name: remote.deviceName),
      placement: remote.placement, remoteHosts: remote.remoteHosts,
      sync: DeviceSyncSetup(
        url: remote.syncURL, vault: remote.vault, hasToken: remote.hasSyncToken),
      lockedByEnv: remote.lockedByEnv)
  }

  func updateDeviceSettings(_ patch: DeviceSettingsPatch) throws(DaemonClientError)
    -> DeviceSettingsResponse
  {
    if patch.placement != nil, remote.isLocked(.placement) {
      throw Self.lockedByEnv("The placement is set by DDL_AGENT_PLACEMENT.")
    }
    if patch.remoteHosts != nil, remote.isLocked(.remoteHosts) {
      throw Self.lockedByEnv("The remote hosts are set by DDL_REMOTE_HOSTS.")
    }
    var name: String?
    if let input = patch.name {
      guard let valid = RemoteAccess.normalizeDeviceName(input) else {
        throw .invalidRequest("name: must be 1-64 characters without control characters")
      }
      name = valid
    }
    var hosts: [String]?
    if let inputs = patch.remoteHosts {
      var normalized: [String] = []
      for input in inputs {
        guard let host = RemoteAccess.normalizeRemoteHost(input) else {
          throw .invalidRequest(
            "remoteHosts: “\(input)” must be a DNS name with an optional :port (no scheme, path, IP address or loopback name)"
          )
        }
        normalized.append(host)
      }
      if normalized.count > RemoteAccess.Limits.remoteHosts {
        throw .invalidRequest(
          "remoteHosts: at most \(RemoteAccess.Limits.remoteHosts) names")
      }
      if Set(normalized).count != normalized.count {
        throw .invalidRequest("remoteHosts: must not repeat a host")
      }
      hosts = normalized
    }
    if let name { remote.deviceName = name }
    if let hosts { remote.remoteHosts = hosts }
    if let placement = patch.placement, placement != remote.placement {
      remote.placement = placement
      reconcilePlacement()
      emitStatus()
    } else if name != nil {
      emitStatus()
    }
    return deviceSettings()
  }

  func setUpSync(_ request: DeviceSyncSetupRequest) throws(DaemonClientError)
    -> DeviceSettingsResponse
  {
    if remote.isLocked(.sync) {
      throw Self.lockedByEnv("Sync is set by DDL_SYNC_URL, DDL_SYNC_VAULT and DDL_SYNC_TOKEN.")
    }
    guard RemoteAccess.isSecureServiceURL(request.url), request.url.utf16.count <= 2048 else {
      throw .invalidRequest("url: must use https (plain http only to loopback), no credentials")
    }
    guard RemoteAccess.isSyncID(request.vault) else {
      throw .invalidRequest("vault: must be 1-64 characters of A-Z a-z 0-9 _ -")
    }
    if let token = request.token {
      let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty, trimmed.utf16.count <= 1024 else {
        throw .invalidRequest("token: must be 1-1024 characters")
      }
    } else if !remote.hasSyncToken {
      throw .invalidRequest("token: this device has no vault token yet")
    }
    remote.syncURL = request.url
    remote.vault = request.vault
    remote.hasSyncToken = true
    placementInputsChanged()
    return deviceSettings()
  }

  func turnOffSync() throws(DaemonClientError) -> DeviceSettingsResponse {
    if remote.isLocked(.sync) {
      throw Self.lockedByEnv("Sync is set by DDL_SYNC_URL, DDL_SYNC_VAULT and DDL_SYNC_TOKEN.")
    }
    remote.syncURL = nil
    remote.vault = nil
    remote.hasSyncToken = false
    placementInputsChanged()
    return deviceSettings()
  }

  func syncStatus() -> SyncStatusResponse {
    guard let url = remote.syncURL else {
      return SyncStatusResponse(
        state: .disabled, target: .none, lastSyncedAt: nil, pendingChanges: 0, conflicts: [])
    }
    let host = URLComponents(string: url).map { components in
      (components.host ?? url) + (components.port.map { ":\($0)" } ?? "")
    }
    return SyncStatusResponse(
      state: .idle, target: .remote, lastSyncedAt: nowMillis, pendingChanges: 0, conflicts: [],
      remoteHost: host, deviceName: remote.deviceName)
  }

  // MARK: - Pairing

  func createPairingCode(_ request: PairingCodeRequest) throws(DaemonClientError)
    -> PairingCodeResponse
  {
    var name: String?
    if let input = request.name {
      guard let valid = RemoteAccess.normalizeDeviceName(input) else {
        throw .invalidRequest("name: must be 1-64 characters without control characters")
      }
      name = valid
    }
    dropExpiredCodes()
    guard remote.pairingCodes.count < FakeRemote.maxOutstandingCodes else {
      throw Self.rateLimited(
        "\(FakeRemote.maxOutstandingCodes) pairing codes are waiting to be used. Use one, or wait for them to expire."
      )
    }
    let code = nextPairingCode()
    let expiresAt = nowMillis + FakeRemote.pairingCodeLifetime
    remote.pairingCodes[code] = FakeRemote.PairingCode(expiresAt: expiresAt, name: name)
    let url = remote.remoteHosts.first.map { host in
      "https://" + (host.hasSuffix(":443") ? String(host.dropLast(4)) : host)
    }
    return PairingCodeResponse(code: code, expiresAt: expiresAt, url: url)
  }

  func pair(_ request: PairRequest) throws(DaemonClientError) -> PairResponse {
    remote.pairAttempts = remote.pairAttempts.filter { nowMillis - $0 < 60_000 }
    guard remote.pairAttempts.count < FakeRemote.pairAttemptsPerMinute else {
      throw Self.rateLimited("Too many pairing attempts. Try again in a minute.")
    }
    remote.pairAttempts.append(nowMillis)
    guard let name = RemoteAccess.normalizeDeviceName(request.name) else {
      throw .invalidRequest("name: must be 1-64 characters without control characters")
    }
    guard let code = RemoteAccess.normalizePairingCode(request.code) else {
      throw .invalidRequest("code: must be the 8-character pairing code (XXXX-XXXX)")
    }
    dropExpiredCodes()
    guard remote.pairingCodes.removeValue(forKey: code) != nil else {
      remote.pairFailures += 1
      if remote.pairFailures >= FakeRemote.failuresBeforeReset {
        remote.pairingCodes.removeAll()
        remote.pairFailures = 0
      }
      throw .pairingRejected("That pairing code is wrong, expired or already used.")
    }
    let device = PairedDevice(
      id: nextID("pdv"), name: name, kind: request.kind, createdAt: nowMillis, lastSeenAt: nil)
    remote.pairedDevices.append(device)
    let token = request.kind == .browser ? nil : "fake_" + nextPairingCode() + nextPairingCode()
    return PairResponse(device: device, token: token)
  }

  func pairedDevices() -> [PairedDevice] {
    remote.pairedDevices.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
  }

  func revokeDevice(_ id: String) throws(DaemonClientError) {
    let id = try RequestGuards.runtimeID(id, "device id")
    guard let index = remote.pairedDevices.firstIndex(where: { $0.id == id }) else {
      throw .notFound("Unknown device")
    }
    remote.pairedDevices.remove(at: index)
  }

  private func dropExpiredCodes() {
    remote.pairingCodes = remote.pairingCodes.filter { $0.value.expiresAt > nowMillis }
  }

  /// Deterministic codes from the unambiguous alphabet.
  private func nextPairingCode() -> String {
    remote.codeCounter += 1
    let alphabet = Array(RemoteAccess.pairingCodeAlphabet)
    var state = UInt64(remote.codeCounter) &* 0x9E37_79B9_7F4A_7C15
    var code = ""
    for _ in 0..<RemoteAccess.pairingCodeLength {
      state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      code.append(alphabet[Int((state >> 33) % UInt64(alphabet.count))])
    }
    return code
  }

  // MARK: - The always-on machine

  func machineStatus() -> MachineStatusResponse {
    guard let machine else {
      return MachineStatusResponse(
        machine: nil, paired: false, reachable: nil, checkedAt: nil)
    }
    let checked = remote.machineCheckedAt
    guard checked != nil else {
      return MachineStatusResponse(
        machine: machine, paired: remote.machinePaired, reachable: nil, checkedAt: nil)
    }
    guard remote.machineReachable else {
      return MachineStatusResponse(
        machine: machine, paired: remote.machinePaired, reachable: false, checkedAt: checked,
        error: "\(machine.name) didn't answer.")
    }
    let holder = remote.handover == nil ? remote.holder : .machine
    var runsOn = self.runsOn(holder)
    // As the machine reports it: "this device" is the machine.
    let onTheMachine = runsOn?.deviceId == FakeRemote.machineDeviceId
    runsOn?.thisDevice = onTheMachine
    return MachineStatusResponse(
      machine: machine, paired: remote.machinePaired, reachable: true, checkedAt: checked,
      version: Self.serverVersion, agent: .init(runsOn: runsOn),
      readiness: AgentReadiness(
        harness: .init(kind: .cursor, ready: true), modelCredential: true, browser: true,
        computer: .unsupported, connectors: .init(configured: 1, connected: 1)))
  }

  func pairMachine(_ request: MachinePairRequest) throws(DaemonClientError)
    -> MachineStatusResponse
  {
    guard let url = RemoteAccess.normalizeMachineURL(request.url) else {
      throw .invalidRequest(
        "url: must be https://<host>[:port] without path, query or credentials (plain http only to loopback)"
      )
    }
    guard RemoteAccess.normalizePairingCode(request.code) != nil else {
      throw .invalidRequest("code: must be the 8-character pairing code (XXXX-XXXX)")
    }
    var name = RemoteAccess.defaultMachineName(url)
    if let input = request.name {
      guard let valid = RemoteAccess.normalizeDeviceName(input) else {
        throw .invalidRequest("name: must be 1-64 characters without control characters")
      }
      name = valid
    }
    guard remote.machineReachable else {
      throw .http(
        status: 502,
        body: ApiErrorBody(
          error: .machineUnreachable,
          message: "\(name) didn't answer. Is it running, and on the same private network?"))
    }
    if remote.machineRejectsCodes {
      throw .pairingRejected(
        "\(name) refused that pairing code: it's wrong, expired or already used.")
    }
    let next = settings.applying(
      SettingsPatch(
        remote: .init(alwaysOnMachine: .set(AlwaysOnMachine(name: name, url: url)))))
    if next != settings {
      settings = next
      emit(.settingsChanged(next))
    }
    remote.machinePaired = true
    remote.machineCheckedAt = nowMillis
    placementInputsChanged()
    return machineStatus()
  }

  func checkMachine() -> MachineStatusResponse {
    if machine != nil { remote.machineCheckedAt = nowMillis }
    return machineStatus()
  }

  func forgetMachine() -> MachineStatusResponse {
    remote.machinePaired = false
    placementInputsChanged()
    return machineStatus()
  }

  // MARK: - Simulation

  func simulateMachine(reachable: Bool?, rejectsCodes: Bool?) {
    if let rejectsCodes { remote.machineRejectsCodes = rejectsCodes }
    guard let reachable, reachable != remote.machineReachable else { return }
    remote.machineReachable = reachable
    if machine != nil, remote.machineCheckedAt != nil { remote.machineCheckedAt = nowMillis }
    emitStatus()
  }

  /// Another device set to run the agent itself takes it (`nil`: it lets go).
  func simulateAgentElsewhere(_ name: String?) {
    remote.handover = nil
    if let name {
      remote.holder = .other(name)
    } else {
      remote.holder = effectivePlacement == .alwaysOnMachine ? .machine : .thisDevice
    }
    emitStatus()
  }

  // MARK: - Errors

  static func lockedByEnv(_ message: String) -> DaemonClientError {
    .http(status: 409, body: ApiErrorBody(error: .lockedByEnv, message: message))
  }

  static func rateLimited(_ message: String) -> DaemonClientError {
    .http(status: 429, body: ApiErrorBody(error: .rateLimited, message: message))
  }
}
