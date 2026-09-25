import AppKit
import DailyDoListClient
import DailyDoListModels
import DailyDoListUI
import DailyDoListUITestSupport
import SwiftUI
import Testing

@testable import DailyDoListAgent

/// The agent's work shows read-only when the relay can't reach the always-on machine, this device
/// isn't paired with it (or no longer accepted), another device runs the agent, or the machine
/// isn't running it: a banner (unless the location line says enough), actions disabled with the
/// reason, and the daemon's 503 message when one is tried anyway. The same rules and words as the
/// web app's `readOnlyReason` and `availabilityBanner`.
@MainActor
@Suite("Read-only agent", .serialized)
struct ReadOnlyTests {
  static let synced = " — showing the last synced state"

  // MARK: - When

  @Test func actionsWorkWhereTheAgentRunsOrThroughTheRelay() {
    #expect(AgentReadOnly(placement: nil) == nil)
    #expect(AgentReadOnly(placement: Fixture.placement()) == nil)
    #expect(AgentReadOnly(placement: Fixture.placement(heldHere: .noMachine)) == nil)
    // The daemon forwards actions while the relay connects too.
    for relay in [RelayState.connected, .connecting] {
      #expect(
        AgentReadOnly(
          placement: Fixture.placement(.alwaysOnMachine, runsOn: Fixture.machine, relay: relay))
          == nil, "\(relay)")
      #expect(
        AgentReadOnly(placement: Fixture.placement(.alwaysOnMachine, runsOn: nil, relay: relay))
          == nil, "the machine answers for itself: \(relay)")
    }
  }

  @Test func eachReadOnlyStateSaysWhy() throws {
    let unreachable = AgentReadOnly(
      placement: Fixture.placement(.alwaysOnMachine, runsOn: Fixture.machine, relay: .unreachable),
      problem: "The always-on machine can't be reached.")
    #expect(
      unreachable
        == AgentReadOnly(
          kind: .unreachable, reason: "The always-on machine can't be reached",
          banner: "The always-on machine can't be reached" + Self.synced))

    let unpaired = Fixture.placement(.alwaysOnMachine, runsOn: nil, relay: .notPaired)
    #expect(
      AgentReadOnly(
        placement: unpaired, problem: "This device isn't paired with the always-on machine.")
        == AgentReadOnly(
          kind: .notPaired, reason: "This device isn't paired with the always-on machine",
          banner: "This device isn't paired with the always-on machine" + Self.synced))
    #expect(
      AgentReadOnly(
        placement: unpaired,
        problem: "The always-on machine no longer accepts this device. Pair it again.")
        == AgentReadOnly(
          kind: .rejected, reason: "The always-on machine no longer accepts this device",
          banner: "The always-on machine no longer accepts this device" + Self.synced))

    #expect(
      AgentReadOnly(placement: Fixture.placement(runsOn: Fixture.workLaptop))
        == AgentReadOnly(
          kind: .elsewhere, reason: "The agent is running on Work laptop",
          banner: "The agent is running on Work laptop" + Self.synced))
    let relayedElsewhere = Fixture.placement(
      .alwaysOnMachine, runsOn: Fixture.workLaptop, relay: .connected)
    #expect(
      AgentReadOnly(placement: relayedElsewhere)?.kind == .elsewhere,
      "relayed, but another device runs it")

    #expect(
      AgentReadOnly(placement: Fixture.placement(.alwaysOnMachine, runsOn: nil))
        == AgentReadOnly(
          kind: .idle, reason: "The always-on machine isn't running the agent right now",
          banner: "The always-on machine isn't running the agent right now" + Self.synced))
  }

  @Test func whileTheLocationLineSaysWhyThereIsNoBanner() throws {
    let takingOver = try #require(
      AgentReadOnly(
        placement: Fixture.placement(runsOn: Fixture.machine, note: "Taking over from vm-name…")))
    #expect(takingOver.reason == "The agent is running on vm-name" && takingOver.banner == nil)

    let handingOver = try #require(
      AgentReadOnly(
        placement: Fixture.placement(
          .alwaysOnMachine, runsOn: nil, note: "Handing the agent to vm-name…")))
    #expect(handingOver.kind == .idle && handingOver.banner == nil)

    let connecting = try #require(
      AgentReadOnly(
        placement: Fixture.placement(
          .alwaysOnMachine, runsOn: Fixture.workLaptop, relay: .connecting)))
    #expect(connecting.reason == "The agent is running on Work laptop")
    #expect(connecting.banner == nil)
  }

  // MARK: - The store and the composer

  @Test func aTriedActionSurfacesTheDaemonsReason() async throws {
    var remote = InMemoryDaemonClient.Remote.alwaysOn
    remote.placement = .alwaysOnMachine
    let client = InMemoryDaemonClient(
      seed: .files(["Daily/2026-09-23.md": ""]), clock: .immediate(), clientId: "macos_test",
      remote: remote)
    let store = AgentStore(client: client)
    _ = try await client.writeNote(
      "Daily/2026-09-23.md", content: "- [ ] Book a table\n", baseVersion: .unconditional)
    await store.refresh()
    let approval = try #require(store.pendingApprovals.first)
    #expect(store.readOnly == nil)

    await client.simulateMachine(reachable: false)
    await store.refresh()
    let reason = "The always-on machine can't be reached"
    #expect(store.readOnly?.reason == reason)
    #expect(await store.decide(approval.id, .approve) == false)
    #expect(store.lastError?.message == "The always-on machine can't be reached.")
    #expect(store.approvals[approval.id]?.isPending == true, "the optimistic decision rolled back")

    let composer = ComposerModel(store: store, threadId: try #require(approval.threadId))
    composer.text = "Try the patio"
    #expect(!composer.canSend && composer.unavailableReason == reason)
    #expect(composer.placeholder == "Replies are off while this is read-only")
    #expect(composer.stopUnavailableReason == reason)

    await client.simulateMachine(reachable: true, acceptsThisDevice: false)
    await store.refresh()
    #expect(store.readOnly?.kind == .rejected)
    #expect(store.orchestratorLocation?.pairsAgain == true)
  }

  // MARK: - The views

  private func readOnlyStore() -> AgentStore {
    let store = SampleData.makeStore(now: SnapshotTests.now)
    store.apply(
      .agentStatus(
        Fixture.status(
          placement: Fixture.placement(
            .alwaysOnMachine, runsOn: Fixture.machine, relay: .unreachable))))
    return store
  }

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

  @Test func disabledActionsSayWhy() throws {
    let store = readOnlyStore()
    let found = anchors(
      AgentPanel(
        store: store, selectedThreadId: .constant(SampleData.bookingThreadId),
        onShowInNote: { _ in }
      ).agentReferenceDate(SnapshotTests.now),
      size: CGSize(width: 440, height: 1_400))
    let texts = found.compactMap { $0.tooltipContent() }
    let approve = try #require(texts.first { $0.lines.first?.text == "Approve once is off here" })
    #expect(approve.detail == "The always-on machine can't be reached")
    #expect(texts.contains { $0.lines.first?.text == "Deny is off here" })
    #expect(!texts.contains { $0.lines.first?.text == "Approve once" })
  }

  @Test func aStoppedThreadsRetrySaysWhy() throws {
    let store = readOnlyStore()
    let found = anchors(
      ThreadView(store: store, threadId: SampleData.desksThreadId, tab: .artifacts)
        .agentReferenceDate(SnapshotTests.now),
      size: CGSize(width: 440, height: 600))
    let retry = try #require(found.first { $0.tooltipContent()?.lines.first?.text == "Retry" })
    #expect(retry.tooltipContent()?.detail == "The always-on machine can't be reached")
  }

  @Test(arguments: [false, true])
  func readOnlyPanel(dark: Bool) throws {
    let store = readOnlyStore()
    let view = AgentPanel(
      store: store, selectedThreadId: .constant(SampleData.bookingThreadId), onShowInNote: { _ in }
    ).agentReferenceDate(SnapshotTests.now)
    let rendered = try SnapshotRenderer.render(
      view, name: "thread-read-only", size: CGSize(width: 440, height: 1_100), dark: dark)
    #expect(rendered.bytes > 4_000 && rendered.distinctColors >= 12)
  }
}
