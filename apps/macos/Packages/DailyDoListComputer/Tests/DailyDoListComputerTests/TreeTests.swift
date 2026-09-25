import Foundation
import Testing

@testable import DailyDoListComputer

@Suite("Tree walking and formatting")
struct TreeTests {
  let accessibility = FakeAccessibility()
  let clock = FakeClock()

  private func walk(
    _ window: Node, maxNodes: Int = 400, maxDepth: Int = 30, budget: Duration = .seconds(60)
  ) throws -> (result: WalkResult, text: String, ids: [Int: String]) {
    accessibility.installApp(pid: 42, windows: [window])
    return try walkInstalled(maxNodes: maxNodes, maxDepth: maxDepth, budget: budget)
  }

  /// Walks the window (key "window") installed already.
  private func walkInstalled(
    maxNodes: Int = 400, maxDepth: Int = 30, budget: Duration = .seconds(60)
  ) throws -> (result: WalkResult, text: String, ids: [Int: String]) {
    let root = accessibility.element("window")
    let walker = TreeWalker(api: accessibility, clock: clock) { _ in }
    let result = try walker.walk(
      from: root,
      limits: WalkLimits(maxNodes: maxNodes, maxDepth: maxDepth, deadline: clock.now + budget))
    var snapshot = Snapshot(
      id: "s1", app: AppSummary(name: "Chat", bundleId: nil, pid: 42), window: nil, root: root)
    let ids = snapshot.adopt(result)
    return (result, TreeFormatter.render(result, ids: ids), ids)
  }

