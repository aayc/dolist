import Foundation
import Testing

@testable import DailyDoListComputer

@Suite("Snapshots")
struct SnapshotTests {
  @Test func readsTheFocusedWindow() async throws {
    let harness = Harness()
    harness.runChat()
    let snapshot = try await harness.makeService().result("snapshot", ["pid": 42])

    #expect(snapshot.string("snapshotId") == "s1")
    #expect(snapshot.object("app") == ["name": "Chat", "bundleId": "com.example.chat", "pid": 42])
    #expect(
      snapshot.object("window") == [
        "title": "Chat", "frame": ["x": 100, "y": 100, "width": 800, "height": 600],
      ])
    #expect(
      snapshot.string("text")?.hasPrefix(#"[e1] AXWindow subrole=AXStandardWindow name="Chat""#)
        == true)
    #expect(snapshot.objects("elements").map { $0.string("id") } == ["e1", "e2", "e3", "e4", "e5"])
    #expect(snapshot.objects("elements")[3].string("name") == "Send")
    #expect(snapshot.bool("truncated") == false)
  }

  @Test func fallsBackToTheMainWindowThenTheFirstThenTheApp() async throws {
    let harness = Harness()
    harness.run(pid: 1, name: "One", bundleId: "com.example.one")
    harness.accessibility.installApp(
      pid: 1, windows: [Node("AXWindow", title: "First"), Node("AXWindow", title: "Main")],
      focused: nil, main: 1)
    harness.run(pid: 2, name: "Two", bundleId: "com.example.two")
    harness.accessibility.installApp(
      pid: 2, windows: [Node("AXWindow", title: "Only")], focused: nil, main: nil)
    harness.run(pid: 3, name: "Three", bundleId: "com.example.three")
    harness.accessibility.installApp(
      pid: 3, windows: [], extraChildren: [Node("AXMenuBar", title: "Menu")])
    let service = harness.makeService()

    #expect(
      try await service.result("snapshot", ["pid": 1]).object("window")?.string("title") == "Main")
    #expect(
      try await service.result("snapshot", ["pid": 2]).object("window")?.string("title") == "Only")
    let windowless = try await service.result("snapshot", ["pid": 3])
    #expect(windowless["window"] == .null)
    #expect(
      windowless.string("text") == """
        [e1] AXApplication
          [e2] AXMenuBar name="Menu"
        """)
  }

  @Test func expandingAnElementJoinsTheSameSnapshot() async throws {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    let first = try await service.result("snapshot", ["pid": 42, "maxDepth": 1])
    #expect(first.string("text")?.contains("[e2] AXGroup (+2 descendants omitted)") == true)
    #expect(first.bool("truncated") == true)

    let expanded = try await service.result(
      "snapshot", ["pid": 42, "snapshotId": "s1", "elementId": "e2"])
    #expect(expanded.string("snapshotId") == "s1")
    #expect(
      expanded.string("text") == """
        [e2] AXGroup
          [e4] AXTextField name="Ask anything" settable actions=confirm
          [e5] AXButton name="Send" actions=press,show-menu
        """)
    #expect(expanded.objects("elements").map { $0.string("id") } == ["e2", "e4", "e5"])
    #expect(expanded.bool("truncated") == false)

    // The new ids work with the same snapshot id, and the old ones still do.
    let pressed = try await service.result(
      "press", ["pid": 42, "snapshotId": "s1", "elementId": "e5"])
    #expect(pressed == ["ok": true, "stale": true])
    #expect(harness.accessibility.recorded.contains(.perform(key: "send", action: "AXPress")))
  }

  @Test func actingRetiresTheSnapshot() async throws {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    _ = try await service.result("snapshot", ["pid": 42])

    #expect(
      try await service.result("press", ["pid": 42, "snapshotId": "s1", "elementId": "e4"])
        == ["ok": true, "stale": true])
    let again = await service.failure("press", ["pid": 42, "snapshotId": "s1", "elementId": "e4"])
    #expect(again?.code == .stale)
    #expect(try await service.result("snapshot", ["pid": 42]).string("snapshotId") == "s2")
    #expect(
      try await service.result("key", ["pid": 42, "combo": "return"]) == [
        "ok": true, "stale": true,
      ])
    #expect(
      try await service.result("key", ["pid": 42, "combo": "return"]) == [
        "ok": true, "stale": false,
      ])
  }

  @Test func anOldSnapshotIsStaleAndAnUnknownElementIsNotFound() async throws {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    _ = try await service.result("snapshot", ["pid": 42])
    _ = try await service.result("snapshot", ["pid": 42])

    #expect(
      await service.failure("press", ["pid": 42, "snapshotId": "s1", "elementId": "e4"])?.code
        == .stale)
    #expect(
      await service.failure("press", ["pid": 42, "snapshotId": "s9", "elementId": "e4"])?.code
        == .stale)
    #expect(
      await service.failure("press", ["pid": 42, "snapshotId": "s2", "elementId": "e99"])?.code
        == .notFound)
    #expect(
      await service.failure("snapshot", ["pid": 42, "snapshotId": "s1", "elementId": "e2"])?.code
        == .stale)
    #expect(
      harness.accessibility.recorded.allSatisfy { if case .perform = $0 { false } else { true } })
  }

  @Test func anElementThatIsGoneOrHasChangedIsStale() async throws {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    _ = try await service.result("snapshot", ["pid": 42])
    harness.accessibility.update("send") { $0.attributes[AX.title] = .string("Delete") }
    let changed = await service.failure(
      "press", ["pid": 42, "snapshotId": "s1", "elementId": "e4"])
    #expect(changed == .stale("e4 has changed since the snapshot: read the app again."))

    _ = try await service.result("snapshot", ["pid": 42])
    harness.accessibility.update("send") { $0.gone = true }
    let gone = await service.failure("press", ["pid": 42, "snapshotId": "s2", "elementId": "e4"])
    #expect(gone == .stale("e4 is gone: read the app again."))
    #expect(
      harness.accessibility.recorded.allSatisfy { if case .perform = $0 { false } else { true } })
  }

  @Test func turnsOnElectronAccessibilityOnce() async throws {
    let harness = Harness()
    harness.accessibility.appSettable = [AX.manualAccessibility]
    harness.runChat()
    let service = harness.makeService()
    _ = try await service.result("snapshot", ["pid": 42])
    _ = try await service.result("snapshot", ["pid": 42])

    let switches = harness.accessibility.recorded.filter {
      $0 == .set(key: "app-42", attribute: AX.manualAccessibility, value: .bool(true))
    }
    #expect(switches.count == 1)
    #expect(harness.clock.sleeps == [.milliseconds(500)])
  }

  @Test func reportsAppsThatDontAnswerOrHaveQuit() async throws {
    let harness = Harness()
    harness.runChat()
    harness.run(pid: 43, name: "Ghost", bundleId: "com.example.ghost")
    harness.accessibility.updateApp(pid: 42) { $0.hung = true }
    let service = harness.makeService()

    let hung = await service.failure("snapshot", ["pid": 42])
    #expect(
      hung == .failed("Chat isn't responding to accessibility requests. Try again in a moment."))
    #expect(await service.failure("snapshot", ["pid": 43]) == .notFound("Ghost quit."))
    #expect(
      await service.failure("snapshot", ["pid": 44]) == .notFound("No app is running with pid 44."))
  }

  @Test func needsAccessibility() async {
    var harness = Harness()
    harness.permissions.accessibilityGranted = false
    harness.runChat()
    let error = await harness.makeService().failure("snapshot", ["pid": 42])
    #expect(error?.code == .permission)
    #expect(error?.message.contains("Accessibility") == true)
    #expect(harness.accessibility.recorded.isEmpty)
  }

  @Test func validatesItsParams() async {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    for params: JSONObject in [
      ["pid": 42, "elementId": "e2"], ["pid": 42, "snapshotId": "s1"], ["pid": 42, "maxNodes": 0],
      ["pid": 42, "maxNodes": 2_001], ["pid": 42, "maxDepth": -1], ["pid": 42, "depth": 3], [:],
    ] {
      #expect(await service.failure("snapshot", params)?.code == .invalid, "\(params)")
    }
    #expect(harness.accessibility.recorded.isEmpty)
  }
}
