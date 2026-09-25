import CoreGraphics
import Foundation
import ImageIO
import Testing

@testable import DailyDoListComputer

@Suite("Element actions")
struct ElementActionTests {
  @Test func pressPerformsTheRequestedAction() async throws {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    _ = try await service.result("snapshot", ["pid": 42])
    _ = try await service.result(
      "press", ["pid": 42, "snapshotId": "s1", "elementId": "e4", "action": "show-menu"])
    #expect(harness.accessibility.recorded.contains(.perform(key: "send", action: "AXShowMenu")))
    #expect(harness.workspace.activated.isEmpty, "pressing never activates the app")
    #expect(harness.events.posted.isEmpty)
  }

  @Test func pressRefusesActionsTheElementLacks() async throws {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    _ = try await service.result("snapshot", ["pid": 42])
    let error = await service.failure(
      "press", ["pid": 42, "snapshotId": "s1", "elementId": "e4", "action": "increment"])
    #expect(error == .unsupported("e4 can't increment."))
    #expect(
      await service.failure(
        "press", ["pid": 42, "snapshotId": "s1", "elementId": "e4", "action": "AXPress"])?.code
        == .invalid)
  }

  @Test func setValueSetsTheValueAndReadsItBack() async throws {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    _ = try await service.result("snapshot", ["pid": 42])
    let result = try await service.result(
      "setValue", ["pid": 42, "snapshotId": "s1", "elementId": "e3", "value": "Hello"])
    #expect(result == ["ok": true, "value": "Hello", "stale": true])
    #expect(
      harness.accessibility.recorded.contains(
        .set(key: "field", attribute: AX.value, value: .string("Hello"))))
  }

  @Test func setValueRefusesElementsWithoutASettableValue() async throws {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    _ = try await service.result("snapshot", ["pid": 42])
    let error = await service.failure(
      "setValue", ["pid": 42, "snapshotId": "s1", "elementId": "e5", "value": "x"])
    #expect(error == .unsupported("e5 (AXStaticText) has no value that can be set."))
  }

  @Test func setValueTurnsTextIntoNumbersForNumericElements() async throws {
    let harness = Harness()
    harness.run(pid: 42, name: "Mixer", bundleId: "com.example.mixer")
    harness.accessibility.installApp(
      pid: 42,
      windows: [
        Node(
          "AXWindow", key: "window",
          children: [
            Node(
              "AXSlider", key: "volume", title: "Volume", value: .number(5),
              actions: ["AXIncrement", "AXDecrement"], settable: [AX.value])
          ])
      ])
    let service = harness.makeService()
    _ = try await service.result("snapshot", ["pid": 42])
    let result = try await service.result(
      "setValue", ["pid": 42, "snapshotId": "s1", "elementId": "e2", "value": " 7 "])
    #expect(result.number("value") == 7)
    #expect(
      harness.accessibility.recorded.contains(
        .set(key: "volume", attribute: AX.value, value: .number(7))))
  }

  @Test func setValueNeverReadsASecureFieldBack() async throws {
    let harness = Harness()
    harness.run(pid: 42, name: "Login", bundleId: "com.example.login")
    harness.accessibility.installApp(
      pid: 42,
      windows: [
        Node(
          "AXWindow", key: "window",
          children: [
            Node(
              "AXTextField", key: "password", title: "Password", value: .string("old"),
              settable: [AX.value, AX.focused],
              attributes: [AX.subrole: .string("AXSecureTextField")])
          ])
      ])
    let service = harness.makeService()
    _ = try await service.result("snapshot", ["pid": 42])
    let result = try await service.result(
      "setValue", ["pid": 42, "snapshotId": "s1", "elementId": "e2", "value": "correct horse"])
    #expect(result == ["ok": true, "value": nil, "stale": true])
    let reads = harness.accessibility.recorded.compactMap { call -> [String]? in
      if case .read("password", let attributes) = call { return attributes }
      return nil
    }
    #expect(reads.allSatisfy { !$0.contains(AX.value) })
  }

  @Test func setValueValidatesTheValue() async throws {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    _ = try await service.result("snapshot", ["pid": 42])
    let base: JSONObject = ["pid": 42, "snapshotId": "s1", "elementId": "e3"]
    for value: JSONValue in [["a": 1], [1, 2], .string(String(repeating: "x", count: 10_001))] {
      var params = base
      params["value"] = value
      #expect(await service.failure("setValue", params)?.code == .invalid)
    }
    #expect(await service.failure("setValue", base) == .invalid("setValue: \"value\" is required."))
    var empty = base
    empty["value"] = ""
    #expect(try await service.result("setValue", empty).string("value") == "")
  }
}

