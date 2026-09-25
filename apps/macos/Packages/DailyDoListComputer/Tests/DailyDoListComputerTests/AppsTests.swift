import Foundation
import Testing

@testable import DailyDoListComputer

private func installed(_ name: String, _ bundleId: String, displayName: String? = nil)
  -> InstalledApp
{
  InstalledApp(
    name: name, bundleId: bundleId, url: URL(fileURLWithPath: "/Applications/\(name).app"),
    displayName: displayName)
}

@Suite("App name resolution")
struct AppResolverTests {
  private func resolve(_ query: String, _ apps: [InstalledApp], running: [RunningApp] = [])
    -> AppResolution
  {
    AppResolver.resolve(
      query, among: AppResolver.candidates(running: running, installed: apps))
  }

  private func matchedName(_ resolution: AppResolution) -> String? {
    if case .match(let candidate) = resolution { return candidate.name }
    return nil
  }

  let grokApps = [
    installed("Grok", "com.example.grok"), installed("Grok Bot", "com.example.grokbot"),
    installed("Grok (Next)", "com.example.groknext"),
    installed("WhatsApp", "net.whatsapp.WhatsApp"),
  ]

  @Test func anExactMatchWinsOverPrefixAndContainsMatches() {
    #expect(matchedName(resolve("grok", grokApps)) == "Grok")
    #expect(matchedName(resolve("GROK BOT", grokApps)) == "Grok Bot")
    #expect(matchedName(resolve("grok (next)", grokApps)) == "Grok (Next)")
  }

  @Test func thenAUniquePrefixMatch() {
    #expect(matchedName(resolve("whats", grokApps)) == "WhatsApp")
    #expect(matchedName(resolve("grok b", grokApps)) == "Grok Bot")
  }

  @Test func thenAUniqueContainsMatch() {
    #expect(matchedName(resolve("next", grokApps)) == "Grok (Next)")
    #expect(matchedName(resolve("sapp", grokApps)) == "WhatsApp")
  }

  @Test func severalMatchesAreAmbiguousWithTheCandidatesListed() {
    let apps = Array(grokApps.dropFirst())
    guard case .ambiguous(let candidates) = resolve("grok", apps) else {
      Issue.record("not ambiguous")
      return
    }
    #expect(candidates.map(\.name) == ["Grok (Next)", "Grok Bot"])
    #expect(
      AppResolver.ambiguityMessage(query: "grok", candidates: candidates)
        == #"Several apps match "grok": "Grok (Next)" (com.example.groknext), "Grok Bot" "#
        + #"(com.example.grokbot). Use a more specific name, or the bundleId."#)
    guard case .ambiguous = resolve("o", grokApps) else {
      Issue.record("a contains match on several apps should be ambiguous")
      return
    }
  }

  @Test func matchesLocalizedBundleAndFileNames() {
    let code = installed("Code", "com.example.code", displayName: "Visual Studio Code")
    #expect(matchedName(resolve("visual studio code", [code])) == "Code")
    let running = RunningApp(
      pid: 3, localizedName: "Nachrichten", bundleId: "com.example.messages",
      bundleName: "Messages", bundleURL: URL(fileURLWithPath: "/Applications/Messages.app"))
    #expect(matchedName(resolve("messages", [], running: [running])) == "Nachrichten")
    #expect(matchedName(resolve("nachrichten", [], running: [running])) == "Nachrichten")
  }

  @Test func ignoresCaseAccentsSpacingAndTheAppSuffix() {
    let apps = [installed("Café  Bot", "com.example.cafe")]
    #expect(matchedName(resolve("  cafe bot.app ", apps)) == "Café  Bot")
  }

  @Test func mergesRunningAndInstalledCopiesOfTheSameApp() {
    let running = RunningApp(
      pid: 42, localizedName: "WhatsApp", bundleId: "net.whatsapp.WhatsApp",
      bundleURL: URL(fileURLWithPath: "/Applications/WhatsApp.app"))
    guard case .match(let candidate) = resolve("whatsapp", grokApps, running: [running]) else {
      Issue.record("no unique match")
      return
    }
    #expect(candidate.running?.pid == 42)
    #expect(candidate.installed?.bundleId == "net.whatsapp.WhatsApp")
  }

