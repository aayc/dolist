import Foundation
import Testing

@testable import DailyDoListComputer

@Suite("Protected targets: the list")
struct ProtectedListTests {
  let targets = ProtectedTargets.standard()

  @Test(arguments: [
    ("app.dailydolist.mac", ProtectedTargets.Category.dailyDoList),
    ("app.dailydolist.mac.helper", .dailyDoList),
    ("com.apple.systempreferences", .systemSettings),
    ("com.apple.Settings", .systemSettings),
    ("com.apple.settings.PrivacySecurity.extension", .systemSettings),
    ("com.apple.preference.security.remoteservice", .systemSettings),
    ("COM.APPLE.SYSTEMPREFERENCES", .systemSettings),
    ("com.apple.SecurityAgent", .securityPrompt),
    ("com.apple.loginwindow", .securityPrompt),
    ("com.apple.LocalAuthentication.UIAgent", .securityPrompt),
    ("com.apple.keychainaccess", .passwords),
    ("com.apple.Passwords", .passwords),
    ("com.apple.Passwords.MenuBarExtra", .passwords),
    ("com.1password.1password", .passwords),
    ("com.1password.browser-helper", .passwords),
    ("com.agilebits.onepassword7", .passwords),
    ("com.bitwarden.desktop", .passwords),
    ("com.dashlane.dashlanephonefinal", .passwords),
    ("com.lastpass.LastPass", .passwords),
    ("org.keepassxc.keepassxc", .passwords),
    ("com.okta.mobile", .authenticator),
    ("com.yubico.yubioath", .authenticator),
  ])
  func protectsBundleIds(bundleId: String, category: ProtectedTargets.Category) {
    #expect(targets.category(bundleIdentifier: bundleId, names: []) == category)
  }

  @Test(arguments: [
    ("Okta Verify", ProtectedTargets.Category.authenticator),
    ("Yubico Authenticator", .authenticator),
    ("1Password 7", .passwords),
    ("1Password", .passwords),
    ("Dashlane", .passwords),
    ("LastPass", .passwords),
    ("KeePassXC", .passwords),
    ("Keychain Access", .passwords),
    ("System Settings", .systemSettings),
    ("System Preferences", .systemSettings),
    ("Daily Do List", .dailyDoList),
  ])
  func protectsAppsByTheirRealNames(name: String, category: ProtectedTargets.Category) {
    #expect(targets.category(bundleIdentifier: "com.example.unrelated", names: [name]) == category)
    #expect(targets.category(bundleIdentifier: nil, names: ["Unrelated", name]) == category)
  }

  @Test func leavesOrdinaryAppsAlone() {
    let apps = [
      ("com.example.grokbot", "Grok Bot"), ("net.whatsapp.WhatsApp", "WhatsApp"),
      ("com.tinyspeck.slackmacgap", "Slack"), ("com.apple.Safari", "Safari"),
      ("com.apple.settingsx", "Settings X"), ("com.openai.chat", "ChatGPT"),
      ("com.microsoft.teams2", "Microsoft Teams"), ("md.obsidian", "Obsidian"),
    ]
    for (bundleId, name) in apps {
      #expect(targets.category(bundleIdentifier: bundleId, names: [name]) == nil, "\(name)")
    }
  }

  @Test func recognizesTheWebUIByURL() throws {
    for text in [
      "http://127.0.0.1:5173/", "http://localhost:7331/notes/today", "http://[::1]:5173",
      "http://LOCALHOST.:5173/", "http://0.0.0.0:7331", "ws://127.0.0.1:7331/ws",
    ] {
      #expect(targets.isWebUI(url: try #require(URL(string: text))), "\(text)")
    }
    for text in [
      "https://example.com:5173/", "http://127.0.0.1:3000/", "http://localhost/",
      "file:///Users/me/notes.html", "about:blank",
    ] {
      #expect(!targets.isWebUI(url: try #require(URL(string: text))), "\(text)")
    }
    let custom = ProtectedTargets.standard(environment: ["DDL_PORT": "7444"])
    #expect(custom.isWebUI(url: try #require(URL(string: "http://127.0.0.1:7444/"))))
    #expect(!targets.isWebUI(url: try #require(URL(string: "http://127.0.0.1:7444/"))))
  }

  @Test func recognizesTheWebUIByTitle() {
    #expect(targets.isWebUI(title: "Daily Do List"))
    #expect(targets.isWebUI(title: "Thursday — daily do list"))
    #expect(!targets.isWebUI(title: "Daily to-do list ideas"))
  }

  @Test func normalizesNames() {
    #expect(ProtectedTargets.normalizedName("1Password 7") == "1password7")
    #expect(ProtectedTargets.normalizedName("Daily Do List") == "dailydolist")
    #expect(ProtectedTargets.normalizedName("Réglages Système") == "reglagessysteme")
  }
}