@Suite("Keyboard and mouse input")
struct InputTests {
  @Test func typeTextFocusesTheElementThenTypesIntoTheApp() async throws {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    _ = try await service.result("snapshot", ["pid": 42])
    let result = try await service.result(
      "typeText", ["pid": 42, "text": "hi\nyo", "snapshotId": "s1", "elementId": "e3"])

    #expect(result == ["ok": true, "stale": true])
    #expect(
      harness.accessibility.recorded.contains(
        .set(key: "field", attribute: AX.focused, value: .bool(true))))
    #expect(
      harness.events.posted == [
        .text("hi", down: true), .text("hi", down: false),
        .key(code: 36, down: true, flags: 0), .key(code: 36, down: false, flags: 0),
        .text("yo", down: true), .text("yo", down: false),
      ])
    #expect(harness.events.targets == [42])
  }

  @Test func typeTextWithoutAnElementTypesIntoWhateverHasFocus() async throws {
    let harness = Harness()
    harness.runChat()
    let result = try await harness.makeService().result("typeText", ["pid": 42, "text": "a\tb"])
    #expect(result == ["ok": true, "stale": false])
    #expect(harness.events.posted.count == 6)
  }

  @Test func typeTextRefusesElementsThatCantTakeFocus() async throws {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    _ = try await service.result("snapshot", ["pid": 42])
    let error = await service.failure(
      "typeText", ["pid": 42, "text": "hi", "snapshotId": "s1", "elementId": "e4"])
    #expect(error == .unsupported("e4 can't take focus."))
    #expect(harness.events.posted.isEmpty)
  }

  @Test func typeTextValidatesItsText() async throws {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    for params: JSONObject in [
      ["pid": 42, "text": ""], ["pid": 42, "text": "\u{1B}[A"], ["pid": 42, "text": "a\u{7F}"],
      ["pid": 42, "text": .string(String(repeating: "a", count: 10_001))],
      ["pid": 42, "text": "hi", "elementId": "e3"], ["pid": 42], ["text": "hi"],
    ] {
      #expect(await service.failure("typeText", params)?.code == .invalid, "\(params)")
    }
    #expect(harness.events.posted.isEmpty)
    let longest = String(repeating: "a", count: 10_000)
    #expect(
      try await service.result("typeText", ["pid": 42, "text": .string(longest)])["ok"] == true)
  }

  @Test func keyPostsTheComboToTheApp() async throws {
    let harness = Harness()
    harness.runChat()
    _ = try await harness.makeService().result("key", ["pid": 42, "combo": "cmd+k"])
    #expect(
      harness.events.posted == [
        .key(code: 55, down: true, flags: 0x10_0000), .key(code: 40, down: true, flags: 0x10_0000),
        .key(code: 40, down: false, flags: 0x10_0000), .key(code: 55, down: false, flags: 0),
      ])
  }

  @Test func keyRejectsUnknownCombos() async {
    let harness = Harness()
    harness.runChat()
    let error = await harness.makeService().failure("key", ["pid": 42, "combo": "cmd+banana"])
    #expect(error?.code == .invalid)
    #expect(error?.message.hasPrefix("Unknown key \"banana\"") == true)
    #expect(harness.events.posted.isEmpty)
  }

  @Test func clickPostsMouseEventsToTheWindowUnderThePoint() async throws {
    let harness = Harness()
    harness.runChat()
    let result = try await harness.makeService().result(
      "click", ["pid": 42, "x": 150.5, "y": 200, "button": "right", "count": 2])
    let point = Point(x: 150.5, y: 200)
    #expect(result == ["ok": true, "stale": false])
    #expect(
      harness.events.posted == [
        .mouse(button: .right, down: true, at: point, clickCount: 1, windowID: 7),
        .mouse(button: .right, down: false, at: point, clickCount: 1, windowID: 7),
        .mouse(button: .right, down: true, at: point, clickCount: 2, windowID: 7),
        .mouse(button: .right, down: false, at: point, clickCount: 2, windowID: 7),
      ])
    #expect(harness.clock.sleeps.contains(.milliseconds(50)))
  }

  @Test func clickPointsOutsideTheAppsWindowsAreRejected() async throws {
    let harness = Harness()
    harness.runChat()
    harness.run(pid: 43, name: "Other", bundleId: "com.example.other")
    harness.windows.set([
      WindowInfo(id: 8, pid: 43, frame: Rect(x: 0, y: 0, width: 2_000, height: 2_000)),
      WindowInfo(id: 7, pid: 42, frame: Rect(x: 100, y: 100, width: 800, height: 600)),
      WindowInfo(id: 6, pid: 42, frame: Rect(x: 950, y: 100, width: 50, height: 50), alpha: 0),
    ])
    let service = harness.makeService()
    for (x, y) in [(50.0, 50.0), (900.0, 300.0), (960.0, 110.0), (100.0, 700.0)] {
      let error = await service.failure("click", ["pid": 42, "x": .number(x), "y": .number(y)])
      #expect(error?.code == .invalid, "(\(x), \(y))")
    }
    #expect(
      await service.failure("click", ["pid": 42, "x": 50, "y": 50])
        == .invalid("(50, 50) isn't inside any window of Chat."))
    #expect(harness.events.posted.isEmpty)
    #expect(try await service.result("click", ["pid": 42, "x": 100, "y": 100])["ok"] == true)
  }

  @Test func clickValidatesItsParams() async {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    for params: JSONObject in [
      ["pid": 42, "x": 150], ["pid": 42, "x": 150, "y": 200, "count": 4],
      ["pid": 42, "x": 150, "y": 200, "count": 0],
      ["pid": 42, "x": 150, "y": 200, "button": "back"],
      ["pid": 42, "x": "150", "y": 200], ["pid": 42, "x": 2e6, "y": 200],
    ] {
      #expect(await service.failure("click", params)?.code == .invalid, "\(params)")
    }
  }

  @Test func scrollPostsWheelEventsAtThePoint() async throws {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    let result = try await service.result(
      "scroll", ["pid": 42, "x": 150, "y": 200, "dx": 0, "dy": 12])
    let point = Point(x: 150, y: 200)
    #expect(result == ["ok": true])
    #expect(
      harness.events.posted == [
        .scroll(dx: 0, dy: -10, at: point, windowID: 7),
        .scroll(dx: 0, dy: -2, at: point, windowID: 7),
      ])
    #expect(
      await service.failure("scroll", ["pid": 42, "x": 150, "y": 200, "dx": 0, "dy": 201])?.code
        == .invalid)
    #expect(
      await service.failure("scroll", ["pid": 42, "x": 5, "y": 5, "dx": 0, "dy": 1])?.code
        == .invalid)
  }

  @Test func inputNeedsAccessibility() async {
    var harness = Harness()
    harness.permissions.accessibilityGranted = false
    harness.runChat()
    let service = harness.makeService()
    #expect(await service.failure("key", ["pid": 42, "combo": "return"])?.code == .permission)
    #expect(await service.failure("typeText", ["pid": 42, "text": "x"])?.code == .permission)
    #expect(await service.failure("click", ["pid": 42, "x": 150, "y": 200])?.code == .permission)
    #expect(harness.events.posted.isEmpty)
  }

  @Test func activateBringsTheAppForward() async throws {
    let harness = Harness()
    harness.runChat()
    let service = harness.makeService()
    #expect(try await service.result("activate", ["pid": 42]) == ["ok": true])
    #expect(harness.workspace.activated == [42])

    harness.workspace.activationWorks = false
    #expect(await service.failure("activate", ["pid": 42])?.code == .failed)
  }

  private static let inputMethods: [(String, JSONObject)] = [
    ("typeText", ["pid": 42, "text": "hi"]),
    ("key", ["pid": 42, "combo": "return"]),
    ("click", ["pid": 42, "x": 150, "y": 200]),
    ("scroll", ["pid": 42, "x": 150, "y": 200, "dx": 0, "dy": 3]),
  ]

  @Test(arguments: inputMethods)
  func inputBringsTheAppToTheFrontFirst(method: String, params: JSONObject) async throws {
    let harness = Harness()
    harness.runChat()
    #expect(try await harness.makeService().result(method, params)["ok"] == true)
    #expect(harness.workspace.activated == [42])
    #expect(!harness.events.posted.isEmpty)
  }

  @Test func inputLeavesAnAppAlreadyInFrontAsItIs() async throws {
    let harness = Harness()
    harness.runChat()
    _ = await harness.workspace.activate(pid: 42)
    _ = try await harness.makeService().result("key", ["pid": 42, "combo": "return"])
    #expect(harness.workspace.activated == [42], "no second activation")
  }

  @Test(arguments: inputMethods)
  func inputSendsNothingWhenTheAppWontComeToTheFront(method: String, params: JSONObject) async {
    let harness = Harness()
    harness.runChat()
    harness.workspace.activationWorks = false
    let error = await harness.makeService().failure(method, params)
    #expect(error == .failed("macOS didn't bring Chat to the front, so no input was sent."))
    #expect(harness.events.posted.isEmpty)
  }
}

