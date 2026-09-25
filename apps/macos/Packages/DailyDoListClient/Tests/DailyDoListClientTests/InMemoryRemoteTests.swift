import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListClient

/// Device settings, sync setup, pairing, the always-on machine and placement in
/// `InMemoryDaemonClient`.
struct InMemoryRemoteTests {
  static let machineURL = "https://vm-name.tailnet-name.ts.net"

  static func client(
    _ remote: InMemoryDaemonClient.Remote = .standalone, clock: SimulationClock = .manual()
  ) -> InMemoryDaemonClient {
    InMemoryDaemonClient(seed: .empty, clock: clock, clientId: "macos_test", remote: remote)
  }

  static func placement(_ client: InMemoryDaemonClient) async throws -> AgentPlacementStatus {
    try #require(try await client.agentStatus().placement)
  }

  static func placements(_ recorder: StreamRecorder) -> [AgentPlacementStatus] {
    recorder.events.compactMap {
      if case .agentStatus(let status) = $0 { status.placement } else { nil }
    }
  }

  static func http(_ status: Int, _ code: ApiErrorCode, _ body: () async throws -> Void) async {
    do {
      try await body()
      Issue.record("expected \(status) \(code.rawValue)")
    } catch let error as DaemonClientError {
      #expect(error.httpStatus == status && error.apiErrorCode == code, "\(error)")
    } catch {
      Issue.record("unexpected \(error)")
    }
  }

  // MARK: - Placement

  @Test func withoutAMachineTheAgentIsHeldHereWhateverIsStored() async throws {
    let client = Self.client()
    var placement = try await Self.placement(client)
    #expect(placement.placement == .thisDevice && placement.heldHere == .noMachine)
    #expect(placement.runsOn?.thisDevice == true && placement.relay == .off)
    #expect(placement.note == nil)
    let readiness = try #require(try await client.agentStatus().readiness)
    #expect(readiness.harness.knownKind == .pi && readiness.harness.ready)
    #expect(readiness.connectors.configured == 3 && readiness.connectors.connected == 2)
    #expect(readiness.computer == .needsPermissions)

    let device = try await client.updateDeviceSettings(
      DeviceSettingsPatch(placement: .alwaysOnMachine))
    #expect(device.placement == .alwaysOnMachine)
    placement = try await Self.placement(client)
    #expect(placement.placement == .alwaysOnMachine && placement.heldHere == .noMachine)
    #expect(placement.runsOn?.thisDevice == true && placement.relay == .off)
    #expect(await client.pendingActions == 0, "no handover while held here")

    var noSync = InMemoryDaemonClient.Remote.alwaysOn
    noSync.syncURL = nil
    #expect(try await Self.placement(Self.client(noSync)).heldHere == .noSync)
  }