@Suite("Protected targets: enforcement")
struct ProtectedEnforcementTests {
  /// A protected app with a normal-looking window, pid 50.
  private func harnessWithPasswordManager() -> Harness {
    let harness = Harness()
    harness.run(pid: 50, name: "1Password", bundleId: "com.1password.1password")
    harness.accessibility.installApp(pid: 50, windows: [chatWindow(title: "Vault")])
    harness.windows.set([
      WindowInfo(id: 9, pid: 50, frame: Rect(x: 100, y: 100, width: 800, height: 600))
    ])
    return harness
  }

  private static let everyMethod: [(String, JSONObject)] = [
    ("snapshot", ["pid": 50]),
    ("screenshot", ["pid": 50]),
    ("press", ["pid": 50, "snapshotId": "s1", "elementId": "e4"]),
    ("setValue", ["pid": 50, "snapshotId": "s1", "elementId": "e3", "value": "x"]),
    ("typeText", ["pid": 50, "text": "hello"]),
    ("key", ["pid": 50, "combo": "return"]),
    ("click", ["pid": 50, "x": 200, "y": 200]),
    ("scroll", ["pid": 50, "x": 200, "y": 200, "dx": 0, "dy": 3]),
    ("activate", ["pid": 50]),
    ("resolveApp", ["pid": 50]),
  ]

