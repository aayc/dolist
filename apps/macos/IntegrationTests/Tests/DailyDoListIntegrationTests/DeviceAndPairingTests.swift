import DailyDoListClient
import DailyDoListModels
import Foundation
import Testing

extension RealDaemonTests {
  /// This device's settings, pairing other devices, and their credentials over REST and the
  /// WebSocket, against the suite's daemon (no sync, no remote hosts to start with).
  @MainActor
  @Suite("Device settings and pairing")
  struct DeviceAndPairing {
    @Test func deviceSettingsChangeLiveAndSayWhatsWrong() async throws {
      let fixture = try Fixtures.current()
      let client = try fixture.makeClient()
      let before = try await client.deviceSettings()
      #expect(before.lockedByEnv.isEmpty && before.remoteHosts.isEmpty)
      #expect(before.placement == .thisDevice)
      #expect(before.sync == DeviceSyncSetup(url: nil, vault: nil, hasToken: false))

      // Names and hosts are trimmed and lowercased, like the client's own checks.
      let changed = try await client.updateDeviceSettings(
        DeviceSettingsPatch(name: "  Studio Mac ", remoteHosts: [" Studio.Tailnet-Name.ts.net "]))
      #expect(changed.device.name == "Studio Mac" && changed.device.id == before.device.id)
      #expect(changed.remoteHosts == ["studio.tailnet-name.ts.net"])
      #expect(try await client.deviceSettings() == changed)

      // A 400 lists every problem as `✖ <message>\n  → at <path>`: the parsing the app shows.
      let invalid = await captureError {
        try await client.updateDeviceSettings(
          DeviceSettingsPatch(name: "  ", remoteHosts: ["100.64.0.1"]))
      }
      #expect(invalid?.httpStatus == 400 && invalid?.apiErrorCode == .invalidRequest)
      let problems = invalid.flatMap(Self.problems) ?? []
      #expect(problems.map(\.path) == ["name", "remoteHosts[0]"], "\(problems)")
      #expect(problems.first?.message == "Too small: expected string to have >=1 characters")
      #expect(problems.last?.message.hasPrefix("must be a DNS name") == true)
      let repeated = await captureError {
        try await client.updateDeviceSettings(
          DeviceSettingsPatch(remoteHosts: ["a.ts.net", "A.ts.net"]))
      }
      #expect(
        repeated.flatMap(Self.problems)
          == [ValidationProblem(path: "remoteHosts", message: "must not repeat a host")])
      let unknown = await captureError {
        try await client.updateDeviceSettings(
          DeviceSettingsPatch(placement: AgentPlacement(rawValue: "nowhere")))
      }
      #expect(unknown.flatMap(Self.problems)?.map(\.path) == ["placement"])
      #expect(try await client.deviceSettings() == changed, "nothing applied")

      _ = try await client.updateDeviceSettings(
        DeviceSettingsPatch(name: before.device.name, remoteHosts: []))
    }

    /// A placement change shows in the agent status at once (the stored choice, and why it's
    /// held here), and the daemon announces it with `agent.status`.
    @Test func placementShowsInTheAgentStatusAtOnce() async throws {
      let fixture = try Fixtures.current()
      let (client, log) = try await connectedClient(fixture)
      let device = try await client.deviceSettings()
      var status = try await client.agentStatus()
      var placement = try #require(status.placement, "the daemon reports placement")
      #expect(placement.placement == .thisDevice)
      #expect(placement.heldHere == .noSync, "without sync, before a missing machine")
      #expect(placement.relay == .off && placement.note == nil)
      #expect(
        placement.runsOn
          == AgentRunsOn(
            deviceId: device.device.id, name: device.device.name, thisDevice: true,
            alwaysOnMachine: false))
      #expect(status.problem == nil)

      let mark = log.mark
      let patched = try await client.updateDeviceSettings(
        DeviceSettingsPatch(placement: .alwaysOnMachine))
      #expect(patched.placement == .alwaysOnMachine)
      status = try await client.agentStatus()
      placement = try #require(status.placement)
      #expect(placement.placement == .alwaysOnMachine, "a re-fetch right away reflects it")
      #expect(placement.heldHere == .noSync && placement.runsOn?.thisDevice == true)
      #expect(status.problem == nil, "held here, the agent keeps running")
      let announced = try await log.placement(from: mark, "agent.status with the new placement") {
        $0.placement == .alwaysOnMachine
      }
      #expect(announced.heldHere == .noSync)