  @Test func switchingShowsTheHandoverAsItHappens() async throws {
    let client = Self.client(.alwaysOn)
    let recorder = StreamRecorder(client.events())
    await client.connect()
    var placement = try await Self.placement(client)
    #expect(placement.heldHere == nil && placement.runsOn?.thisDevice == true)

    _ = try await client.updateDeviceSettings(DeviceSettingsPatch(placement: .alwaysOnMachine))
    placement = try await Self.placement(client)
    #expect(placement.note == "Handing the agent to vm-name…")
    #expect(placement.relay == .connecting && placement.runsOn?.thisDevice == true)
    await client.advance(by: .seconds(2))
    placement = try await Self.placement(client)
    #expect(placement.note == nil && placement.relay == .connected)
    #expect(placement.runsOn?.name == "vm-name" && placement.runsOn?.alwaysOnMachine == true)

    _ = try await client.updateDeviceSettings(DeviceSettingsPatch(placement: .thisDevice))
    placement = try await Self.placement(client)
    #expect(placement.note == "Taking over from vm-name…" && placement.relay == .off)
    #expect(placement.runsOn?.name == "vm-name")
    await client.advance(by: .seconds(3))
    placement = try await Self.placement(client)
    #expect(placement.note == nil && placement.runsOn?.thisDevice == true)

    try await recorder.waitFor("the last status") { item in
      if case .event(.agentStatus(let status)) = item {
        return status.placement?.runsOn?.thisDevice == true && status.placement?.note == nil
          && status.placement?.placement == .thisDevice
      }
      return false
    }
    #expect(
      Self.placements(recorder).compactMap(\.note) == [
        "Handing the agent to vm-name…", "Taking over from vm-name…",
      ])
    await client.disconnect()
  }

  @Test func anUnreachableMachineLeavesTheAgentReadOnly() async throws {
    var remote = InMemoryDaemonClient.Remote.alwaysOn
    remote.placement = .alwaysOnMachine
    let client = InMemoryDaemonClient(
      seed: .files(["Daily/2026-09-23.md": "- [ ] Order a new kettle\n"]), clock: .immediate(),
      clientId: "macos_test", remote: remote)
    #expect(try await Self.placement(client).relay == .connected)
    _ = try await client.writeNote(
      "Daily/2026-09-23.md", content: "- [ ] Order a new kettle\n- [ ] Book a table\n",
      baseVersion: .unconditional)
    let approval = try #require(try await client.approvals(status: .pending).first)
    let threadId = try #require(approval.threadId)

    await client.simulateMachine(reachable: false)
    let placement = try await Self.placement(client)
    #expect(placement.relay == .unreachable && placement.runsOn?.name == "vm-name")
    await Self.http(503, .agentUnavailable) {
      _ = try await client.decideApproval(approval.id, ApprovalDecisionRequest(decision: .approve))
    }
    await Self.http(503, .agentUnavailable) {
      _ = try await client.postMessage(threadId: threadId, text: "Hi")
    }
    do {
      _ = try await client.retryThread(threadId)
      Issue.record("expected a 503")
    } catch let error as DaemonClientError {
      #expect(error.localizedDescription == "Can't reach vm-name. Its work shows here read-only.")
    }
    #expect(try await client.thread(threadId).thread.id == threadId, "reads work")
    #expect(try await client.machineStatus().reachable == false)

    await client.simulateMachine(reachable: true)
    _ = try await client.decideApproval(approval.id, ApprovalDecisionRequest(decision: .deny))
  }

  @Test func anotherDeviceRunningTheAgentKeepsIt() async throws {
    let client = Self.client(.alwaysOn, clock: .immediate())
    await client.simulateAgentElsewhere("Work laptop")
    var placement = try await Self.placement(client)
    #expect(placement.runsOn?.name == "Work laptop" && placement.runsOn?.thisDevice == false)
    _ = try await client.updateDeviceSettings(DeviceSettingsPatch(placement: .thisDevice))
    #expect(try await Self.placement(client).runsOn?.name == "Work laptop", "first come")
    await Self.http(503, .agentUnavailable) {
      _ = try await client.cancelThread(OrchestratorThread.id)
    }
    await client.simulateAgentElsewhere(nil)
    placement = try await Self.placement(client)
    #expect(placement.runsOn?.thisDevice == true)
  }

  @Test func theAlwaysOnMachineRunsItsOwnAgent() async throws {
    let client = Self.client(.host)
    let placement = try await Self.placement(client)
    #expect(placement.placement == .alwaysOnHost && placement.heldHere == nil)
    #expect(placement.runsOn?.thisDevice == true && placement.runsOn?.alwaysOnMachine == true)
    let device = try await client.deviceSettings()
    #expect(device.isLocked(.placement) && device.isLocked(.remoteHosts))
    #expect(device.remoteHosts == ["vm-name.tailnet-name.ts.net"])
  }

  // MARK: - Device settings

  @Test func deviceSettingsAreValidatedLikeTheDaemon() async throws {
    let client = Self.client()
    var device = try await client.deviceSettings()
    #expect(device.device.name == "This Mac" && device.remoteHosts.isEmpty)
    #expect(device.sync == DeviceSyncSetup(url: nil, vault: nil, hasToken: false))

    device = try await client.updateDeviceSettings(
      DeviceSettingsPatch(name: "  Studio Mac ", remoteHosts: [" Studio.Tailnet-Name.ts.net "]))
    #expect(device.device.name == "Studio Mac")
    #expect(device.remoteHosts == ["studio.tailnet-name.ts.net"])
    for patch in [
      DeviceSettingsPatch(name: "  "), DeviceSettingsPatch(remoteHosts: ["100.64.0.1"]),
      DeviceSettingsPatch(remoteHosts: ["https://studio.ts.net"]),
      DeviceSettingsPatch(remoteHosts: ["a.ts.net", "A.ts.net"]),
      DeviceSettingsPatch(remoteHosts: (0..<9).map { "host\($0).ts.net" }),
    ] {
      await Self.http(400, .invalidRequest) { _ = try await client.updateDeviceSettings(patch) }
    }
    #expect(try await client.deviceSettings() == device, "nothing applied")
  }

  @Test func fieldsSetByTheEnvironmentAreLocked() async throws {
    var remote = InMemoryDaemonClient.Remote.alwaysOn
    remote.lockedByEnv = [.placement, .remoteHosts, .sync]
    let client = Self.client(remote)
    await Self.http(409, .lockedByEnv) {
      _ = try await client.updateDeviceSettings(DeviceSettingsPatch(placement: .alwaysOnMachine))
    }
    await Self.http(409, .lockedByEnv) {
      _ = try await client.updateDeviceSettings(DeviceSettingsPatch(remoteHosts: []))
    }
    await Self.http(409, .lockedByEnv) { _ = try await client.turnOffSync() }
    await Self.http(409, .lockedByEnv) {
      _ = try await client.setUpSync(
        DeviceSyncSetupRequest(url: "https://sync.example.com", vault: "v"))
    }
    #expect(
      try await client.updateDeviceSettings(DeviceSettingsPatch(name: "Mac")).device.name == "Mac")
  }

  @Test func syncSetupKeepsTheTokenWriteOnly() async throws {
    var remote = InMemoryDaemonClient.Remote.alwaysOn
    remote.syncURL = nil
    let client = Self.client(remote)
    #expect(try await client.syncStatus().state == .disabled)
    await Self.http(400, .invalidRequest) {
      _ = try await client.setUpSync(
        DeviceSyncSetupRequest(url: "https://sync.example.com", vault: "vault_1"))
    }
    for request in [
      DeviceSyncSetupRequest(url: "http://sync.example.com", vault: "vault_1", token: "t"),
      DeviceSyncSetupRequest(url: "https://sync.example.com", vault: "vault 1", token: "t"),
      DeviceSyncSetupRequest(url: "https://sync.example.com", vault: "vault_1", token: "  "),
    ] {
      await Self.http(400, .invalidRequest) { _ = try await client.setUpSync(request) }
    }
    var device = try await client.setUpSync(
      DeviceSyncSetupRequest(url: "https://sync.example.com", vault: "vault_1", token: "secret"))
    #expect(
      device.sync
        == DeviceSyncSetup(url: "https://sync.example.com", vault: "vault_1", hasToken: true))
    #expect(try await Self.placement(client).heldHere == nil)
    let status = try await client.syncStatus()
    #expect(status.target == .remote && status.remoteHost == "sync.example.com")
    device = try await client.setUpSync(
      DeviceSyncSetupRequest(url: "https://sync.example.com", vault: "vault_2"))
    #expect(device.sync.vault == "vault_2" && device.sync.hasToken, "kept the token")

    device = try await client.turnOffSync()
    #expect(device.sync == DeviceSyncSetup(url: nil, vault: nil, hasToken: false))
    #expect(try await Self.placement(client).heldHere == .noSync)
  }

  // MARK: - Pairing

  @Test func pairingCodesAreSingleUseAndExpire() async throws {
    let client = Self.client()
    _ = try await client.updateDeviceSettings(
      DeviceSettingsPatch(remoteHosts: ["studio.tailnet-name.ts.net"]))
    let first = try await client.createPairingCode(PairingCodeRequest(name: "Phone"))
    #expect(first.code.count == 8 && first.displayCode.count == 9)
    #expect(first.url == "https://studio.tailnet-name.ts.net")
    #expect(first.expiresAt == (await client.now).epochMillis + 5 * 60 * 1000)

    let lower = first.code.lowercased()
    let paired = try await client.pair(
      PairRequest(code: "\(lower.prefix(4))-\(lower.suffix(4))", name: "Phone", kind: .app))
    #expect(paired.device.name == "Phone" && paired.device.kind == .app)
    #expect((paired.token?.count ?? 0) >= 16)
    await #expect(
      throws: DaemonClientError.pairingRejected(
        "That pairing code is wrong, expired or already used.")
    ) {
      _ = try await client.pair(PairRequest(code: first.code, name: "Again", kind: .app))
    }

    let browserCode = try await client.createPairingCode(PairingCodeRequest())
    let browser = try await client.pair(
      PairRequest(code: browserCode.code, name: "Browser", kind: .browser))
    #expect(browser.token == nil, "browsers get a cookie")
    #expect(try await client.pairedDevices().map(\.name) == ["Phone", "Browser"])

    let expiring = try await client.createPairingCode(PairingCodeRequest())
    await client.advance(by: .seconds(5 * 60))
    await #expect(throws: DaemonClientError.self) {
      _ = try await client.pair(PairRequest(code: expiring.code, name: "Late", kind: .app))
    }

    try await client.revokeDevice(paired.device.id)
    #expect(try await client.pairedDevices().map(\.name) == ["Browser"])
    await Self.http(404, .notFound) { try await client.revokeDevice(paired.device.id) }
  }

  @Test func pairingIsLimited() async throws {
    let client = Self.client()
    var codes: [String] = []
    for _ in 0..<3 { codes.append(try await client.createPairingCode(PairingCodeRequest()).code) }
    #expect(Set(codes).count == 3)
    await Self.http(429, .rateLimited) {
      _ = try await client.createPairingCode(PairingCodeRequest())
    }
    _ = try await client.pair(PairRequest(code: codes[0], name: "Phone", kind: .app))
    _ = try await client.createPairingCode(PairingCodeRequest())

    for _ in 0..<4 {
      await #expect(throws: DaemonClientError.self) {
        _ = try await client.pair(PairRequest(code: "ZZZZZZZZ", name: "Guess", kind: .app))
      }
    }
    await Self.http(429, .rateLimited) {
      _ = try await client.pair(PairRequest(code: codes[1], name: "Tablet", kind: .app))
    }
    await client.advance(by: .seconds(61))
    _ = try await client.pair(PairRequest(code: codes[1], name: "Tablet", kind: .app))
  }

  // MARK: - The always-on machine

  @Test func pairingTheMachineMakesItTheVaultsMachine() async throws {
    var remote = InMemoryDaemonClient.Remote.alwaysOn
    remote.machine = nil
    remote.machinePaired = false
    let client = Self.client(remote, clock: .immediate())
    let recorder = StreamRecorder(client.events())
    await client.connect()
    #expect(
      try await client.machineStatus()
        == MachineStatusResponse(
          machine: nil, paired: false, reachable: nil, checkedAt: nil))

    await Self.http(400, .invalidRequest) {
      _ = try await client.pairMachine(
        MachinePairRequest(url: "http://vm-name.tailnet-name.ts.net", code: "ABCD2345"))
    }
    await Self.http(400, .invalidRequest) {
      _ = try await client.pairMachine(MachinePairRequest(url: Self.machineURL, code: "ABCD-O123"))
    }
    await client.simulateMachine(reachable: false)
    await Self.http(502, .machineUnreachable) {
      _ = try await client.pairMachine(MachinePairRequest(url: Self.machineURL, code: "ABCD2345"))
    }
    await client.simulateMachine(reachable: true, rejectsCodes: true)
    do {
      _ = try await client.pairMachine(MachinePairRequest(url: Self.machineURL, code: "ABCD2345"))
      Issue.record("expected the machine to refuse the code")
    } catch DaemonClientError.pairingRejected(let message) {
      #expect(message?.hasPrefix("vm-name refused that pairing code") == true)
    }
    await client.simulateMachine(rejectsCodes: false)

    let status = try await client.pairMachine(
      MachinePairRequest(url: "HTTPS://VM-Name.Tailnet-Name.ts.net/", code: "abcd 2345"))
    #expect(status.machine == AlwaysOnMachine(name: "vm-name", url: Self.machineURL))
    #expect(status.paired && status.reachable == true && status.version != nil)
    #expect(status.agent?.runsOn?.thisDevice == false, "the agent runs on this Mac, not the VM")
    #expect(try await client.settings().remote.alwaysOnMachine?.url == Self.machineURL)
    #expect(try await Self.placement(client).heldHere == nil)
    try await recorder.waitFor("settings.changed") { item in
      if case .event(.settingsChanged(let settings)) = item {
        return settings.remote.alwaysOnMachine != nil
      }
      return false
    }

    #expect(try await client.checkMachine().checkedAt != nil)
    let forgotten = try await client.forgetMachine()
    #expect(!forgotten.paired && forgotten.machine != nil, "the machine stays in settings")
    await client.disconnect()
  }

  @Test func forgettingTheMachineWhileRelayingLeavesItUnpaired() async throws {
    var remote = InMemoryDaemonClient.Remote.alwaysOn
    remote.placement = .alwaysOnMachine
    let client = Self.client(remote)
    #expect(try await Self.placement(client).relay == .connected)
    _ = try await client.forgetMachine()
    #expect(try await Self.placement(client).relay == .notPaired)
    _ = try await client.updateSettings(SettingsPatch(remote: .init(alwaysOnMachine: .clear)))
    let placement = try await Self.placement(client)
    #expect(placement.heldHere == .noMachine && placement.runsOn?.thisDevice == true)
    await Self.http(400, .invalidRequest) {
      _ = try await client.updateSettings(
        SettingsPatch(
          remote: .init(
            alwaysOnMachine: .set(AlwaysOnMachine(name: "vm", url: "http://vm.ts.net"))
          )))
    }
  }
}