  @Test func leavesOutBackgroundProcessesAndFindsNothingForUnknownNames() {
    let daemon = RunningApp(pid: 5, localizedName: "Grok Agent", bundleId: nil, kind: .background)
    #expect(resolve("grok agent", [], running: [daemon]) == .none)
    #expect(resolve("telegram", grokApps) == .none)
    #expect(resolve("   ", grokApps) == .none)
  }
}

@Suite("resolveApp")
struct ResolveAppTests {
  @Test func resolvesRunningAppsWithoutLaunchingThem() async throws {
    let harness = Harness()
    harness.run(pid: 42, name: "WhatsApp", bundleId: "net.whatsapp.WhatsApp")
    harness.install(name: "WhatsApp", bundleId: "net.whatsapp.WhatsApp")
    let service = harness.makeService()
    let expected: JSONObject = [
      "name": "WhatsApp", "bundleId": "net.whatsapp.WhatsApp", "pid": 42, "launched": false,
    ]
    #expect(try await service.result("resolveApp", ["name": "whatsapp"]) == expected)
    #expect(
      try await service.result("resolveApp", ["bundleId": "NET.whatsapp.whatsapp"]) == expected)
    #expect(try await service.result("resolveApp", ["pid": 42]) == expected)
    #expect(harness.workspace.launched.isEmpty)
  }

  @Test func launchesInstalledAppsInTheBackground() async throws {
    let harness = Harness()
    harness.install(name: "Grok Bot", bundleId: "com.example.grokbot")
    let service = harness.makeService()
    let result = try await service.result("resolveApp", ["name": "Grok Bot"])
    #expect(
      result == [
        "name": "Grok Bot", "bundleId": "com.example.grokbot", "pid": 5_000, "launched": true,
      ])
    #expect(harness.workspace.launched == [URL(fileURLWithPath: "/Applications/Grok Bot.app")])
    #expect(harness.workspace.activated.isEmpty, "launching never activates")
    #expect(
      try await service.result("resolveApp", ["bundleId": "com.example.grokbot"]).bool("launched")
        == false)
  }

  @Test func waitsForTheLaunchToFinishThenGivesUp() async throws {
    let harness = Harness()
    harness.install(name: "Slow", bundleId: "com.example.slow")
    harness.workspace.launchedApp = { app, pid in
      RunningApp(
        pid: pid, localizedName: app.name, bundleId: app.bundleId, bundleURL: app.url,
        isFinishedLaunching: false)
    }
    let error = await harness.makeService().failure("resolveApp", ["name": "slow"])
    #expect(error == .failed("Slow didn't finish launching within 10 seconds."))
    #expect(harness.clock.sleeps.reduce(Duration.zero, +) >= .seconds(10))

    harness.workspace.launchedApp = { _, _ in nil }
    harness.install(name: "Broken", bundleId: "com.example.broken")
    #expect(await harness.makeService().failure("resolveApp", ["name": "broken"])?.code == .failed)
  }

  @Test func reportsAmbiguousAndUnknownApps() async {
    let harness = Harness()
    harness.install(name: "Grok Bot", bundleId: "com.example.grokbot")
    harness.install(name: "Grok (Next)", bundleId: "com.example.groknext")
    let service = harness.makeService()
    let ambiguous = await service.failure("resolveApp", ["name": "grok"])
    #expect(ambiguous?.code == .invalid)
    #expect(ambiguous?.message.contains(#""Grok Bot" (com.example.grokbot)"#) == true)
    #expect(ambiguous?.message.contains(#""Grok (Next)" (com.example.groknext)"#) == true)
    #expect(
      await service.failure("resolveApp", ["name": "telegram"])
        == .notFound(#"No app named "telegram" is running or installed."#))
    #expect(
      await service.failure("resolveApp", ["bundleId": "org.example.none"])?.code == .notFound)
    #expect(await service.failure("resolveApp", ["pid": 12_345])?.code == .notFound)
  }

  @Test func takesExactlyOneWellFormedSelector() async {
    let service = Harness().makeService()
    for params: JSONObject in [
      [:], ["name": "a", "pid": 1], ["name": "a", "bundleId": "b"], ["name": ""],
      ["bundleId": "com.example/../x"], ["bundleId": "com example"], ["pid": 0],
      ["app": "Chat"],
    ] {
      #expect(await service.failure("resolveApp", params)?.code == .invalid, "\(params)")
    }
  }
}

