import DailyDoListClient
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
    #expect(
      store.error(.pairMachine)
        == "vm-name didn't answer. Is it running, and on the same private network?")

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
    #expect(store.machine?.reachable == false && store.machine?.error == "vm-name didn't answer.")
    await store.forgetMachine()
    #expect(store.machine?.paired == false && store.machine?.machine?.name == "vm-name")
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
    #expect(
      message(429, .rateLimited, nil, .pairingCode)
        == "Too many pairing codes are waiting. Use one, or wait a few minutes for them to expire.")
    #expect(message(429, .rateLimited) == "Too many attempts. Wait a minute, then try again.")
    #expect(
      message(502, .machineUnreachable)
        == "The always-on machine didn't answer. Is it running, and on the same private network?")
    #expect(
      message(404, .notFound, "Unknown device", .revoke) == "That device isn't paired anymore.")
    #expect(
      message(400, .invalidRequest, "✖ must use https (plain http only to loopback)\n  → at url")
        == "url: must use https (plain http only to loopback)")
    #expect(message(400, .invalidRequest) == "The daemon didn't accept that.")
    #expect(message(503, .agentUnavailable, "Can't reach vm-name.") == "Can't reach vm-name.")
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