@Suite("Screenshots")
struct ScreenshotTests {
  @Test func fitsTheLongerSideWithoutEverScalingUp() {
    #expect(ImageEncoder.fittedSize(width: 2_400, height: 1_600, maxSide: 1_280) == (1_280, 853))
    #expect(ImageEncoder.fittedSize(width: 1_000, height: 3_000, maxSide: 1_280) == (427, 1_280))
    #expect(ImageEncoder.fittedSize(width: 800, height: 600, maxSide: 1_280) == (800, 600))
    #expect(ImageEncoder.fittedSize(width: 5_000, height: 1, maxSide: 100) == (100, 1))
  }

  @Test func encodesAScaledJPEG() throws {
    let image = try ImageEncoder.jpeg(try solidImage(width: 300, height: 200), maxSide: 150)
    #expect(image.width == 150 && image.height == 100)
    #expect(image.data.prefix(3) == Data([0xFF, 0xD8, 0xFF]))
    let source = try #require(CGImageSourceCreateWithData(image.data as CFData, nil))
    let decoded = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
    #expect(decoded.width == 150 && decoded.height == 100)
  }

  @Test func capturesTheAppsWindowByItself() async throws {
    let harness = Harness()
    harness.run(pid: 42, name: "Chat", bundleId: "com.example.chat")
    harness.accessibility.installApp(
      pid: 42, windows: [chatWindow(frame: Rect(x: 100, y: 50, width: 1_200, height: 800))])
    let result = try await harness.makeService().result("screenshot", ["pid": 42])

    #expect(result.string("mimeType") == "image/jpeg")
    #expect(result.number("width") == 1_280)
    #expect(result.number("height") == 853)
    #expect(result.number("scale") == 1.0667)
    #expect(result.object("origin") == ["x": 100, "y": 50])
    #expect(result.object("app") == ["name": "Chat", "bundleId": "com.example.chat", "pid": 42])
    #expect(
      result.object("window") == [
        "title": "Chat", "frame": ["x": 100, "y": 50, "width": 1_200, "height": 800],
      ])
    let jpeg = try #require(result.string("image").flatMap { Data(base64Encoded: $0) })
    #expect(jpeg.prefix(2) == Data([0xFF, 0xD8]))
    #expect(
      harness.capture.windowRequests.map(\.frame) == [
        Rect(x: 100, y: 50, width: 1_200, height: 800)
      ])
  }

  @Test func capturesTheMainDisplayWithoutAPid() async throws {
    let harness = Harness()
    let result = try await harness.makeService().result("screenshot", ["maxWidth": 640])
    #expect(result.number("width") == 640)
    #expect(result.number("height") == 427)
    #expect(result.number("scale") == 0.4233)
    #expect(result.object("origin") == ["x": 0, "y": 0])
    #expect(result["app"] == nil && result["window"] == nil)
  }

  @Test func needsScreenRecordingAndForAnAppAccessibility() async {
    var harness = Harness()
    harness.runChat()
    harness.permissions = FakePermissions(accessibilityGranted: true, screenRecordingGranted: false)
    let noRecording = await harness.makeService().failure("screenshot", [:])
    #expect(noRecording?.code == .permission)
    #expect(noRecording?.message.contains("Screen Recording") == true)

    harness.permissions = FakePermissions(accessibilityGranted: false, screenRecordingGranted: true)
    #expect(await harness.makeService().failure("screenshot", ["pid": 42])?.code == .permission)
    #expect(harness.capture.windowRequests.isEmpty)
  }

  @Test func reportsAppsWithoutAWindow() async {
    let harness = Harness()
    harness.run(pid: 42, name: "Chat", bundleId: "com.example.chat")
    harness.accessibility.installApp(pid: 42, windows: [])
    #expect(
      await harness.makeService().failure("screenshot", ["pid": 42])
        == .notFound("Chat has no open window to capture."))
    #expect(await harness.makeService().failure("screenshot", ["maxWidth": 10])?.code == .invalid)
  }
}