  @Test func rendersOneIndentedLinePerElementInDocumentOrder() throws {
    let (result, text, _) = try walk(chatWindow())
    #expect(
      text == """
        [e1] AXWindow subrole=AXStandardWindow name="Chat"
          [e2] AXGroup
            [e3] AXTextField name="Ask anything" settable actions=confirm
            [e4] AXButton name="Send" actions=press,show-menu
          [e5] AXStaticText value="Hello there"
        """)
    #expect(!result.truncated)
  }

  @Test func namesComeFromTheFirstNonEmptySourceInOrder() throws {
    let cases: [([String: AccessibilityValue], String)] = [
      ([AX.title: .string("T"), AX.description: .string("D")], "T"),
      ([AX.title: .string("  "), AX.description: .string("D"), AX.help: .string("H")], "D"),
      ([AX.label: .string("L"), AX.placeholder: .string("P")], "L"),
      ([AX.labelValue: .string("LV"), AX.help: .string("H")], "LV"),
      ([AX.placeholder: .string("P"), AX.help: .string("H")], "P"),
      ([AX.help: .string("H")], "H"),
    ]
    let window = Node(
      "AXWindow", key: "window",
      children: cases.enumerated().map { index, entry in
        Node("AXButton", key: "b\(index)", attributes: entry.0)
      })
    let (result, _, _) = try walk(window)
    #expect(result.nodes.dropFirst().map(\.info.name) == cases.map(\.1))
  }

  @Test func secureTextFieldsAreMaskedAndTheirValuesNeverRead() throws {
    let window = Node(
      "AXWindow", key: "window",
      children: [
        Node(
          "AXTextField", key: "password", value: .string("hunter2"), settable: [AX.value],
          attributes: [AX.subrole: .string("AXSecureTextField"), AX.title: .string("Password")]),
        Node("AXSecureTextField", key: "pin", value: .string("1234")),
      ])
    let (result, text, _) = try walk(window)
    #expect(
      text.contains(
        #"[e2] AXTextField subrole=AXSecureTextField name="Password" value=••• settable"#))
    #expect(text.contains("[e3] AXSecureTextField value=•••"))
    #expect(!text.contains("hunter2") && !text.contains("1234"))
    #expect(result.nodes.allSatisfy { $0.info.value != "hunter2" && $0.info.value != "1234" })
    let reads = accessibility.recorded.compactMap { call -> [String]? in
      guard case .read(let key, let attributes) = call, key == "password" || key == "pin" else {
        return nil
      }
      return attributes
    }
    #expect(!reads.isEmpty)
    #expect(reads.allSatisfy { !$0.contains(AX.value) }, "AXValue was requested: \(reads)")
    #expect(
      TreeFormatter.elementJSON(id: "e2", info: result.nodes[1].info).objectValue?.string("value")
        == "•••")
  }

  @Test func capsNamesAndValues() throws {
    let window = Node(
      "AXWindow", key: "window",
      children: [
        Node(
          "AXStaticText", key: "long", title: String(repeating: "n", count: 300),
          value: .string(String(repeating: "v", count: 500)))
      ])
    let info = try walk(window).result.nodes[1].info
    #expect(info.name == String(repeating: "n", count: 119) + "…")
    #expect(info.value == String(repeating: "v", count: 199) + "…")
  }

  @Test func escapesQuotesAndLineBreaksToKeepOneLinePerElement() throws {
    let window = Node(
      "AXWindow", key: "window",
      children: [
        Node("AXStaticText", key: "text", value: .string("say \"hi\"\nthen\tgo \\ \u{2028}"))
      ])
    let (_, text, _) = try walk(window)
    #expect(text.split(separator: "\n").count == 2)
    #expect(text.hasSuffix(#"[e2] AXStaticText value="say \"hi\"\nthen\tgo \\ \u2028""#))
  }

  @Test func marksSubtreesCutByDepth() throws {
    let window = Node(
      "AXWindow", key: "window",
      children: [
        Node(
          "AXGroup", key: "group",
          children: [Node("AXButton", title: "A"), Node("AXButton", title: "B"), Node("AXButton")])
      ])
    let (result, text, _) = try walk(window, maxDepth: 1)
    #expect(
      text == """
        [e1] AXWindow
          [e2] AXGroup (+3 descendants omitted)
        """)
    #expect(result.truncated)
  }

  @Test func marksSubtreesCutByTheNodeBudget() throws {
    let window = Node(
      "AXWindow", key: "window",
      children: [
        Node("AXGroup", title: "one", children: [Node("AXButton"), Node("AXButton")]),
        Node("AXGroup", title: "two", children: [Node("AXButton")]),
        Node("AXGroup", title: "three"),
      ])
    let (result, text, _) = try walk(window, maxNodes: 3)
    #expect(
      text == """
        [e1] AXWindow (+1 descendants omitted)
          [e2] AXGroup name="one" (+2 descendants omitted)
          [e3] AXGroup name="two" (+1 descendants omitted)
        """)
    #expect(result.truncated)
  }

  @Test func theBudgetCoversTheWholeWindowBeforeADeepBranch() throws {
    var deep = Node("AXGroup", title: "level 10")
    for level in (1..<10).reversed() {
      deep = Node("AXGroup", title: "level \(level)", children: [deep])
    }
    let window = Node(
      "AXWindow", key: "window",
      children: [
        Node("AXGroup", title: "sidebar", children: [deep]),
        Node("AXTextField", title: "Message", settable: [AX.value]),
        Node("AXButton", title: "Send", actions: ["AXPress"]),
      ])
    let (_, text, _) = try walk(window, maxNodes: 6)
    #expect(text.contains(#"name="Message""#))
    #expect(text.contains(#"name="Send""#))
    #expect(text.contains(#"name="level 2" (+1 descendants omitted)"#))
    #expect(!text.contains("level 3"))
  }

  @Test func readsAnElementMetTwiceOnlyOnce() throws {
    let window = Node(
      "AXWindow", key: "window",
      children: [Node("AXGroup", key: "group", children: [Node("AXButton", key: "button")])])
    accessibility.installApp(pid: 42, windows: [window])
    accessibility.link("window", under: "group")
    accessibility.link("button", under: "window")
    let result = try walkInstalled().result
    #expect(result.nodes.map(\.info.role) == ["AXWindow", "AXGroup", "AXButton"])
  }

  @Test func stopsAtTheDeadline() throws {
    clock.tick = .milliseconds(100)
    let window = Node(
      "AXWindow", key: "window",
      children: (1...50).map { Node("AXButton", title: "b\($0)") })
    let (result, text, _) = try walk(window, budget: .seconds(1))
    #expect(result.truncated)
    #expect(result.nodes.count < 20)
    #expect(text.hasPrefix("[e1] AXWindow (+"))
  }

  @Test func leavesOutElementsThatVanishDuringTheWalk() throws {
    let window = Node(
      "AXWindow", key: "window",
      children: [Node("AXButton", key: "gone", title: "Gone"), Node("AXButton", title: "Here")])
    accessibility.installApp(pid: 42, windows: [window])
    accessibility.update("gone") { $0.gone = true }
    let result = try walkInstalled().result
    #expect(result.nodes.map(\.info.name) == [nil, "Here"])
    #expect(!result.truncated)
  }

  @Test func keepsOnlyTheActionsThePressMethodSupports() throws {
    let window = Node(
      "AXWindow", key: "window",
      children: [
        Node(
          "AXButton", key: "button", title: "Reply",
          actions: ["AXRaise", "Name:Reply\nTarget:0x0\nSelector:(null)", "AXShowMenu", "AXPress"])
      ])
    let info = try walk(window).result.nodes[1].info
    #expect(info.actions == ["press", "show-menu", "raise"])
  }

  @Test func describesElementsAsJSON() throws {
    let window = Node(
      "AXWindow", key: "window",
      children: [
        Node(
          "AXButton", key: "send", title: "Send", frame: Rect(x: 1, y: 2.5, width: 30, height: 20),
          actions: ["AXPress"], attributes: [AX.enabled: .bool(false), AX.focused: .bool(true)])
      ])
    let (result, text, ids) = try walk(window)
    #expect(text.hasSuffix(#"[e2] AXButton name="Send" focused disabled actions=press"#))
    let json = TreeFormatter.elementJSON(id: ids[1] ?? "?", info: result.nodes[1].info)
    #expect(
      json == [
        "id": "e2", "role": "AXButton", "name": "Send", "settable": false, "actions": ["press"],
        "frame": ["x": 1, "y": 2.5, "width": 30, "height": 20], "enabled": false,
        "focused": true,
      ])
  }
}
