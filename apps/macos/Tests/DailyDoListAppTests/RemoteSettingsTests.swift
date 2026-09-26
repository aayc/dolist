import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListApp

/// Settings → Always-On's store with scripted daemon answers: what it loads, what each action
/// keeps, and the inline message for every error code. The integration tests check the real
/// daemon's answers and bodies.
@MainActor
@Suite("Always-on settings")
struct RemoteSettingsTests {
  nonisolated static let machine = AlwaysOnMachine(
    name: "vm-name", url: "https://vm-name.tailnet-name.ts.net")
  nonisolated static let noSync = DeviceSyncSetup(url: nil, vault: nil, hasToken: false)

  nonisolated static func device(name: String = "This Mac", sync: DeviceSyncSetup = noSync)
    -> DeviceSettingsResponse
  {
    DeviceSettingsResponse(
      device: .init(id: "dev_mac", name: name), placement: .thisDevice, remoteHosts: [], sync: sync)
  }

  nonisolated static func machineStatus(
    paired: Bool = true, reachable: Bool? = true, error: String? = nil
  )
    -> MachineStatusResponse
  {
    MachineStatusResponse(
      machine: machine, paired: paired, reachable: reachable, checkedAt: 1, error: error)
  }

  nonisolated static func sync(_ target: SyncTargetKind) -> SyncStatusResponse {
    SyncStatusResponse(
      state: target == .none ? .disabled : .idle, target: target, lastSyncedAt: nil,
      pendingChanges: 0, conflicts: [])
  }

  nonisolated static func refusal(_ status: Int, _ code: ApiErrorCode, _ message: String)
    -> DaemonClientError
  {
    .http(status: status, body: ApiErrorBody(error: code, message: message))
  }

  func store(_ client: DaemonClient) -> RemoteSettingsStore {
    let store = RemoteSettingsStore()
    store.client = client
    return store
  }

  @Test func loadsEverythingAtOnceAndAnOlderDaemonIsUnsupported() async {
    let client = FakeDaemonClient()
    client.script {
      $0.deviceSettings = { Self.device() }
      $0.syncStatus = { Self.sync(.remote) }
      $0.machineStatus = { Self.machineStatus() }
      $0.pairedDevices = { [] }
    }
    let store = store(client)
    await store.load()
    #expect(store.device?.device.name == "This Mac")
    #expect(store.machine?.machine?.name == "vm-name" && store.machine?.paired == true)
    #expect(store.syncStatus?.target == .remote)
    #expect(store.devices == [])
    #expect(store.error(.load) == nil && !store.isUnsupported)

    let old = self.store(FakeDaemonClient())
    await old.load()
    #expect(old.isUnsupported)
    #expect(old.error(.load) == "This daemon doesn't support this yet. Update it.")
  }

  @Test func theMachineKeepsWhatTheDaemonAnsweredAndARefusalShowsInline() async {
    let client = FakeDaemonClient()
    let reachable = Locked(false)
    client.script {
      $0.pairMachine = { request in
        guard reachable.current else {
          throw Self.refusal(
            502, .machineUnreachable, "Couldn't reach vm-name: connect ECONNREFUSED")
        }
        return MachineStatusResponse(
          machine: AlwaysOnMachine(name: request.name ?? "vm-name", url: request.url), paired: true,
          reachable: true, checkedAt: 1)
      }
      $0.checkMachine = {
        Self.machineStatus(reachable: false, error: "Couldn't reach vm-name: connect ECONNREFUSED")
      }
      $0.forgetMachine = { Self.machineStatus(paired: false, reachable: nil) }
    }
    let store = store(client)
    let url = Self.machine.url
    #expect(await store.pairMachine(url: url, code: "ABCD2345", name: nil) == false)
    #expect(store.error(.pairMachine) == "Couldn't reach vm-name: connect ECONNREFUSED")
    reachable.mutate { $0 = true }
    #expect(await store.pairMachine(url: url, code: "ABCD2345", name: "Cloud VM"))
    #expect(store.error(.pairMachine) == nil, "a success clears the message")
    #expect(store.machine?.machine == AlwaysOnMachine(name: "Cloud VM", url: url))

    await store.checkMachine()
    #expect(store.machine?.reachable == false)
    #expect(store.machine?.error == "Couldn't reach vm-name: connect ECONNREFUSED")
    await store.forgetMachine()
    #expect(store.machine?.paired == false && store.machine?.machine?.name == "vm-name")
  }

