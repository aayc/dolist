import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListMobileSettings

@Suite("Mobile settings patches")
struct SettingsDraftTests {
  @Test func sendsOnlyChangedLeavesAndWholeMachineValues() throws {
    let initial = AppSettings.defaults
    var changed = initial
    changed.editor.vimrc = "set number"
    changed.agent.judgeModel = "synthetic/judge"
    changed.agent.watch.pastDays = 2
    changed.remote.alwaysOnMachine = AlwaysOnMachine(
      name: "Synthetic host", url: "https://host.example.invalid")
    let patch = try SettingsDraft.patch(from: initial, to: changed)
    #expect(patch.editor == .init(vimrc: "set number"))
    #expect(patch.agent == .init(judgeModel: "synthetic/judge", watch: .init(pastDays: 2)))
    #expect(patch.remote?.alwaysOnMachine == .set(changed.remote.alwaysOnMachine!))
    #expect(patch.theme == nil && patch.dailyNotes == nil && patch.weeklyNotes == nil)
    #expect(initial.applying(patch) == changed)
    var renamed = changed
    renamed.remote.alwaysOnMachine?.name = "Renamed host"
    let renamedPatch = try SettingsDraft.patch(from: changed, to: renamed)
    #expect(renamedPatch.remote?.alwaysOnMachine == .set(renamed.remote.alwaysOnMachine!))
    renamed.remote.alwaysOnMachine = nil
    #expect(try SettingsDraft.patch(from: changed, to: renamed).remote?.alwaysOnMachine == .clear)
  }

  @Test func unchangedDecodedFallbacksNeverOverwriteFutureDaemonChoices() throws {
    var value = try JSONDecoder().decode(
      JSONValue.self, from: JSONEncoder().encode(AppSettings.defaults))
    if case .object(var object) = value, case .object(var agent) = object["agent"] {
      agent["harness"] = .string("future_harness")
      agent["approvalPolicy"] = .string("future_policy")
      object["agent"] = .object(agent)
      value = .object(object)
    }
    let decoded = try JSONDecoder().decode(AppSettings.self, from: JSONEncoder().encode(value))
    var changed = decoded
    changed.agent.settleMs = 1000
    let patch = try SettingsDraft.patch(from: decoded, to: changed)
    #expect(patch.agent == .init(settleMs: 1000))
  }

  @Test func allPolicyWideningsRequireConfirmation() {
    let policies = ApprovalPolicy.allCases
    for (fromIndex, from) in policies.enumerated() {
      for (toIndex, to) in policies.enumerated() {
        #expect(MobileApprovalPolicy.widens(from: from, to: to) == (toIndex > fromIndex))
      }
    }
  }
}

@MainActor
@Suite("Mobile settings acknowledgement and host isolation")
struct MobileSettingsStoreTests {
  private func store(_ client: FakeDaemonClient) -> MobileSettingsStore {
    let store = MobileSettingsStore()
    store.configure(
      client: client, hostID: "host-a/session-1", hostName: "Synthetic host A", settings: .defaults,
      enabled: true)
    return store
  }

  @Test func settingsRequireAcknowledgementAndPolicyConsentIsBoundToCurrentPolicy() async {
    let client = FakeDaemonClient()
    let store = store(client)
    var saved: [AppSettings] = []
    store.onSettingsSaved = { saved.append($0) }
    let widening = SettingsPatch(agent: .init(approvalPolicy: .runEverything))
    #expect(await store.save(widening) == false)
    #expect(client.withState { $0.calls.isEmpty })
    #expect(
      await store.save(widening, consent: PolicyConsent(from: .askEveryAction, to: .runEverything))
        == false)
    #expect(await store.save(widening, consent: PolicyConsent(from: .askRisky, to: .runEverything)))
    #expect(store.settings?.agent.approvalPolicy == .runEverything)
    #expect(saved.count == 1)
    client.withState { $0.failures["updateSettings"] = .unreachable("synthetic offline") }
    #expect(await store.save(SettingsPatch(theme: .light)) == false)
    #expect(store.settings?.theme == .dark)
    #expect(saved.count == 1)
    client.withState { $0.failures = [:] }
    store.configure(
      client: client, hostID: "host-a/session-1", hostName: "Synthetic host A",
      settings: store.settings, enabled: false)
    #expect(await store.save(SettingsPatch(theme: .light)) == false)
    #expect(client.withState { $0.calls.filter { $0 == "updateSettings" }.count } == 2)
  }

  @Test func replacedHostDiscardsLateDeviceResponseAndDoesNotReplay() async {
    let client = FakeDaemonClient()
    let gate = ResponseGate<DeviceSettingsResponse>()
    client.script { $0.updateDeviceSettings = { _ in await gate.response() } }
    let store = store(client)
    let action = Task { await store.updateDevice(.init(name: "Old host rename")) }
    await gate.waitUntilRequested()
    let nextClient = FakeDaemonClient()
    store.configure(
      client: nextClient, hostID: "host-b/session-2", hostName: "Synthetic host B",
      settings: .defaults, enabled: true)
    await gate.complete(
      DeviceSettingsResponse(
        device: .init(id: "old", name: "Old host rename"), placement: .thisDevice, remoteHosts: [],
        sync: .init(url: nil, vault: nil, hasToken: false)))
    #expect(await action.value == false)
    #expect(store.device == nil)
    #expect(store.hostName == "Synthetic host B")
    #expect(nextClient.withState { $0.calls.isEmpty })
  }

  @Test func liveSessionGuardBlocksActionsAndLateResponsesEvenBeforeViewRefresh() async {
    let client = FakeDaemonClient()
    let gate = ResponseGate<PairingCodeResponse>()
    client.script { $0.createPairingCode = { _ in await gate.response() } }
    let store = store(client)
    let session = SessionValidity()
    store.isCurrentSession = { session.current }
    let action = Task { await store.createCode(name: "Synthetic phone") }
    await gate.waitUntilRequested()
    session.current = false
    await gate.complete(
      PairingCodeResponse(code: "ABCD2345", expiresAt: 2_000_000_000_000, url: nil))
    await action.value
    #expect(store.code == nil)
    #expect(!store.canMutate)
    #expect(await store.save(SettingsPatch(theme: .light)) == false)
    #expect(client.withState { !$0.calls.contains("updateSettings") })
  }
}

private actor ResponseGate<Value: Sendable> {
  private var continuation: CheckedContinuation<Value, Never>?
  private var started: CheckedContinuation<Void, Never>?
  func response() async -> Value {
    await withCheckedContinuation {
      continuation = $0
      started?.resume()
      started = nil
    }
  }
  func waitUntilRequested() async {
    if continuation != nil { return }
    await withCheckedContinuation { started = $0 }
  }
  func complete(_ value: Value) {
    continuation?.resume(returning: value)
    continuation = nil
  }
}

@MainActor
private final class SessionValidity { var current = true }
