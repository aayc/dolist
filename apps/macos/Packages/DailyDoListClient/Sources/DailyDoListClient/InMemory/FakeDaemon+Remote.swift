import DailyDoListDomain
import DailyDoListModels
import Foundation

/// Device settings, sync setup, pairing, the always-on machine and placement, like the daemon's
/// `/api/device*`, `/api/pair*`, `/api/devices*` and `/api/machine*` (validated with the core's
/// rules), and the agent status's `placement` and `readiness`.
extension FakeDaemon {
  // MARK: - Placement

  var machine: AlwaysOnMachine? { settings.remote.alwaysOnMachine }

  /// Why the stored placement can't apply, checked in the daemon's order: no sync on this
  /// device, then no always-on machine.
  var heldHere: HeldHereReason? {
    if !remote.syncs { return .noSync }
    if machine == nil { return .noMachine }
    return nil
  }

  var effectivePlacement: AgentPlacement { heldHere == nil ? remote.placement : .thisDevice }

  /// The daemon reports `off` while it relays with a credential and no relay has said more; this
  /// fake plays the relay too, so it reports what the relay would.
  var relayState: RelayState {
    guard effectivePlacement == .alwaysOnMachine else { return .off }
    if !remote.machinePaired { return .notPaired }
    if remote.handover != nil { return .connecting }
    return remote.machineReachable ? .connected : .unreachable
  }

  func placementStatus() -> AgentPlacementStatus {
    // Handing the agent over, this device has let go before the machine picked it up.
    let released = remote.handover?.to == .machine
    return AgentPlacementStatus(
      placement: remote.placement, heldHere: heldHere,
      runsOn: released ? nil : runsOn(remote.holder), relay: relayState,
      note: remote.handover?.note)
  }

  /// The agent status's `problem` while this device doesn't run the agent (the daemon's words).
  var placementProblem: String? {
    guard remote.syncs else { return nil }
    if let handover = remote.handover { return handover.note }
    if case .other(let name) = remote.holder { return "The agent is running on \(name)." }
    guard effectivePlacement == .alwaysOnMachine, relayState != .connected else { return nil }
    return "The agent is running on \(machine?.name ?? "the always-on machine")."
  }

  func runsOn(_ holder: FakeHolder) -> AgentRunsOn? {
    guard remote.syncs else {
      return simulation == .enabled
        ? AgentRunsOn(
          deviceId: FakeRemote.deviceId, name: remote.deviceName, thisDevice: true,
          alwaysOnMachine: false) : nil
    }
    switch holder {
    case .thisDevice:
      return AgentRunsOn(
        deviceId: FakeRemote.deviceId, name: remote.deviceName, thisDevice: true,
        alwaysOnMachine: effectivePlacement == .alwaysOnHost)
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

  /// Why agent actions can't run from this device right now (the relay will answer 503; until it
  /// exists, the daemon's agent is simply off here, with `placementProblem` as its problem).
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
    var problems: [String] = []
    var name: String?
    if let input = patch.name {
      name = RemoteAccess.normalizeDeviceName(input)
      if name == nil { problems.append(Self.problem(Self.deviceNameProblem(input), at: "name")) }
    }
    var hosts: [String]?
    if let inputs = patch.remoteHosts {
      var normalized: [String] = []
      for (index, input) in inputs.enumerated() {
        if let host = RemoteAccess.normalizeRemoteHost(input) {
          normalized.append(host)
        } else {
          problems.append(
            Self.problem(
              "must be a DNS name with an optional :port (no scheme, path, IP address or loopback name)",
              at: "remoteHosts[\(index)]"))
        }
      }
      if inputs.count > RemoteAccess.Limits.remoteHosts {
        problems.append(
          Self.problem(
            "Too big: expected array to have <=\(RemoteAccess.Limits.remoteHosts) items",
            at: "remoteHosts"))
      } else if Set(normalized).count != normalized.count {
        problems.append(Self.problem("must not repeat a host", at: "remoteHosts"))
      }
      hosts = normalized
    }
    if !problems.isEmpty { throw .invalidRequest(problems.joined(separator: "\n")) }
    if patch.placement != nil, remote.isLocked(.placement) {
      throw Self.lockedByEnv("DDL_AGENT_PLACEMENT sets where the agent runs on this device")
    }
    if patch.remoteHosts != nil, remote.isLocked(.remoteHosts) {
      throw Self.lockedByEnv("DDL_REMOTE_HOSTS sets the names this daemon answers to")
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
    var problems: [String] = []
    if !RemoteAccess.isSecureServiceURL(request.url) || request.url.utf16.count > 2048 {
      problems.append(
        Self.problem("must use https (plain http only to loopback), no credentials", at: "url"))
    }
    if !RemoteAccess.isSyncID(request.vault) {
      problems.append(Self.problem("must be 1-64 characters of A-Z a-z 0-9 _ -", at: "vault"))
    }
    let token = request.token?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let token, token.isEmpty || token.utf16.count > 1024 {
      problems.append(
        Self.problem("Too small: expected string to have >=1 characters", at: "token"))
    }
    if !problems.isEmpty { throw .invalidRequest(problems.joined(separator: "\n")) }
    if remote.isLocked(.sync) { throw Self.lockedByEnv(Self.syncLocked) }
    if let token, token.contains(where: \.isWhitespace) {
      throw .invalidRequest("token must be one line without spaces")
    }
    if token == nil && !remote.hasSyncToken {
      throw .invalidRequest("No vault token is saved yet: include `token`")
    }
    remote.syncURL = request.url
    remote.vault = request.vault
    remote.hasSyncToken = true
    placementInputsChanged()
    return deviceSettings()
  }

  func turnOffSync() throws(DaemonClientError) -> DeviceSettingsResponse {
    if remote.isLocked(.sync) { throw Self.lockedByEnv(Self.syncLocked) }
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
        throw .invalidRequest(Self.problem(Self.deviceNameProblem(input), at: "name"))
      }
      name = valid
    }
    dropExpiredCodes()
    guard remote.pairingCodes.count < FakeRemote.maxOutstandingCodes else {
      throw .rateLimited(
        retryAfter: nil,
        body: ApiErrorBody(
          error: .rateLimited,
          message:
            "\(FakeRemote.maxOutstandingCodes) pairing codes are already waiting: use one, or wait until they expire"
        ))
    }
    let code = nextPairingCode()
    let expiresAt = nowMillis + FakeRemote.pairingCodeLifetime
    remote.pairingCodes[code] = FakeRemote.PairingCode(expiresAt: expiresAt, name: name)
    let url = remote.remoteHosts.first.map { host in
      "https://" + (host.hasSuffix(":443") ? String(host.dropLast(4)) : host)
    }
    return PairingCodeResponse(code: code, expiresAt: expiresAt, url: url)
  }

