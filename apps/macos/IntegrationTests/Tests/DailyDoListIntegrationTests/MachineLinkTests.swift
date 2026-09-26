import DailyDoListClient
import DailyDoListModels
import Foundation
import Testing

extension RealDaemonTests {
  /// The always-on machine, from this device's side: a second daemon plays the machine (a remote
  /// host and `always_on_host` set by its environment) and the suite's daemon pairs with it.
  ///
  /// Everything goes over loopback: URLSession can't send another `Host` to 127.0.0.1, so the
  /// machine is paired by its loopback address (which the daemon allows over plain http, for
  /// tests); the remote host only shows in its pairing codes and its locked settings.
  @MainActor
  @Suite("The always-on machine")
  struct MachineLink {
    static let remoteHost = "vm-name.tailnet-name.ts.net"
    static let environment = [
      "DDL_AGENT_PLACEMENT": "always_on_host", "DDL_REMOTE_HOSTS": remoteHost,
    ]

    @Test func settingsAnEnvironmentVariableSetsAreReadOnly() async throws {
      try await withDaemon(environment: Self.environment) { machine in
        let client = try machine.makeClient()
        let device = try await client.deviceSettings()
        #expect(device.lockedByEnv == [.placement, .remoteHosts])
        #expect(device.placement == .alwaysOnHost && device.remoteHosts == [Self.remoteHost])

        let placement = await captureError {
          try await client.updateDeviceSettings(DeviceSettingsPatch(placement: .thisDevice))
        }
        #expect(
          placement
            == .http(
              status: 409,
              body: ApiErrorBody(
                error: .lockedByEnv,
                message:
                  "DDL_AGENT_PLACEMENT sets where the agent runs on this device; change it there")))
        let hosts = await captureError {
          try await client.updateDeviceSettings(DeviceSettingsPatch(remoteHosts: []))
        }
        #expect(hosts?.httpStatus == 409 && hosts?.apiErrorCode == .lockedByEnv)
        #expect(hosts?.daemonMessage?.hasPrefix("DDL_REMOTE_HOSTS") == true)
        // What isn't locked still changes.
        #expect(
          try await client.updateDeviceSettings(DeviceSettingsPatch(name: "vm-name")).device.name
            == "vm-name")

        // On the machine itself, before any device named it the vault's always-on machine.
        let status = try #require(try await client.agentStatus().placement)
        #expect(status.placement == .alwaysOnHost && status.heldHere == .noSync)
        #expect(status.runsOn?.thisDevice == true && status.runsOn?.alwaysOnMachine == false)

        let code = try await client.createPairingCode(PairingCodeRequest())
        #expect(code.url == "https://\(Self.remoteHost)")
      }
    }

    @Test func pairingCheckingAndForgettingTheMachine() async throws {
      let fixture = try Fixtures.current()
      let (client, log) = try await connectedClient(fixture)
      try await withDaemon(environment: Self.environment) { machine in
        let onMachine = try machine.makeClient()
        let machineVersion = try await onMachine.health().version
        let port = try machine.connection.baseURL.port ?? 0
        let url = "http://127.0.0.1:\(port)"
        #expect(try await client.machineStatus().machine == nil)

        // Each refusal keeps its own error.
        let badCode = await captureError {
          try await client.pairMachine(MachinePairRequest(url: url, code: "ZZZZZZZZ"))
        }
        guard case .pairingRejected(let message)? = badCode else {
          Issue.record("a refused code isn't .pairingRejected: \(String(describing: badCode))")
          return
        }
        #expect(message?.contains("rejected the pairing code") == true)
        let closed = await captureError {
          try await client.pairMachine(
            MachinePairRequest(url: "http://127.0.0.1:1", code: "ABCD2345"))
        }
        #expect(closed?.httpStatus == 502 && closed?.apiErrorCode == .machineUnreachable)
        let plainHTTP = await captureError {
          try await client.pairMachine(
            MachinePairRequest(url: "http://\(Self.remoteHost)", code: "ABCD2345"))
        }
        #expect(plainHTTP?.httpStatus == 400)
        if case .http(_, let body?)? = plainHTTP { #expect(body.problems.map(\.path) == ["url"]) }

        // Pairing makes it the vault's always-on machine and announces it.
        let mark = log.mark
        let code = try await onMachine.createPairingCode(PairingCodeRequest())
        let paired = try await client.pairMachine(
          MachinePairRequest(url: "\(url)/", code: code.code.lowercased(), name: "vm-name"))
        #expect(paired.machine == AlwaysOnMachine(name: "vm-name", url: url), "normalized")
        #expect(paired.paired && paired.reachable == true && paired.checkedAt != nil)
        #expect(paired.version == machineVersion)
        #expect(paired.agent?.runsOn?.thisDevice == true, "as the machine reports it: itself")
        // A machine that just started may not have probed its readiness yet: a later check has it.
        let readiness = try await eventually("the machine's readiness", timeout: .seconds(30)) {
          try await client.checkMachine().readiness
        }
        #expect(readiness.harness.ready && readiness.modelCredential)
        let announced = try await log.event(from: mark, "settings.changed with the machine") {
          event -> AlwaysOnMachine? in
          if case .settingsChanged(let settings) = event { return settings.remote.alwaysOnMachine }
          return nil
        }
        #expect(announced == paired.machine)
        #expect(try await client.settings().remote.alwaysOnMachine == paired.machine)
        let onTheMachine = try await onMachine.pairedDevices()
        #expect(onTheMachine.contains { $0.kind == .daemon }, "this daemon paired as a daemon")

        // Without sync here, the agent stays held on this device.
        let placement = try #require(try await client.agentStatus().placement)
        #expect(placement.heldHere == .noSync)

        let status = try await client.machineStatus()
        #expect(status.machine == paired.machine && status.paired)
        let checked = try await client.checkMachine()
        #expect(checked.reachable == true && (checked.checkedAt ?? 0) >= (paired.checkedAt ?? 0))

        // Forget drops this device's credential (revoked on the machine) and the last check.
        let forgotten = try await client.forgetMachine()
        #expect(!forgotten.paired && forgotten.machine == paired.machine, "still the vault's")
        #expect(forgotten.reachable == nil && forgotten.checkedAt == nil)
        #expect(!(try await onMachine.pairedDevices()).contains { $0.kind == .daemon })
        let unpaired = try await client.checkMachine()
        #expect(unpaired.reachable == true && unpaired.version == nil && unpaired.agent == nil)

        // Too many attempts: 429 with Retry-After, on the machine and through this daemon.
        var limited: DaemonClientError?
        for _ in 0..<8 where limited == nil {
          let error = await captureError {
            try await onMachine.pair(PairRequest(code: "ZZZZZZZZ", name: "Guess", kind: .app))
          }
          if case .rateLimited? = error { limited = error }
        }
        guard case .rateLimited(let retryAfter, let body)? = limited else {
          Issue.record("no 429 after 8 attempts")
          return
        }
        #expect(
          (1...60).contains(retryAfter ?? 0), "Retry-After: \(String(describing: retryAfter))")
        #expect(body?.error == .rateLimited)
        let relayed = await captureError {
          try await client.pairMachine(MachinePairRequest(url: url, code: "ABCD2345"))
        }
        #expect(relayed?.httpStatus == 429 && relayed?.apiErrorCode == .rateLimited)
      }
      _ = try await client.updateSettings(SettingsPatch(remote: .init(alwaysOnMachine: .clear)))
      await client.disconnect()
    }
  }
}

extension DaemonClientError {
  fileprivate var daemonMessage: String? {
    if case .http(_, let body) = self { return body?.message }
    return nil
  }
}
