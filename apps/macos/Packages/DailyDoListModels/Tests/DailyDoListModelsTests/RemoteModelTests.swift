import Foundation
import Testing

@testable import DailyDoListModels

/// Placement, readiness, device settings, pairing and the always-on machine: what older and newer
/// daemons may send, and what clients send back.
struct RemoteModelTests {
  static func json<T: Encodable>(_ value: T) throws -> JSONValue {
    try JSONDecoder.daemon.decode(JSONValue.self, from: JSONEncoder.daemon.encode(value))
  }

  @Test func agentStatusFromAnOlderDaemonHasNoPlacementOrReadiness() throws {
    let status = try #require(Fixtures.cases("AgentStatusResponse").first)
    let decoded = try Fixtures.decode(AgentStatusResponse.self, status.value)
    #expect(decoded.placement == nil && decoded.readiness == nil)
  }

  @Test func agentStatusCarriesPlacementAndReadiness() throws {
    let fixture = try #require(
      Fixtures.cases("AgentStatusResponse").first { $0.name.hasPrefix("the always-on machine") })
    let status = try Fixtures.decode(AgentStatusResponse.self, fixture.value)
    #expect(status.placement?.placement == .alwaysOnHost)
    #expect(status.placement?.runsOn?.alwaysOnMachine == true)
    #expect(status.placement?.relay == .off)
    #expect(status.readiness?.harness.knownKind == .cursor)
    #expect(status.readiness?.computer == .unsupported)
  }

  @Test func theAgentIsHeldHereWithoutAMachineOrSync() throws {
    let held = try Fixtures.cases("AgentStatusResponse").filter { $0.name.contains("held here") }
    let reasons = try held.map {
      try Fixtures.decode(AgentStatusResponse.self, $0.value).placement?.heldHere
    }
    #expect(reasons == [.noMachine, .noSync])
    let stored = try Fixtures.decode(AgentStatusResponse.self, try #require(held.first).value)
    #expect(stored.placement?.placement == .alwaysOnMachine, "the stored choice is kept")

    let unknown = try #require(Fixtures.cases("AgentStatusResponse", .invalid).first)
    let status = try Fixtures.decode(AgentStatusResponse.self, unknown.value)
    #expect(status.placement?.heldHere?.rawValue == "machine_asleep")
    #expect(try Self.json(status.placement) == unknown.value["placement"])

    let applies = AgentPlacementStatus(placement: .thisDevice, runsOn: nil, relay: .off)
    #expect(try Self.json(applies) == ["placement": "this_device", "runsOn": nil, "relay": "off"])
  }

  @Test func aHarnessFromANewerDaemonKeepsItsName() throws {
    let harness = try Fixtures.decode(
      AgentReadiness.Harness.self, ["kind": "claude", "ready": false, "problem": "Not signed in"])
    #expect(harness.kind == "claude" && harness.knownKind == nil)
    #expect(
      try Self.json(harness) == ["kind": "claude", "ready": false, "problem": "Not signed in"])
  }

  @Test func nobodyRunningTheAgentIsSentAsNull() throws {
    let status = AgentPlacementStatus(placement: .alwaysOnMachine, runsOn: nil, relay: .notPaired)
    #expect(
      try Self.json(status) == [
        "placement": "always_on_machine", "runsOn": nil, "relay": "not_paired",
      ])
  }

  @Test func settingsFromADaemonOlderThanTheAlwaysOnMachineHaveNone() throws {
    guard case .object(var settings) = try Self.json(AppSettings.defaults) else {
      Issue.record("settings are an object")
      return
    }
    settings["remote"] = nil
    let decoded = try Fixtures.decode(AppSettings.self, .object(settings))
    #expect(decoded.remote == .defaults && decoded.remote.alwaysOnMachine == nil)
    #expect(try Self.json(AppSettings.defaults.remote) == ["alwaysOnMachine": nil])
  }

  @Test func patchesSetAndForgetTheAlwaysOnMachine() throws {
    let machine = AlwaysOnMachine(name: "vm-name", url: "https://vm-name.tailnet-name.ts.net")
    let set = SettingsPatch(remote: .init(alwaysOnMachine: .set(machine)))
    #expect(
      try Self.json(set) == [
        "remote": [
          "alwaysOnMachine": ["name": "vm-name", "url": "https://vm-name.tailnet-name.ts.net"]
        ]
      ])
    let paired = AppSettings.defaults.applying(set)
    #expect(paired.remote.alwaysOnMachine == machine)
    #expect(paired.agent == AppSettings.defaults.agent, "other settings are kept")

    let forget = SettingsPatch(remote: .init(alwaysOnMachine: .clear))
    #expect(try Self.json(forget) == ["remote": ["alwaysOnMachine": nil]])
    #expect(paired.applying(forget).remote.alwaysOnMachine == nil)
    #expect(paired.applying(SettingsPatch(remote: .init())).remote.alwaysOnMachine == machine)
    #expect(!forget.isEmpty && SettingsPatch().isEmpty)

    let decoded = try JSONDecoder.daemon.decode(
      SettingsPatch.self, from: Data(#"{"remote":{"alwaysOnMachine":null}}"#.utf8))
    #expect(decoded.remote?.alwaysOnMachine == .clear)
    let untouched = try JSONDecoder.daemon.decode(
      SettingsPatch.self, from: Data(#"{"remote":{}}"#.utf8))
    #expect(untouched.remote?.alwaysOnMachine == nil)
  }

  @Test func devicePatchesCarryOnlyWhatChanges() throws {
    #expect(try Self.json(DeviceSettingsPatch()) == [:])
    #expect(
      try Self.json(DeviceSettingsPatch(placement: .alwaysOnMachine)) == [
        "placement": "always_on_machine"
      ])
    #expect(try Self.json(DeviceSettingsPatch(remoteHosts: [])) == ["remoteHosts": []])
    #expect(
      try Self.json(DeviceSyncSetupRequest(url: "https://sync.example.com", vault: "v_1")) == [
        "url": "https://sync.example.com", "vault": "v_1",
      ])
  }

  @Test func deviceSettingsTellWhichFieldsTheEnvironmentSets() throws {
    let fixture = try #require(
      Fixtures.cases("DeviceSettingsResponse").first { $0.name.contains("environment") })
    let settings = try Fixtures.decode(DeviceSettingsResponse.self, fixture.value)
    #expect(settings.placement == .alwaysOnHost)
    #expect(settings.isLocked(.sync) && settings.isLocked(.remoteHosts))
    let notSyncing = DeviceSyncSetup(url: nil, vault: nil, hasToken: false)
    #expect(try Self.json(notSyncing) == ["url": nil, "vault": nil, "hasToken": false])
  }

  @Test func pairingCodesAreShownAsTwoHalves() {
    let code = PairingCodeResponse(code: "K7PX4MQ9", expiresAt: 0, url: nil)
    #expect(code.displayCode == "K7PX-4MQ9")
    #expect(PairingCodeResponse(code: "K7PX", expiresAt: 0, url: nil).displayCode == "K7PX")
  }

  @Test func routesMatchTheDaemons() {
    #expect(APIRoute.pairedDevice("pdv_1") == "/api/devices/pdv_1")
    #expect(APIRoute.pairedDevice("a/b") == "/api/devices/a%2Fb")
    #expect(APIRoute.machinePair == "/api/machine/pair")
    #expect(APIRoute.deviceSync == "/api/device/sync")
  }

  @Test func machineStatusSendsItsRequiredNulls() throws {
    let status = MachineStatusResponse(machine: nil, paired: false, reachable: nil, checkedAt: nil)
    #expect(
      try Self.json(status) == [
        "machine": nil, "paired": false, "reachable": nil, "checkedAt": nil,
      ])
  }
}