      _ = try await client.updateDeviceSettings(DeviceSettingsPatch(placement: .thisDevice))
      await client.disconnect()
    }

    /// The readiness is probed in the background, so it can be missing from the first status.
    @Test func readinessShowsOnceProbed() async throws {
      let fixture = try Fixtures.current()
      let client = try fixture.makeClient()
      let readiness = try await eventually("readiness in the agent status", timeout: .seconds(30)) {
        try await client.agentStatus().readiness
      }
      #expect(readiness.harness.knownKind == .pi, "the default harness")
      #expect(readiness.harness.ready && readiness.modelCredential, "the mock agent needs none")
      #expect(readiness.connectors.connected <= readiness.connectors.configured)
      #expect(
        [ComputerReadiness.available, .needsPermissions, .unsupported].contains(readiness.computer)
      )
    }

    @Test func pairingANewDeviceFromTheDaemonsSide() async throws {
      let fixture = try Fixtures.current()
      let master = try fixture.makeClient()
      _ = try await master.updateDeviceSettings(
        DeviceSettingsPatch(remoteHosts: ["studio.tailnet-name.ts.net"]))
      let issued = Date().epochMillis
      let code = try await master.createPairingCode(PairingCodeRequest(name: "Phone"))
      #expect(code.code.count == 8 && code.code.allSatisfy(pairingCodeAlphabet.contains))
      #expect(code.url == "https://studio.tailnet-name.ts.net")
      #expect(abs(code.expiresAt - issued - 5 * 60 * 1000) < 30_000, "five minutes")

      // `pair` goes out without the bearer token: this client's token is not even valid.
      let stranger = try fixture.makeClient(token: "not-a-token")
      let lower = code.code.lowercased()
      let paired = try await stranger.pair(
        PairRequest(code: "\(lower.prefix(4))-\(lower.suffix(4))", name: "Studio Mac", kind: .app))
      #expect(paired.device.name == "Phone", "the name the code was issued for wins")
      #expect(paired.device.kind == .app && paired.device.lastSeenAt == nil)
      let token = try #require(paired.token)
      #expect(token.count >= 16)

      // The device token works as a bearer token.
      let phone = try fixture.makeClient(token: token)
      #expect(try await phone.health().apiVersion == DaemonProtocol.apiVersion)
      let seenByPhone = try await phone.pairedDevices()
      #expect(seenByPhone.first { $0.id == paired.device.id }?.current == true)
      #expect(seenByPhone.filter { $0.current == true }.count == 1)
      let seenByMaster = try await master.pairedDevices()
      #expect(seenByMaster.contains { $0.id == paired.device.id })
      #expect(seenByMaster.allSatisfy { $0.current != true }, "the master token is no device")

      // A used or malformed code is the code's problem, never a rejected token.
      let reused = await captureError {
        try await stranger.pair(PairRequest(code: code.code, name: "Again", kind: .app))
      }
      #expect(reused == .pairingRejected("Wrong, expired or already used pairing code"))
      let malformed = await captureError {
        try await stranger.pair(PairRequest(code: "nope", name: "Again", kind: .app))
      }
      #expect(malformed?.httpStatus == 400)
      #expect(malformed.flatMap(Self.problems)?.map(\.path) == ["code"])

      try await master.revokeDevice(paired.device.id)
      #expect(await captureError { try await phone.health() } == .unauthorized)
      #expect(!(try await master.pairedDevices()).contains { $0.id == paired.device.id })
      let again = await captureError { try await master.revokeDevice(paired.device.id) }
      #expect(
        again == .http(status: 404, body: ApiErrorBody(error: .notFound, message: "Unknown device"))
      )
      _ = try await master.updateDeviceSettings(DeviceSettingsPatch(remoteHosts: []))
    }

    /// A device's socket: `Authorization` header (how clients of remote hosts connect) or
    /// `?token=` (loopback only); revoking the device closes both at once with 1008.
    @Test func aDevicesSocketClosesWhenItsRevoked() async throws {
      let fixture = try Fixtures.current()
      let master = try fixture.makeClient()
      let code = try await master.createPairingCode(PairingCodeRequest(name: "Tablet"))
      let paired = try await master.pair(PairRequest(code: code.code, name: "Tablet", kind: .app))
      let token = try #require(paired.token)

      let viaHeader = try fixture.makeClient(token: token, asRemote: true)
      let viaQuery = try fixture.makeClient(token: token)
      #expect(viaQuery.endpoint.webSocketURL.query == "token=\(token)")
      #expect(viaHeader.endpoint.webSocketURL.query == nil)
      let headerLog = EventLog(viaHeader)
      let queryLog = EventLog(viaQuery)
      await viaHeader.connect()
      await viaQuery.connect()
      try await headerLog.connected()
      try await queryLog.connected()

      let (headerMark, queryMark) = (headerLog.mark, queryLog.mark)
      try await master.revokeDevice(paired.device.id)
      for (log, mark) in [(headerLog, headerMark), (queryLog, queryMark)] {
        let closed = try await log.wait(from: mark, timeout: .seconds(20), for: "a 1008 close") {
          item -> String? in
          if case .state(.reconnecting(_, let reason?)) = item, reason.contains("1008") {
            return reason
          }
          return nil
        }
        #expect(closed.contains("Device revoked"), "\(closed)")
        let refused = try await log.wait(from: mark, timeout: .seconds(20), for: "a 401 upgrade") {
          item -> String? in
          if case .state(.reconnecting(_, let reason?)) = item, reason.contains("HTTP 401") {
            return reason
          }
          return nil
        }
        #expect(refused.contains("refused the connection"))
      }
      await viaHeader.disconnect()
      await viaQuery.disconnect()
    }

    private static func problems(_ error: DaemonClientError) -> [ValidationProblem]? {
      if case .http(_, let body?) = error { return body.problems }
      return nil
    }
  }
}
