import DailyDoListClient
import DailyDoListModels
import Foundation
import Testing

/// Where the agent runs across two daemons syncing one vault through the real sync service:
/// the always-on machine (placement and sync set by its environment) and a laptop set up through
/// the API. Lease handovers take a renewal or two (the daemon's timings: up to ~40 s), so this
/// suite is slow.
@MainActor
@Suite(
  "Placement across two synced daemons",
  .enabled(IntegrationEnvironment.skipReason) { await IntegrationEnvironment.isAvailable() },
  .enabled(IntegrationEnvironment.syncSkipReason) { IntegrationEnvironment.isSyncAvailable })
struct Placement {
  static let handoverTimeout: Duration = .seconds(120)

  @Test func theAgentMovesBetweenTheLaptopAndTheMachine() async throws {
    let sync = try await SyncServiceFixture.launch()
    defer { sync.shutdown() }
    let machineEnvironment = sync.environment.merging([
      "DDL_AGENT_PLACEMENT": "always_on_host",
      "DDL_REMOTE_HOSTS": RealDaemonTests.MachineLink.remoteHost,
    ]) { $1 }
    try await withDaemon(environment: machineEnvironment) { machine in
      try await withDaemon { laptop in
        try await walkThrough(sync: sync, machine: machine, laptop: laptop)
      }
    }
  }

  private func walkThrough(
    sync: SyncServiceFixture, machine: DaemonFixture, laptop: DaemonFixture
  ) async throws {
    let onMachine = try machine.makeClient()
    let machineDevice = try await onMachine.deviceSettings()
    #expect(machineDevice.lockedByEnv == [.placement, .remoteHosts, .sync])
    #expect(machineDevice.sync.url == sync.url && machineDevice.sync.hasToken)
    let port = try machine.connection.baseURL.port ?? 0
    let machineURL = "http://127.0.0.1:\(port)"
    // The machine syncs from the start, so it holds the agent before the laptop asks.
    _ = try await eventually("the machine runs its agent", timeout: Self.handoverTimeout) {
      try await onMachine.agentStatus().placement?.runsOn?.thisDevice == true ? true : nil
    }

    let (client, log) = try await connectedClient(laptop)
    let laptopDevice = try await client.deviceSettings()
    var placement = try #require(try await client.agentStatus().placement)
    #expect(placement.heldHere == .noSync)

    // Sync: the token is required the first time, and never comes back.
    let noToken = await captureError {
      try await client.setUpSync(DeviceSyncSetupRequest(url: sync.url, vault: sync.vault))
    }
    #expect(
      noToken
        == .http(
          status: 400,
          body: ApiErrorBody(
            error: .invalidRequest, message: "No vault token is saved yet: include `token`")))
    let synced = try await client.setUpSync(
      DeviceSyncSetupRequest(url: sync.url, vault: sync.vault, token: sync.token))
    #expect(synced.sync == DeviceSyncSetup(url: sync.url, vault: sync.vault, hasToken: true))
    let syncStatus = try await client.syncStatus()
    #expect(syncStatus.target == .remote && syncStatus.remoteHost == "127.0.0.1:\(sync.port)")
    placement = try #require(try await client.agentStatus().placement)
    #expect(placement.heldHere == .noMachine, "syncing now: the machine is what's missing")

    // With sync on and no machine yet, whoever asked first keeps the agent: the laptop is held
    // here while the machine (asking like any device) runs it.
    let firstHolder = try await eventually(
      "the laptop sees the holder", timeout: Self.handoverTimeout
    ) {
      try await client.agentStatus().placement?.runsOn
    }
    #expect(firstHolder.deviceId == machineDevice.device.id && !firstHolder.thisDevice)
    #expect(!firstHolder.alwaysOnMachine, "nobody asks as the always-on machine yet")
    placement = try #require(try await client.agentStatus().placement)
    #expect(placement.heldHere == .noMachine, "held here, and run elsewhere")

    // Pairing names the vault's always-on machine: the laptop's choice (this device) applies,
    // and it takes the agent over from the machine, showing the takeover as it happens.
    let mark = log.mark
    let code = try await onMachine.createPairingCode(PairingCodeRequest())
    _ = try await client.pairMachine(
      MachinePairRequest(url: machineURL, code: code.code, name: "vm-name"))
    placement = try #require(try await client.agentStatus().placement)
    #expect(placement.heldHere == nil && placement.placement == .thisDevice)
    let here = try await log.placement(
      from: mark, timeout: Self.handoverTimeout, "the laptop runs the agent"
    ) { $0.runsOn?.deviceId == laptopDevice.device.id }
    #expect(here.runsOn?.thisDevice == true && here.runsOn?.alwaysOnMachine == false)
    let notes = log.items[mark...].compactMap { item -> String? in
      if case .event(.agentStatus(let status)) = item { return status.placement?.note }
      return nil
    }
    #expect(notes.contains { $0.hasPrefix("Taking over from ") }, "the takeover showed: \(notes)")
    let machineSees = try await eventually("the machine sees the laptop", timeout: .seconds(30)) {
      let runsOn = try await onMachine.agentStatus().placement?.runsOn
      return runsOn?.deviceId == laptopDevice.device.id ? runsOn : nil
    }
    #expect(!machineSees.thisDevice)

    // Handing it to the machine: a re-fetch right away shows the choice and the note, then the
    // machine (asking as the always-on machine now) picks it up. The relay starts once the
    // laptop has let go of the lease: `off` until then, then connected to the machine.
    let handMark = log.mark
    _ = try await client.updateDeviceSettings(DeviceSettingsPatch(placement: .alwaysOnMachine))
    let status = try await client.agentStatus()
    placement = try #require(status.placement)
    #expect(placement.placement == .alwaysOnMachine && placement.heldHere == nil)
    #expect(placement.note == "Handing the agent to vm-name…")
    #expect(placement.runsOn == nil, "let go, not yet picked up")
    #expect(placement.relay == .off, "still letting go of the lease")
    #expect(status.problem == "Handing the agent to vm-name…", "the laptop's own agent is off")
    let there = try await log.placement(
      from: handMark, timeout: Self.handoverTimeout, "the machine runs the agent"
    ) { $0.runsOn?.deviceId == machineDevice.device.id && $0.note == nil }
    #expect(there.runsOn?.alwaysOnMachine == true && there.runsOn?.thisDevice == false)
    #expect(there.relay == .connected)
    let onItself = try #require(try await onMachine.agentStatus().placement?.runsOn)
    #expect(onItself.thisDevice && onItself.alwaysOnMachine)

    // Forgetting the machine leaves the laptop relaying to nothing: not paired.
    _ = try await client.forgetMachine()
    placement = try #require(try await client.agentStatus().placement)
    #expect(placement.relay == .notPaired)
    await client.disconnect()
  }
}