  @Test func thisDeviceSyncAndPairingKeepWhatTheDaemonAnswered() async throws {
    let client = FakeDaemonClient()
    let syncTarget = Locked(SyncTargetKind.none)
    let phone = PairedDevice(
      id: "dev_phone", name: "Phone", kind: .app, createdAt: 1, lastSeenAt: nil)
    client.script {
      $0.syncStatus = { Self.sync(syncTarget.current) }
      $0.setUpSync = { request in
        guard request.token != nil else {
          throw Self.refusal(400, .invalidRequest, "No vault token is saved yet: include `token`")
        }
        syncTarget.mutate { $0 = .remote }
        return Self.device(
          sync: DeviceSyncSetup(url: request.url, vault: request.vault, hasToken: true))
      }
      $0.turnOffSync = {
        syncTarget.mutate { $0 = .none }
        return Self.device()
      }
      $0.updateDeviceSettings = { patch in
        guard let name = patch.name, name.count <= 64 else {
          throw Self.refusal(
            400, .invalidRequest, "✖ Too big: expected string to have <=64 characters\n  → at name")
        }
        return Self.device(name: name)
      }
      $0.createPairingCode = { _ in
        PairingCodeResponse(code: "ABCD2345", expiresAt: 300_000, url: nil)
      }
      $0.pairedDevices = { [phone] }
      $0.revokeDevice = { _ in }
    }
    let store = store(client)

    #expect(
      await store.setUpSync(url: "https://sync.example.com", vault: "v1", token: nil) == false)
    #expect(store.error(.sync) == "No vault token is saved yet: include `token`")
    #expect(await store.setUpSync(url: "https://sync.example.com", vault: "v1", token: "t0k3n"))
    #expect(store.device?.sync.hasToken == true && store.syncStatus?.target == .remote)
    #expect(await store.turnOffSync())
    #expect(store.device?.sync.url == nil && store.syncStatus?.state == .disabled)

    #expect(await store.rename("Studio Mac"))
    #expect(store.device?.device.name == "Studio Mac")
    #expect(await store.rename(String(repeating: "x", count: 65)) == false)
    #expect(store.error(.rename) == "name: Too big: expected string to have <=64 characters")