@Suite("apps and installedApps")
struct AppListTests {
  @Test func listsDockAppsActiveFirstThenByWindowOrderThenByName() async throws {
    let harness = Harness()
    harness.run(pid: 1, name: "Alpha", bundleId: "com.example.alpha")
    harness.run(pid: 2, name: "Bravo", bundleId: "com.example.bravo", active: true)
    harness.run(pid: 3, name: "Charlie", bundleId: "com.example.charlie", hidden: true)
    harness.run(pid: 4, name: "Menu Extra", bundleId: "com.example.extra", kind: .accessory)
    harness.run(pid: 5, name: "Echo", bundleId: nil)
    harness.run(pid: 6, name: "Delta", bundleId: "com.example.delta")
    harness.windows.set([
      WindowInfo(id: 1, pid: 4, frame: Rect(x: 0, y: 0, width: 10, height: 10), layer: 25),
      WindowInfo(id: 2, pid: 3, frame: Rect(x: 0, y: 0, width: 100, height: 100)),
      WindowInfo(id: 3, pid: 1, frame: Rect(x: 0, y: 0, width: 100, height: 100)),
      WindowInfo(id: 4, pid: 3, frame: Rect(x: 0, y: 0, width: 100, height: 100)),
    ])
    let apps = try await harness.makeService().result("apps").objects("apps")

    #expect(apps.map { $0.string("name") } == ["Bravo", "Charlie", "Alpha", "Delta", "Echo"])
    #expect(
      apps[1] == [
        "name": "Charlie", "bundleId": "com.example.charlie", "pid": 3, "active": false,
        "hidden": true,
      ])
    #expect(apps[4]["bundleId"] == .null)
    #expect(apps[0].bool("active") == true)
  }

  @Test func listsInstalledApps() async throws {
    let harness = Harness()
    harness.install(name: "Grok Bot", bundleId: "com.example.grokbot")
    let apps = try await harness.makeService().result("installedApps").objects("apps")
    #expect(
      apps == [
        [
          "name": "Grok Bot", "bundleId": "com.example.grokbot",
          "path": "/Applications/Grok Bot.app",
        ]
      ])
  }

  @Test func helloAndPermissionsNeedNothing() async throws {
    var harness = Harness()
    harness.permissions = FakePermissions(accessibilityGranted: false, screenRecordingGranted: true)
    let service = harness.makeService()
    #expect(try await service.result("hello") == ["version": 1, "pid": 900])
    #expect(
      try await service.result("permissions") == ["accessibility": false, "screenRecording": true])
    #expect(await service.failure("hello", ["verbose": true])?.code == .invalid)
  }
}

private struct FakeBundleReader: AppBundleReading {
  var folders: [String: [String]] = [:]
  var apps: [String: String] = [:]

  func contentsOfDirectory(_ url: URL) -> [URL] {
    (folders[url.path] ?? []).map { url.appendingPathComponent($0) }
  }

  func isDirectory(_ url: URL) -> Bool { folders[url.path] != nil }

  func app(at url: URL) -> InstalledApp? {
    apps[url.path].map {
      InstalledApp(name: url.deletingPathExtension().lastPathComponent, bundleId: $0, url: url)
    }
  }
}

@Suite("Installed app scan")
struct InstalledAppsScanTests {
  let home = URL(fileURLWithPath: "/Users/me")