  /// Attempts are counted before the request is read, like the daemon's global limit.
  func pair(_ request: PairRequest) throws(DaemonClientError) -> PairResponse {
    remote.pairAttempts = remote.pairAttempts.filter { nowMillis - $0 < 60_000 }
    if remote.pairAttempts.count >= FakeRemote.pairAttemptsPerMinute {
      let oldest = remote.pairAttempts.first ?? nowMillis
      throw .rateLimited(
        retryAfter: max(1, Int(((oldest + 60_000 - nowMillis) / 1000).rounded(.up))),
        body: ApiErrorBody(
          error: .rateLimited, message: "Too many pairing attempts: try again in a minute"))
    }
    remote.pairAttempts.append(nowMillis)
    var problems: [String] = []
    let code = RemoteAccess.normalizePairingCode(request.code)
    if code == nil {
      problems.append(Self.problem("must be the 8-character pairing code (XXXX-XXXX)", at: "code"))
    }
    let name = RemoteAccess.normalizeDeviceName(request.name)
    if name == nil {
      problems.append(Self.problem(Self.deviceNameProblem(request.name), at: "name"))
    }
    guard let code, let name, problems.isEmpty else {
      throw .invalidRequest(problems.joined(separator: "\n"))
    }
    dropExpiredCodes()
    guard let redeemed = remote.pairingCodes.removeValue(forKey: code) else {
      remote.pairFailures += 1
      if remote.pairFailures >= FakeRemote.failuresBeforeReset {
        remote.pairingCodes.removeAll()
        remote.pairFailures = 0
      }
      throw .pairingRejected("Wrong, expired or already used pairing code")
    }
    // The name the issuer gave the code wins over the one the new device sends.
    let device = PairedDevice(
      id: nextID("pd"), name: redeemed.name ?? name, kind: request.kind, createdAt: nowMillis,
      lastSeenAt: nil)
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
        error: "Couldn't reach \(machine.name): connect ECONNREFUSED")
    }
    // Without a credential the machine only answers that it's there.
    guard remote.machinePaired else {
      return MachineStatusResponse(
        machine: machine, paired: false, reachable: true, checkedAt: checked)
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
    var problems: [String] = []
    let url = RemoteAccess.normalizeMachineURL(request.url)
    if url == nil {
      problems.append(
        Self.problem(
          "must be https://<host>[:port] without path, query or credentials (plain http only to loopback)",
          at: "url"))
    }
    if RemoteAccess.normalizePairingCode(request.code) == nil {
      problems.append(Self.problem("must be the 8-character pairing code (XXXX-XXXX)", at: "code"))
    }
    let customName = request.name.map(RemoteAccess.normalizeDeviceName)
    if case .some(nil) = customName, let input = request.name {
      problems.append(Self.problem(Self.deviceNameProblem(input), at: "name"))
    }
    guard let url, problems.isEmpty else { throw .invalidRequest(problems.joined(separator: "\n")) }
    let name = customName.flatMap { $0 } ?? RemoteAccess.defaultMachineName(url)
    guard remote.machineReachable else {
      throw .http(
        status: 502,
        body: ApiErrorBody(
          error: .machineUnreachable, message: "Couldn't reach \(name): connect ECONNREFUSED"))
    }
    if remote.machineRejectsCodes {
      throw .pairingRejected(
        "\(name) rejected the pairing code: it may be wrong, expired or already used")
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

  /// Drops the credential and what the last check found (the daemon checks again on demand).
  func forgetMachine() -> MachineStatusResponse {
    remote.machinePaired = false
    remote.machineCheckedAt = nil
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

  static let syncLocked =
    "DDL_SYNC_URL, DDL_SYNC_VAULT or DDL_SYNC_TOKEN set the sync setup of this device"

  /// Why a device or machine name was refused, in the daemon's words (its schema trims first).
  static func deviceNameProblem(_ input: String) -> String {
    let name = input.trimmingCharacters(in: .whitespacesAndNewlines)
    if name.isEmpty { return "Too small: expected string to have >=1 characters" }
    if name.utf16.count > RemoteAccess.Limits.deviceNameLength {
      return "Too big: expected string to have <=\(RemoteAccess.Limits.deviceNameLength) characters"
    }
    return "must not contain control characters"
  }

  /// `✖ <message>\n  → at <path>`: one problem as the daemon's validation reports it.
  static func problem(_ message: String, at path: String) -> String {
    "✖ \(message)\n  → at \(path)"
  }

  static func lockedByEnv(_ reason: String) -> DaemonClientError {
    .http(
      status: 409, body: ApiErrorBody(error: .lockedByEnv, message: "\(reason); change it there"))
  }
}
