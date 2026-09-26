import AppKit
import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListModels
import DailyDoListUI
import DailyDoListUITestSupport
import SwiftUI
import Testing

@testable import DailyDoListAgent

/// "Where the orchestrator runs": what the control shows in each placement state, moving the
/// orchestrator through the store, and the bar in the agent panel's header.
@MainActor
@Suite("Orchestrator location", .serialized)
struct PlacementTests {
  typealias Location = OrchestratorLocation

  // MARK: - What the control shows

  @Test func nothingShowsWithoutPlacement() {
    #expect(Location(status: nil) == nil)
  }

  @Test func withoutAMachineTheToggleIsDisabledAndSaysWhy() throws {
    let location = try #require(Location(status: Fixture.placement(heldHere: .noMachine)))
    #expect(!location.canSwitch && !location.isHost && location.selection == .thisDevice)
    #expect(location.setUp == .alwaysOnMachine)
    #expect(
      location.line == Location.Line("Runs here until an always-on machine is set up", tone: .faint)
    )
    let tooltip = try #require(location.heldTooltip)
    #expect(tooltip.lines.first?.text == "No always-on machine is set up")
    #expect(tooltip.detail == "Set one up to run the orchestrator there.")

    // The stored choice waits: the control shows where it runs now.
    let chosen = try #require(
      Location(status: Fixture.placement(.alwaysOnMachine, heldHere: .noMachine)))
    #expect(chosen.selection == .thisDevice && !chosen.canSwitch)
    #expect(
      chosen.heldTooltip?.detail
        == "Set one up to run the orchestrator there. It moves there, as you chose, once that's done."
    )

    let noSync = try #require(Location(status: Fixture.placement(heldHere: .noSync)))
    #expect(
      noSync.setUp == .sync && noSync.heldTooltip?.lines.first?.text == "This device doesn't sync")
    #expect(noSync.line?.text == "Runs here until this device syncs")
  }

  /// The real daemon: with sync on and no machine yet, the device that asked first holds the
  /// agent, so this one is held here while another runs it.
  @Test func heldHereWhileAnotherDeviceRunsItNamesThatDevice() throws {
    let location = try #require(
      Location(status: Fixture.placement(heldHere: .noMachine, runsOn: Fixture.workLaptop)))
    #expect(location.line == Location.Line("Work laptop runs the agent now", tone: .faint))
    #expect(location.setUp == .alwaysOnMachine && !location.canSwitch)
    #expect(
      AgentReadOnly(placement: Fixture.placement(heldHere: .noMachine, runsOn: Fixture.workLaptop))?
        .reason == "The agent is running on Work laptop")
  }

  @Test func theHandoverShowsAsItHappens() throws {
    let location = try #require(
      Location(
        status: Fixture.placement(
          .alwaysOnMachine, runsOn: nil, note: "Handing the agent to vm-name…")))
    #expect(location.selection == .alwaysOnMachine && location.canSwitch)
    #expect(
      location.line == Location.Line("Handing the agent to vm-name…", tone: .info, inProgress: true)
    )
    #expect(!location.offersRunHere)
  }

  @Test func anUnreachableMachineOffersToRunHere() throws {
    let location = try #require(
      Location(
        status: Fixture.placement(.alwaysOnMachine, runsOn: Fixture.machine, relay: .unreachable),
        machineName: "vm-name"))
    #expect(location.line == Location.Line("vm-name can't be reached", tone: .warning))
    #expect(location.offersRunHere && location.canSwitch)

    let unpaired = try #require(
      Location(
        status: Fixture.placement(.alwaysOnMachine, runsOn: nil, relay: .notPaired),
        machineName: "vm-name", problem: "This device isn't paired with the always-on machine."))
    #expect(unpaired.line?.text == "This device isn't paired with the always-on machine")
    #expect(unpaired.setUp == .alwaysOnMachine && !unpaired.pairsAgain && !unpaired.offersRunHere)

    let revoked = try #require(
      Location(
        status: Fixture.placement(.alwaysOnMachine, runsOn: nil, relay: .notPaired),
        problem: "The always-on machine no longer accepts this device. Pair it again."))
    #expect(revoked.line?.text == "The always-on machine no longer accepts this device")
    #expect(revoked.setUp == .alwaysOnMachine && revoked.pairsAgain)

    let connecting = try #require(
      Location(status: Fixture.placement(.alwaysOnMachine, runsOn: nil, relay: .connecting)))
    #expect(connecting.line?.text == "Connecting to the always-on machine…")
    let connected = try #require(
      Location(
        status: Fixture.placement(.alwaysOnMachine, runsOn: Fixture.machine, relay: .connected)))
    #expect(connected.line == nil, "calm while it works")
  }

  @Test func theAlwaysOnMachineSaysSo() throws {
    let host = AgentRunsOn(
      deviceId: "dev_vm", name: "vm-name", thisDevice: true, alwaysOnMachine: true)
    let location = try #require(Location(status: Fixture.placement(.alwaysOnHost, runsOn: host)))
    #expect(location.isHost && !location.canSwitch && location.line == nil)
    let takenOver = try #require(
      Location(status: Fixture.placement(.alwaysOnHost, runsOn: Fixture.workLaptop)))
    #expect(takenOver.line?.text == "Work laptop runs the agent now")
  }

  @Test func anotherDeviceRunningTheAgentIsNamed() throws {
    let location = try #require(Location(status: Fixture.placement(runsOn: Fixture.workLaptop)))
    #expect(location.line == Location.Line("Work laptop runs the agent now", tone: .faint))
  }

  @Test func aPendingChangeShowsAtOnceAndLocksTheControl() throws {
    let location = try #require(
      Location(status: Fixture.placement(), pending: .alwaysOnMachine))
    #expect(location.selection == .alwaysOnMachine && location.isSwitching && !location.canSwitch)
  }

  // MARK: - Moving the orchestrator

  @Test func movingSendsTheChangeAndFollowsTheHandover() async throws {
    let client = InMemoryDaemonClient(
      seed: .empty, clock: .manual(), clientId: "macos_test", remote: .alwaysOn)
    let store = AgentStore(client: client)
    let events = Task { @MainActor in for await item in client.events() { store.handle(item) } }
    defer { events.cancel() }
    await client.connect()
    await store.refresh()
    #expect(store.canMoveOrchestrator(to: .alwaysOnMachine))
    #expect(!store.canMoveOrchestrator(to: .thisDevice), "already there")

    #expect(await store.moveOrchestrator(to: .alwaysOnMachine))
    #expect(store.pendingPlacement == nil)
    #expect(store.placement?.note == "Handing the agent to vm-name…")
    #expect(store.orchestratorLocation?.selection == .alwaysOnMachine)
    await client.advance(by: .seconds(2))
    #expect(await eventually { store.placement?.runsOn?.name == "vm-name" })
    #expect(store.placement?.note == nil && store.placement?.relay == .connected)

    await client.simulateMachine(reachable: false)
    #expect(await eventually { store.orchestratorLocation?.offersRunHere == true })
    #expect(await store.moveOrchestrator(to: .thisDevice))
    #expect(store.placement?.note == "Taking over from vm-name…")
    await client.disconnect()
  }

  @Test func whileHeldHereNothingIsSent() async throws {
    let client = FakeDaemonClient()
    client.script {
      $0.agentStatus = { Fixture.status(placement: Fixture.placement(heldHere: .noSync)) }
    }
    let store = AgentStore(client: client)
    await store.refresh()
    #expect(!store.canMoveOrchestrator(to: .alwaysOnMachine))
    #expect(await store.moveOrchestrator(to: .alwaysOnMachine) == false)
    #expect(client.calls("updateDeviceSettings").count == 0)
  }

  @Test func aRefusedChangeSaysWhy() async throws {
    let client = FakeDaemonClient()
    let gate = Gate()
    client.script {
      $0.agentStatus = { Fixture.status(placement: Fixture.placement()) }
      $0.updateDeviceSettings = { _ in
        await gate.wait()
        throw DaemonClientError.http(
          status: 409,
          body: ApiErrorBody(
            error: .lockedByEnv, message: "The placement is set by DDL_AGENT_PLACEMENT."))
      }
    }
    let store = AgentStore(client: client)
    await store.refresh()
    let move = Task { await store.moveOrchestrator(to: .alwaysOnMachine) }
    #expect(await waitForArrivals(gate))
    #expect(store.pendingPlacement == .alwaysOnMachine)
    #expect(store.orchestratorLocation?.selection == .alwaysOnMachine)
    #expect(store.orchestratorLocation?.canSwitch == false)
    await gate.open()
    #expect(await move.value == false)
    #expect(store.pendingPlacement == nil && store.orchestratorLocation?.selection == .thisDevice)
    #expect(store.lastError?.title == "Couldn't move the orchestrator to the always-on machine")
    #expect(store.lastError?.message == "The placement is set by DDL_AGENT_PLACEMENT.")
    #expect(client.calls.contains("updateDeviceSettings:always_on_machine"))
  }

  // MARK: - The bar in the header

  private func anchors<V: View>(_ view: V, size: CGSize) -> [TooltipAnchorView] {
    let host = NSHostingView(
      rootView: view.frame(width: size.width, height: size.height)
        .environment(\.tooltipCenter, QuietTooltips.makeCenter()))
    host.frame = CGRect(origin: .zero, size: size)
    let window = NSWindow(
      contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = host
    window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
    window.orderFrontRegardless()
    for _ in 0..<4 {
      host.layoutSubtreeIfNeeded()
      window.displayIfNeeded()
      RunLoop.main.run(until: Date().addingTimeInterval(0.02))
    }
    let anchors = tooltipAnchors(in: host)
    window.close()
    return anchors
  }

  private func panel(
    _ placement: AgentPlacementStatus, problem: String? = nil, opened: Locked<[Location.SetUp]>
  ) -> some View {
    let store = SampleData.makeStore(now: SnapshotTests.now)
    store.apply(.agentStatus(Fixture.status(problem: problem, placement: placement)))
    return AgentPanel(
      store: store, selectedThreadId: .constant(nil),
      shortcuts: AgentPanelShortcuts(
        runHere: .init(id: "agent.runHere"), runOnMachine: .init(id: "agent.runOnMachine")),
      placementActions: AgentPlacementActions(openSetUp: { setUp in
        opened.mutate { $0.append(setUp) }
      })
    ).agentReferenceDate(SnapshotTests.now)
  }

  @Test func theDisabledToggleExplainsItselfAndOffersTheSetUp() throws {
    let opened = Locked<[Location.SetUp]>([])
    let found = anchors(
      panel(Fixture.placement(heldHere: .noMachine), opened: opened),
      size: CGSize(width: 400, height: 500))
    let toggle = try #require(
      found.first { $0.tooltipContent()?.lines.first?.text == "No always-on machine is set up" })
    #expect(toggle.tooltipContent()?.detail == "Set one up to run the orchestrator there.")
    #expect(found.contains { $0.tooltipContent()?.plainText == "Set up the always-on machine" })
    for anchor in found {
      let text = anchor.tooltipContent()?.plainText ?? ""
      #expect(!text.contains { "⌘⌥⌃⇧".contains($0) }, "\(text)")
    }
  }

  @Test func aRevokedDeviceOffersToPairAgain() throws {
    let opened = Locked<[Location.SetUp]>([])
    let found = anchors(
      panel(
        Fixture.placement(.alwaysOnMachine, runsOn: nil, relay: .notPaired),
        problem: "The always-on machine no longer accepts this device. Pair it again.",
        opened: opened),
      size: CGSize(width: 400, height: 500))
    #expect(
      found.contains {
        $0.tooltipContent()?.plainText == "Pair this device with the always-on machine again"
      })
  }

  @Test func runHereRunsTheHostsCommand() throws {
    let found = anchors(
      panel(
        Fixture.placement(.alwaysOnMachine, runsOn: Fixture.machine, relay: .unreachable),
        opened: Locked([])),
      size: CGSize(width: 400, height: 500))
    let runHere = try #require(
      found.first {
        $0.tooltipContent()?.lines.first?.text == "Run the orchestrator on this device instead"
      })
    #expect(runHere.command == "agent.runHere")
  }

  /// The switch's tooltip says what flipping it does, and names the host's command for that.
  @Test func theRemoteSwitchSaysWhatFlippingItDoes() throws {
    func remote(_ placement: AgentPlacementStatus) throws -> TooltipAnchorView {
      let found = anchors(
        panel(placement, opened: Locked([])), size: CGSize(width: 400, height: 500))
      return try #require(
        found.first { $0.tooltipContent()?.plainText.hasPrefix("Run the orchestrator on") == true }
      )
    }
    let off = try remote(Fixture.placement())
    #expect(off.tooltipContent()?.plainText == "Run the orchestrator on your always-on machine")
    #expect(off.command == "agent.runOnMachine")
    let on = try remote(Fixture.placement(.alwaysOnMachine, runsOn: Fixture.machine))
    #expect(on.tooltipContent()?.plainText == "Run the orchestrator on this device")
    #expect(on.command == "agent.runHere")
  }
}