  @Test func scansTheRootsAndOneFolderLevelBelowThem() {
    let reader = FakeBundleReader(
      folders: [
        "/Applications": ["Zed.app", "Utilities", "Adobe", "notes.txt", "Old.app"],
        "/Applications/Utilities": ["Terminal.app"],
        "/Applications/Adobe": ["Photoshop.app", "Nested"],
        "/Applications/Adobe/Nested": ["Deep.app"],
        "/Users/me/Applications": ["Chrome Apps.localized"],
        "/Users/me/Applications/Chrome Apps.localized": ["Grok.app"],
        "/System/Applications": ["Calendar.app", "Utilities"],
        "/System/Applications/Utilities": ["Activity Monitor.app"],
      ],
      apps: [
        "/Applications/Zed.app": "dev.zed.Zed",
        "/Applications/Utilities/Terminal.app": "com.example.terminal",
        "/Applications/Adobe/Photoshop.app": "com.example.photoshop",
        "/Applications/Adobe/Nested/Deep.app": "com.example.deep",
        "/Users/me/Applications/Chrome Apps.localized/Grok.app": "com.example.grok",
        "/System/Applications/Calendar.app": "com.apple.iCal",
        "/System/Applications/Utilities/Activity Monitor.app": "com.apple.ActivityMonitor",
      ])
    let apps = InstalledAppsScanner.scan(
      roots: InstalledAppsScanner.roots(home: home), reader: reader)
    #expect(
      apps.map(\.name) == ["Activity Monitor", "Calendar", "Grok", "Photoshop", "Terminal", "Zed"])
    #expect(
      apps.first { $0.name == "Grok" }?.url.path
        == "/Users/me/Applications/Chrome Apps.localized/Grok.app")
  }

  @Test func keepsTheFirstCopyOfEachBundleId() {
    let reader = FakeBundleReader(
      folders: [
        "/Applications": ["Vendor", "Chat.app"],
        "/Applications/Vendor": ["Chat Old.app"],
        "/Users/me/Applications": ["Chat Mine.app"],
      ],
      apps: [
        "/Applications/Chat.app": "com.example.chat",
        "/Applications/Vendor/Chat Old.app": "com.example.chat",
        "/Users/me/Applications/Chat Mine.app": "COM.EXAMPLE.CHAT",
      ])
    let apps = InstalledAppsScanner.scan(
      roots: InstalledAppsScanner.roots(home: home), reader: reader)
    #expect(apps.map(\.url.path) == ["/Applications/Chat.app"])
  }

  @Test func readsRealBundlesFromDisk() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ddl-computer-tests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    func makeApp(_ path: String, plist: [String: Any]?) throws {
      let contents = root.appendingPathComponent(path).appendingPathComponent("Contents")
      try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
      if let plist {
        let data = try PropertyListSerialization.data(
          fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: contents.appendingPathComponent("Info.plist"))
      }
    }
    try makeApp(
      "Sample.app",
      plist: [
        "CFBundleIdentifier": "com.example.sample", "CFBundleName": "Sample",
        "CFBundleDisplayName": "Sample Pro",
      ])
    try makeApp("NoId.app", plist: ["CFBundleName": "NoId"])
    try makeApp("Broken.app", plist: nil)
    try makeApp("Vendor/Tool.app", plist: ["CFBundleIdentifier": "com.example.tool"])
    try FileManager.default.createDirectory(
      at: root.appendingPathComponent(".hidden.app"), withIntermediateDirectories: true)

    let apps = InstalledAppsScanner.scan(roots: [root], reader: FileAppBundleReader())
    #expect(apps.map(\.name) == ["Sample", "Tool"])
    #expect(apps[0].bundleId == "com.example.sample")
    #expect(apps[0].displayName == "Sample Pro")
    #expect(apps[0].bundleName == nil, "the same as the file name")
    #expect(apps[1].url.lastPathComponent == "Tool.app")
  }
}
