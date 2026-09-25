import AppKit
import DailyDoListClient
import DailyDoListModels
import DailyDoListUI
import DailyDoListUITestSupport
import SwiftUI
import Testing

@testable import DailyDoListAgent

/// The agent's work shows read-only when the always-on machine can't be reached (or this device
/// isn't paired with it), another device runs the agent, or it's moving: a banner, actions
/// disabled with the reason, and the daemon's 503 message when one is tried anyway.
@MainActor
@Suite("Read-only agent", .serialized)
struct ReadOnlyTests {
  // MARK: - When

  @Test func actionsWorkWhereTheAgentRunsOrIsRelayed() {
    #expect(AgentReadOnly(placement: nil) == nil)
    #expect(AgentReadOnly(placement: Fixture.placement()) == nil)
    #expect(AgentReadOnly(placement: Fixture.placement(heldHere: .noMachine)) == nil)
    #expect(
      AgentReadOnly(
        placement: Fixture.placement(.alwaysOnMachine, runsOn: Fixture.machine, relay: .connected))
        == nil)
  }

  @Test func eachReadOnlyStateSaysWhy() throws {
    let unreachable = try #require(
      AgentReadOnly(
        placement: Fixture.placement(.alwaysOnMachine, runsOn: Fixture.machine, relay: .unreachable)
      ))
    #expect(unreachable.reason == "Can't reach vm-name")
    #expect(unreachable.banner.hasPrefix("Read-only: this is the last synced copy."))

    let unpaired = try #require(
      AgentReadOnly(
        placement: Fixture.placement(.alwaysOnMachine, runsOn: nil, relay: .notPaired),
        machineName: "vm-name"))
    #expect(unpaired.reason == "Not paired with vm-name")

    let elsewhere = try #require(
      AgentReadOnly(placement: Fixture.placement(runsOn: Fixture.workLaptop)))
    #expect(elsewhere.reason == "Work laptop runs the agent")
    #expect(elsewhere.banner == "Read-only: Work laptop runs the agent. Approve and reply there.")

    let moving = try #require(
      AgentReadOnly(placement: Fixture.placement(note: "Taking over from vm-name…")))
    #expect(moving.reason == "The agent is moving")

    let connecting = try #require(
      AgentReadOnly(placement: Fixture.placement(.alwaysOnMachine, runsOn: nil, relay: .connecting))
    )
    #expect(connecting.reason == "Connecting to the always-on machine")
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
    #expect(store.readOnly?.reason == "Can't reach vm-name")
    #expect(await store.decide(approval.id, .approve) == false)
    #expect(store.lastError?.message == "Can't reach vm-name. Its work shows here read-only.")
    #expect(store.approvals[approval.id]?.isPending == true, "the optimistic decision rolled back")

    let composer = ComposerModel(store: store, threadId: try #require(approval.threadId))
    composer.text = "Try the patio"
    #expect(!composer.canSend && composer.unavailableReason == "Can't reach vm-name")
    #expect(composer.placeholder == "Replies are off while this is read-only")
    #expect(composer.stopUnavailableReason == "Can't reach vm-name")
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
    #expect(approve.detail == "Can't reach vm-name")
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
    #expect(retry.tooltipContent()?.detail == "Can't reach vm-name")
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
