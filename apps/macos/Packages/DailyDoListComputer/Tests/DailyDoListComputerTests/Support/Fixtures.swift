import Foundation

@testable import DailyDoListComputer

typealias Node = FakeAccessibility.Node

/// A small chat app window: a text field and a send button in a group, and a message.
func chatWindow(title: String = "Chat", frame: Rect = Rect(x: 100, y: 100, width: 800, height: 600))
  -> Node
{
  Node(
    "AXWindow", key: "window", title: title, frame: frame,
    attributes: [AX.subrole: .string("AXStandardWindow")],
    children: [
      Node(
        "AXGroup", key: "composer",
        children: [
          Node(
            "AXTextField", key: "field", frame: Rect(x: 120, y: 640, width: 600, height: 30),
            actions: ["AXConfirm"], settable: [AX.value, AX.focused],
            attributes: [AX.placeholder: .string("Ask anything"), AX.value: .string("")]),
          Node(
            "AXButton", key: "send", title: "Send",
            frame: Rect(x: 730, y: 640, width: 60, height: 30),
            actions: ["AXPress", "AXShowMenu"]),
        ]),
      Node("AXStaticText", key: "message", value: .string("Hello there")),
    ])
}

extension Harness {
  /// "Chat" (pid 42) running with `chatWindow()`, its window on screen as window 7.
  func runChat(windows extra: [Node] = []) {
    run(pid: 42, name: "Chat", bundleId: "com.example.chat")
    accessibility.installApp(pid: 42, windows: [chatWindow()] + extra)
    self.windows.set([
      WindowInfo(id: 7, pid: 42, frame: Rect(x: 100, y: 100, width: 800, height: 600))
    ])
  }
}