  @Test(arguments: everyMethod)
  func refusesProtectedAppsInEveryMethod(method: String, params: JSONObject) async {
    let harness = harnessWithPasswordManager()
    let error = await harness.makeService().failure(method, params)
    #expect(
      error
        == ComputerError(
          .protected, "1Password is protected: the agent never touches passwords or keychains."))
    #expect(harness.events.posted.isEmpty)
    #expect(harness.accessibility.recorded.isEmpty, "nothing of the app was read")
    #expect(harness.capture.windowRequests.isEmpty)
    #expect(harness.workspace.activated.isEmpty)
  }

  @Test func protectedChecksComeBeforePermissionChecks() async {
    var harness = harnessWithPasswordManager()
    harness.permissions = FakePermissions(
      accessibilityGranted: false, screenRecordingGranted: false)
    #expect(await harness.makeService().failure("snapshot", ["pid": 50])?.code == .protected)
  }

  @Test func refusesTheAppsTheHelperRunsUnder() async {
    var harness = Harness()
    // ddl-computer (900) ← the daemon (800) ← a terminal app (700) ← launchd.
    harness.processes = FakeProcessTree(currentPID: 900, parents: [900: 800, 800: 700, 700: 1])
    harness.run(pid: 700, name: "Terminal Deluxe", bundleId: "com.example.terminal")
    harness.run(pid: 701, name: "Terminal Deluxe", bundleId: "com.example.terminal")
    harness.run(pid: 800, name: "node", bundleId: nil, kind: .background)
    harness.install(name: "Terminal Deluxe", bundleId: "com.example.terminal")
    let service = harness.makeService()

    let hostError = ComputerError(
      .protected,
      "Terminal Deluxe runs the agent, so it's protected: the agent never operates the app it runs in."
    )
    #expect(await service.failure("snapshot", ["pid": 700]) == hostError)
    #expect(await service.failure("key", ["pid": 701, "combo": "cmd+q"])?.code == .protected)
    #expect(await service.failure("typeText", ["pid": 800, "text": "exit"])?.code == .protected)
    #expect(await service.failure("snapshot", ["pid": 900])?.code == .notFound)
    #expect(await service.failure("resolveApp", ["name": "terminal deluxe"])?.code == .protected)
    #expect(
      await service.failure("resolveApp", ["bundleId": "com.example.terminal"])?.code == .protected)
    #expect(harness.events.posted.isEmpty)
  }

  @Test func refusesProcessesStartedByProtectedApps() async {
    var harness = harnessWithPasswordManager()
    harness.processes.parents[60] = 50
    harness.run(pid: 60, name: "Unlock Helper", bundleId: "com.example.unlock")
    let error = await harness.makeService().failure("snapshot", ["pid": 60])
    #expect(
      error
        == ComputerError(
          .protected,
          "Unlock Helper was started by 1Password, which is protected, so it's protected too."))
  }

  @Test func resolveAppNeverLaunchesProtectedApps() async {
    let harness = Harness()
    harness.install(name: "Okta Verify", bundleId: "com.okta.mobile")
    harness.install(name: "Settings Helper", bundleId: "com.apple.systempreferences")
    let service = harness.makeService()
    #expect(await service.failure("resolveApp", ["name": "okta"])?.code == .protected)
    #expect(await service.failure("resolveApp", ["name": "settings helper"])?.code == .protected)
    #expect(
      await service.failure("resolveApp", ["bundleId": "com.okta.mobile"])?.code == .protected)
    #expect(harness.workspace.launched.isEmpty)
  }

  // MARK: - The web UI in a browser

  private func browserWindow(title: String, url: String, key: String = "window") -> Node {
    Node(
      "AXWindow", key: key, title: title, frame: Rect(x: 0, y: 0, width: 1_000, height: 800),
      children: [
        Node("AXToolbar", children: [Node("AXTextField", value: .string(url))]),
        Node(
          "AXGroup",
          children: [
            Node(
              "AXGroup",
              children: [
                Node(
                  "AXScrollArea",
                  children: [
                    Node(
                      "AXWebArea", title: "page",
                      attributes: [AX.url: .url(URL(string: url)!)],
                      children: [Node("AXButton", title: "Approve", actions: ["AXPress"])])
                  ])
              ])
          ]),
      ])
  }

  private func harnessWithBrowser(_ windows: [Node]) -> Harness {
    let harness = Harness()
    harness.run(pid: 70, name: "Safari", bundleId: "com.apple.Safari")
    harness.accessibility.installApp(pid: 70, windows: windows)
    harness.windows.set([
      WindowInfo(id: 3, pid: 70, frame: Rect(x: 0, y: 0, width: 1_000, height: 800))
    ])
    return harness
  }

  @Test func refusesABrowserShowingTheWebUIByURL() async {
    let harness = harnessWithBrowser([browserWindow(title: "Today", url: "http://127.0.0.1:5173/")])
    let service = harness.makeService()
    let expected = ComputerError(
      .protected,
      "Safari is showing Daily Do List, so it's protected: the agent never operates Daily Do List "
        + "itself.")
    #expect(await service.failure("snapshot", ["pid": 70]) == expected)
    #expect(await service.failure("screenshot", ["pid": 70]) == expected)
    #expect(await service.failure("key", ["pid": 70, "combo": "return"]) == expected)
    #expect(await service.failure("typeText", ["pid": 70, "text": "yes"]) == expected)
    #expect(await service.failure("click", ["pid": 70, "x": 10, "y": 10]) == expected)
    #expect(
      await service.failure("scroll", ["pid": 70, "x": 10, "y": 10, "dx": 0, "dy": 1]) == expected)
    #expect(await service.failure("activate", ["pid": 70]) == expected)
    #expect(harness.events.posted.isEmpty)
    #expect(harness.capture.windowRequests.isEmpty)
  }

  @Test func refusesAWindowTitledDailyDoList() async {
    let harness = harnessWithBrowser([
      Node("AXWindow", key: "window", title: "Daily Do List", children: [Node("AXButton")])
    ])
    #expect(await harness.makeService().failure("snapshot", ["pid": 70])?.code == .protected)
  }

  @Test func readsAnotherWindowButRefusesInputWhileAnyWindowShowsTheWebUI() async throws {
    let harness = harnessWithBrowser([
      browserWindow(title: "News", url: "https://example.com/", key: "news"),
      browserWindow(title: "Today", url: "http://localhost:7331/", key: "ddl"),
    ])
    let service = harness.makeService()
    let snapshot = try await service.result("snapshot", ["pid": 70])
    #expect(snapshot.object("window")?.string("title") == "News")
    #expect(await service.failure("key", ["pid": 70, "combo": "cmd+l"])?.code == .protected)
    #expect(
      await service.failure("press", ["pid": 70, "snapshotId": "s1", "elementId": "e2"])?.code
        == .protected)
  }

  @Test func allowsPagesOnOtherHostsAndPorts() async throws {
    let harness = harnessWithBrowser([
      browserWindow(title: "Local app", url: "http://127.0.0.1:3000/")
    ])
    let snapshot = try await harness.makeService().result("snapshot", ["pid": 70])
    #expect(snapshot.string("text")?.contains(#"AXButton name="Approve""#) == true)
  }

  @Test func findsTheWebUIInsideAnyAppNotJustBrowsers() async {
    let harness = Harness()
    harness.run(pid: 80, name: "Editor", bundleId: "com.example.editor")
    var inner = Node(
      "AXWebArea", attributes: [AX.url: .url(URL(string: "http://localhost:5173/")!)])
    for _ in 0..<6 { inner = Node("AXGroup", children: [inner]) }
    harness.accessibility.installApp(
      pid: 80, windows: [Node("AXWindow", key: "window", title: "main.ts", children: [inner])])
    #expect(
      await harness.makeService().failure("typeText", ["pid": 80, "text": "y"])?.code == .protected)
  }

  @Test func refusesAWindowItCantFinishChecking() throws {
    let accessibility = FakeAccessibility()
    accessibility.installApp(
      pid: 1,
      windows: [Node("AXWindow", key: "window", children: (1...10).map { _ in Node("AXGroup") })])
    var guardian = WebUIGuard(
      targets: .standard(), api: accessibility, clock: FakeClock())
    guardian.maxVisited = 5
    #expect(throws: ComputerError.self) {
      try guardian.check(window: accessibility.element("window"), appName: "Big")
    }
    guardian.maxVisited = 100
    try guardian.check(window: accessibility.element("window"), appName: "Big")
  }
}
