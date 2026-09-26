import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListApp

/// Settings → Always-On's store against the in-memory daemon: what it loads, what each action
/// sends, and the inline message for every error code.
@MainActor
@Suite("Always-on settings", .serialized)
struct RemoteSettingsTests {
  static let machineURL = "https://vm-name.tailnet-name.ts.net"

  func store(_ remote: InMemoryDaemonClient.Remote) -> (RemoteSettingsStore, InMemoryDaemonClient) {
    let client = InMemoryDaemonClient(
      seed: .empty, clock: .immediate(start: referenceNow), agent: .enabled,
      clientId: "macos_test", remote: remote)
    let store = RemoteSettingsStore()
    store.client = client
    return (store, client)
  }

  @Test func loadsEverythingAtOnce() async {
    let (store, _) = store(.alwaysOn)
    await store.load()
    #expect(store.device?.device.name == "This Mac")
    #expect(store.machine?.machine?.name == "vm-name" && store.machine?.paired == true)
    #expect(store.syncStatus?.target == .remote)
    #expect(store.devices == [])
    #expect(store.error(.load) == nil && !store.isUnsupported)
  }

  @Test func anOlderDaemonIsUnsupported() async {
    let store = RemoteSettingsStore()
    store.client = FakeDaemonClient()
    await store.load()
    #expect(store.isUnsupported)
    #expect(store.error(.load) == "This daemon doesn't support this yet. Update it.")
  }

  // MARK: - The always-on machine

  @Test func pairingTheMachineExplainsEachRefusal() async {
    var remote = InMemoryDaemonClient.Remote.alwaysOn
    remote.machine = nil
    remote.machinePaired = false
    let (store, client) = store(remote)
    await store.load()
    #expect(store.machine?.machine == nil)

    #expect(await store.pairMachine(url: "http://vm.ts.net", code: "ABCD2345", name: nil) == false)
    #expect(store.error(.pairMachine)?.hasPrefix("url: must be https://") == true)

    await client.simulateMachine(reachable: false)
    #expect(await store.pairMachine(url: Self.machineURL, code: "ABCD2345", name: nil) == false)
    #expect(store.error(.pairMachine) == "Couldn't reach vm-name: connect ECONNREFUSED")

    await client.simulateMachine(reachable: true, rejectsCodes: true)
    #expect(await store.pairMachine(url: Self.machineURL, code: "ABCD2345", name: nil) == false)
    #expect(
      store.error(.pairMachine)
        == "The always-on machine refused that code: it's wrong, expired or already used. Get a new one there."
    )

    await client.simulateMachine(rejectsCodes: false)
    #expect(await store.pairMachine(url: Self.machineURL, code: "ABCD2345", name: "Cloud VM"))
    #expect(store.error(.pairMachine) == nil)
    #expect(store.machine?.machine == AlwaysOnMachine(name: "Cloud VM", url: Self.machineURL))
    #expect(store.machine?.paired == true && store.machine?.reachable == true)
  }

  @Test func checkingAndForgettingTheMachine() async {
    let (store, client) = store(.alwaysOn)
    await store.load()
    await client.simulateMachine(reachable: false)
    await store.checkMachine()
    #expect(store.machine?.reachable == false)
    #expect(store.machine?.error == "Couldn't reach vm-name: connect ECONNREFUSED")
    await store.forgetMachine()
    #expect(store.machine?.paired == false && store.machine?.machine?.name == "vm-name")
  }

  // MARK: - Sync

  @Test func syncKeepsTheTokenWriteOnly() async {
    var remote = InMemoryDaemonClient.Remote.alwaysOn
    remote.syncURL = nil
    remote.vault = nil
    let (store, _) = store(remote)
    await store.load()
    #expect(store.device?.sync == DeviceSyncSetup(url: nil, vault: nil, hasToken: false))
    #expect(store.syncStatus?.state == .disabled)

    #expect(
      await store.setUpSync(url: "https://sync.example.com", vault: "v1", token: nil) == false)
    #expect(store.error(.sync) == "No vault token is saved yet: include `token`")
    #expect(await store.setUpSync(url: "https://sync.example.com", vault: "v1", token: "t0k3n"))
    #expect(store.device?.sync.hasToken == true && store.error(.sync) == nil)
    #expect(store.syncStatus?.state == .idle && store.syncStatus?.remoteHost == "sync.example.com")
    #expect(await store.turnOffSync())
    #expect(store.device?.sync.url == nil && store.syncStatus?.state == .disabled)
  }

  @Test func settingsAnEnvironmentVariableSetsAreRefusedWithWhy() async {
    var remote = InMemoryDaemonClient.Remote.alwaysOn
    remote.lockedByEnv = [.sync, .remoteHosts]
    let (store, _) = store(remote)
    await store.load()
    #expect(await store.turnOffSync() == false)
    #expect(
      store.error(.turnOffSync)
        == "DDL_SYNC_URL, DDL_SYNC_VAULT or DDL_SYNC_TOKEN set the sync setup of this device; change it there"
    )
    #expect(await store.setRemoteHosts([]) == false)
    #expect(
      store.error(.remoteHosts)
        == "DDL_REMOTE_HOSTS sets the names this daemon answers to; change it there")
  }

  // MARK: - Devices

  @Test func pairingANewDeviceAndRevokingIt() async throws {
    let (store, client) = store(.alwaysOn)
    await store.load()
    #expect(await store.setRemoteHosts(["studio.tailnet-name.ts.net"]))
    await store.createPairingCode(name: "Phone")
    let code = try #require(store.pairingCode)
    #expect(code.url == "https://studio.tailnet-name.ts.net")
    #expect(code.expiresAt == referenceNow.epochMillis + 5 * 60 * 1000)
    #expect(PairingCodeCard.countdown(299.2) == "5:00" && PairingCodeCard.countdown(61) == "1:01")

    _ = try await client.pair(PairRequest(code: code.code, name: "Phone", kind: .app))
    await store.loadDevices()
    let phone = try #require(store.devices?.first)
    #expect(phone.name == "Phone")
    await store.revoke(phone)
    #expect(store.devices == [] && store.error(.revoke) == nil)
    await store.revoke(phone)
    #expect(store.error(.revoke) == "That device isn't paired anymore.")

    store.dismissPairingCode()
    for _ in 0..<4 { await store.createPairingCode(name: nil) }
    #expect(
      store.error(.pairingCode)
        == "Too many pairing codes are waiting. Use one, or wait a few minutes for them to expire.")
  }

  @Test func renamingThisDevice() async {
    let (store, _) = store(.alwaysOn)
    await store.load()
    #expect(await store.rename("Studio Mac"))
    #expect(store.device?.device.name == "Studio Mac")
    #expect(await store.rename(String(repeating: "x", count: 65)) == false)
    #expect(store.error(.rename) == "name: Too big: expected string to have <=64 characters")
  }

  // MARK: - Remote access

  @Test func remoteHostsAreCheckedBeforeTheyreSent() async {
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

    let (store, _) = store(.standalone)
    await store.load()
    #expect(
      await store.setRemoteHosts([
        "vm-name.tailnet-name.ts.net", "vm-name.tailnet-name.ts.net:8443",
      ]))
    #expect(store.device?.remoteHosts.count == 2)
    #expect(await store.setRemoteHosts([]))
    #expect(store.device?.remoteHosts == [])
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
      RemoteSettingsMessages.message(for: DaemonClientError.unauthorized, action: .load)
        == "The daemon rejected this app's token.")
    #expect(
      RemoteSettingsMessages.message(for: DaemonClientError.unreachable("refused"), action: .load)
        == "Can't reach the daemon.")
  }
}