    await store.createPairingCode(name: "Phone")
    #expect(store.pairingCode?.code == "ABCD2345")
    #expect(PairingCodeCard.countdown(299.2) == "5:00" && PairingCodeCard.countdown(61) == "1:01")
    client.script {
      $0.createPairingCode = { _ in
        throw DaemonClientError.rateLimited(
          retryAfter: nil, body: ApiErrorBody(error: .rateLimited))
      }
    }
    await store.createPairingCode(name: nil)
    #expect(
      store.error(.pairingCode)
        == "Too many pairing codes are waiting. Use one, or wait a few minutes for them to expire.")

    await store.loadDevices()
    await store.revoke(try #require(store.devices?.first))
    #expect(store.devices == [] && store.error(.revoke) == nil)
    #expect(client.calls.contains("revokeDevice:dev_phone"))
    client.script {
      $0.revokeDevice = { _ in throw Self.refusal(404, .notFound, "Unknown device") }
    }
    await store.revoke(phone)
    #expect(store.error(.revoke) == "That device isn't paired anymore.")
  }

  // MARK: - Remote access

  @Test func remoteHostsAreCheckedBeforeTheyreSent() {
    let hosts = ["studio.tailnet-name.ts.net"]
    #expect(RemoteAccessSection.problem("", in: hosts) == nil)
    #expect(RemoteAccessSection.problem(" VM-Name.Tailnet-Name.ts.net:8443 ", in: hosts) == nil)
    #expect(
      RemoteAccessSection.problem("Studio.Tailnet-Name.ts.net", in: hosts) == "It's already listed."
    )
    for bad in ["https://vm.ts.net", "100.64.0.1", "vm.ts.net/app", "localhost"] {
      #expect(
        RemoteAccessSection.problem(bad, in: hosts)?.hasPrefix("Use a DNS name") == true, "\(bad)")
    }
    let full = (1...8).map { "host\($0).ts.net" }
    #expect(RemoteAccessSection.problem("vm.ts.net", in: full) == "At most 8 names.")
  }

  // MARK: - Messages

  @Test func everyErrorCodeHasAClearMessage() {
    func message(
      _ status: Int, _ code: ApiErrorCode, _ said: String? = nil,
      _ action: RemoteSettingsStore.Action = .load
    ) -> String {
      RemoteSettingsMessages.message(
        for: DaemonClientError.http(status: status, body: ApiErrorBody(error: code, message: said)),
        action: action)
    }
    #expect(message(409, .lockedByEnv) == "An environment variable sets this. Change it there.")
    #expect(message(409, .lockedByEnv, "Set by DDL_SYNC_URL.") == "Set by DDL_SYNC_URL.")
    func limited(_ retryAfter: Int?, _ action: RemoteSettingsStore.Action) -> String {
      RemoteSettingsMessages.message(
        for: DaemonClientError.rateLimited(
          retryAfter: retryAfter, body: ApiErrorBody(error: .rateLimited)),
        action: action)
    }
    #expect(
      limited(nil, .pairingCode)
        == "Too many pairing codes are waiting. Use one, or wait a few minutes for them to expire.")
    #expect(limited(nil, .pairMachine) == "Too many attempts. Wait a minute, then try again.")
    #expect(limited(42, .pairMachine) == "Too many attempts. Try again in 42 seconds.")
    #expect(
      message(502, .machineUnreachable)
        == "The always-on machine didn't answer. Is it running, and on the same private network?")
    #expect(
      message(404, .notFound, "Unknown device", .revoke) == "That device isn't paired anymore.")
    #expect(
      message(400, .invalidRequest, "✖ must use https (plain http only to loopback)\n  → at url")
        == "url: must use https (plain http only to loopback)")
    // Several problems at once, as the daemon reports them (checked against its real bodies in
    // the integration tests).
    #expect(
      message(
        400, .invalidRequest,
        "✖ Too small: expected string to have >=1 characters\n  → at name\n✖ must not repeat a host\n  → at remoteHosts"
      )
        == "name: Too small: expected string to have >=1 characters; remoteHosts: must not repeat a host"
    )
    #expect(
      message(400, .invalidRequest, "token must be one line without spaces")
        == "token must be one line without spaces")
    #expect(message(400, .invalidRequest) == "The daemon didn't accept that.")
    #expect(
      message(503, .agentUnavailable, "The always-on machine can't be reached.")
        == "The always-on machine can't be reached.")
    #expect(
      RemoteSettingsMessages.message(for: DaemonClientError.pairingRejected(nil), action: .load)
        == "That code is wrong, expired or already used.")
    #expect(
      RemoteSettingsMessages.message(
        for: DaemonClientError.pairingRejected(nil), action: .pairMachine)
        == "The always-on machine refused that code: it's wrong, expired or already used. Get a new one there."
    )
    #expect(
      RemoteSettingsMessages.message(for: DaemonClientError.unauthorized, action: .load)
        == "The daemon rejected this app's token.")
    #expect(
      RemoteSettingsMessages.message(for: DaemonClientError.unreachable("refused"), action: .load)
        == "Can't reach the daemon.")
  }
}
