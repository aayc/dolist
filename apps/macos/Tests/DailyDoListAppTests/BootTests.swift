import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListDaemon
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListApp

@MainActor
@Suite("Boot sequence")
struct BootTests {
  @Test func externalDaemonBootsToTodaysNote() async throws {
    let client = FakeDaemonClient(notes: ["Ideas.md": "ideas"])
    let model = AppModel(environment: makeEnvironment(client: client))
    await model.boot()
    #expect(model.phase == .ready)
    let workspace = try #require(model.workspace)
    #expect(workspace.activePath == "Daily/2026-09-23.md")
    #expect(workspace.editor.controller.text == "- [ ] ")
    #expect(workspace.vault.isFile("Ideas.md"))
    #expect(model.settings.isLoaded)
    #expect(model.todayNotePath == "Daily/2026-09-23.md")
    try await eventually("connected") { model.connection.isOnline }
    #expect(client.calls.contains("connect"))
    #expect(client.calls.contains("dailyNote:today"))
    await model.teardown()
  }

  @Test func managedDaemonIsStartedThroughTheSupervisor() async throws {
    let client = FakeDaemonClient()
    let supervisor = FakeSupervisor()
    let model = AppModel(
      environment: makeEnvironment(client: client, supervisor: supervisor, mode: .managed))
    await model.boot()
    #expect(model.phase == .ready)
    #expect(supervisor.startCount == 1)
    #expect(supervisor.configuration.manageProcess)
    #expect(model.connection.kind == .daemon(URL(string: "http://127.0.0.1:7331")!))
    await model.teardown()
  }

  @Test func supervisorRestartOnTheSameEndpointKeepsTheSession() async throws {
    let supervisor = FakeSupervisor()
    let model = AppModel(
      environment: makeEnvironment(
        client: FakeDaemonClient(), supervisor: supervisor, mode: .managed))
    await model.boot()
    let workspace = try #require(model.workspace)
    try await eventually("watching the supervisor") { supervisor.observerCount == 1 }
    let same = try #require(supervisor.startResult)
    supervisor.state = .restarting(attempt: 1, reason: "exited with code 1")
    supervisor.state = .running(pid: 42, connection: same)
    await settle()
    #expect(model.workspace === workspace, "the client reconnects by itself")
    #expect(supervisor.startCount == 1)
    await model.teardown()
  }

  @Test func supervisorRestartOnANewPortRebootsOntoIt() async throws {
    let supervisor = FakeSupervisor()
    let model = AppModel(
      environment: makeEnvironment(
        client: FakeDaemonClient(), supervisor: supervisor, mode: .managed))
    await model.boot()
    let workspace = try #require(model.workspace)
    try await eventually("watching the supervisor") { supervisor.observerCount == 1 }
    let moved = DaemonConnectionInfo(
      baseURL: URL(string: "http://127.0.0.1:7444")!, token: "new-token")
    supervisor.startResult = moved
    supervisor.state = .running(pid: 43, connection: moved)
    try await eventually("rebooted onto the new port") {
      model.phase == .ready && model.connection.kind == .daemon(moved.baseURL)
    }
    #expect(model.workspace !== workspace)
    #expect(model.clientEndpoint == DaemonEndpoint(baseURL: moved.baseURL, token: "new-token"))
    await model.teardown()
  }

  @Test func supervisorGivingUpOffersARestartAndRetryRestarts() async throws {
    let supervisor = FakeSupervisor()
    let model = AppModel(
      environment: makeEnvironment(
        client: FakeDaemonClient(), supervisor: supervisor, mode: .managed))
    await model.boot()
    try await eventually("watching the supervisor") { supervisor.observerCount == 1 }
    supervisor.state = .failed(reason: "The daemon crashed 5 times in a row.")
    try await eventually("a toast") {
      model.toasts.toasts.contains { $0.title == "The daemon stopped" }
    }
    let toast = try #require(model.toasts.toasts.first { $0.title == "The daemon stopped" })
    #expect(toast.body == "The daemon crashed 5 times in a row.")
    #expect(toast.actionLabel == "Restart")
    #expect(model.managedDaemonIsDown)

    await model.retry()
    #expect(model.phase == .ready)
    #expect(
      supervisor.startCount == 2, "retry restarts the daemon instead of reconnecting to nothing")
    await model.teardown()
  }

  @Test func unreachableDaemonShowsNotRunning() async {
    let client = FakeDaemonClient()
    client.fail("health", with: .unreachable("Connection refused"))
    let model = AppModel(environment: makeEnvironment(client: client))
    await model.boot()
    guard case .failed(let failure) = model.phase, case .daemonNotRunning = failure else {
      Issue.record("expected daemonNotRunning, got \(model.phase)")
      return
    }
    #expect(failure.offersStartDaemon)
    #expect(model.workspace == nil)
  }

  @Test func rejectedTokenShowsUnauthorized() async {
    let client = FakeDaemonClient()
    client.fail("health", with: .unauthorized)
    let model = AppModel(environment: makeEnvironment(client: client))
    await model.boot()
    guard case .failed(.unauthorized) = model.phase else {
      Issue.record("expected unauthorized, got \(model.phase)")
      return
    }
  }

  @Test func incompatibleApiVersionIsRefused() async {
    let client = FakeDaemonClient()
    client.withState { $0.health.apiVersion = DaemonProtocol.apiVersion + 1 }
    let model = AppModel(environment: makeEnvironment(client: client))
    await model.boot()
    #expect(model.phase == .failed(.incompatibleApiVersion(server: DaemonProtocol.apiVersion + 1)))
    #expect(!client.calls.contains("connect"), "no event stream to an incompatible daemon")
  }

  @Test func missingTokenInExternalModeExplainsHowToStart() async {
    let client = FakeDaemonClient()
    let model = AppModel(
      environment: makeEnvironment(
        client: client,
        discover: { home, _ in
          throw DaemonDiscoveryError.tokenFileMissing(
            path: home.appendingPathComponent("daemon-token").path)
        }))
    await model.boot()
    guard case .failed(.daemonNotRunning(let detail)) = model.phase else {
      Issue.record("expected daemonNotRunning, got \(model.phase)")
      return
    }
    #expect(detail.contains("No daemon token"))
    #expect(client.calls.isEmpty)
  }

  @Test(arguments: [
    (DaemonSupervisorError.nodeNotFound(searched: ["/opt/homebrew/bin/node"]), "node"),
    (.nodeUnsupported(found: ["v20.1.0"]), "node"),
    (.daemonEntryNotFound(searched: ["Resources/daemon"]), "entry"),
    (.portInUse(port: 7331, detail: "nginx"), "port"),
    (.tokenRejected(port: 7331, tokenFile: "daemon-token"), "token"),
    (.startupTimedOut(seconds: 20, logTail: ["listening…"]), "failed"),
  ])
  func supervisorFailuresAreClassified(error: DaemonSupervisorError, kind: String) async {
    let supervisor = FakeSupervisor()
    supervisor.failure = error
    let model = AppModel(
      environment: makeEnvironment(
        client: FakeDaemonClient(), supervisor: supervisor, mode: .managed))
    await model.boot()
    guard case .failed(let failure) = model.phase else {
      Issue.record("expected a failure, got \(model.phase)")
      return
    }
    switch (kind, failure) {
    case ("node", .nodeMissing): #expect(failure.helpURL != nil)
    case ("entry", .daemonNotFound), ("port", .portInUse), ("token", .unauthorized),
      ("failed", .daemonFailed):
      break
    default: Issue.record("\(error) classified as \(failure)")
    }
  }

  /// The demo runs a daemon of its own (the configuration the integration tests launch) and
  /// deletes its folder on quit.
  @Test func demoModeSupervisesItsOwnDaemonAndCleansUpOnQuit() async throws {
    let supervisor = FakeSupervisor(
      connection: DaemonConnectionInfo(
        baseURL: URL(string: "http://127.0.0.1:50123")!, token: "demo-token"))
    var environment = makeEnvironment(
      client: FakeDaemonClient(), supervisor: supervisor, mode: .external, demo: true)
    var removed: [URL] = []
    environment.removeFolder = { removed.append($0) }
    let model = AppModel(environment: environment)
    await model.boot()
    #expect(model.phase == .ready)
    #expect(supervisor.startCount == 1)
    #expect(supervisor.configuration == testDemoDaemon.configuration)
    #expect(model.connection.isDemo && model.managesDaemon)
    #expect(model.connection.kind == .demo(URL(string: "http://127.0.0.1:50123")!))
    await model.restartDaemon()
    #expect(supervisor.stopCount == 1 && supervisor.startCount == 2)
    #expect(supervisor.configuration == testDemoDaemon.configuration, "restarts keep its vault")
    await model.prepareForTermination()
    #expect(supervisor.stopCount == 2)
    #expect(removed == [testDemoDaemon.root])
  }

  @Test func eachDemoGetsANewFolderAndAFreePort() throws {
    let first = try DemoDaemon.make()
    let second = try DemoDaemon.make()
    #expect(first.root != second.root)
    #expect(first.root.path.hasPrefix(FileManager.default.temporaryDirectory.path))
    #expect(first.configuration.home.path.hasPrefix(first.root.path))
    #expect(first.configuration.vaultPath?.path.hasPrefix(first.root.path) == true)
    #expect(first.configuration.port != DaemonLaunchConfiguration.defaultPort)
    #expect(!FileManager.default.fileExists(atPath: first.root.path), "the daemon seeds it")
  }

  @Test func lastSessionTabsAreRestoredAndTodayIsAddedAsANewTab() async throws {
    let client = FakeDaemonClient(notes: ["Ideas.md": "ideas", "Projects/Plan.md": "plan"])
    let defaults = testDefaults()
    let environment = makeEnvironment(client: client, defaults: defaults)
    environment.preferences.lastOpenTabs = ["Ideas.md", "Projects/Plan.md", "Deleted.md"]
    environment.preferences.lastActiveTab = "Ideas.md"
    let model = AppModel(environment: environment)
    await model.boot()
    let workspace = try #require(model.workspace)
    #expect(workspace.tabs.tabs == ["Ideas.md", "Daily/2026-09-23.md", "Projects/Plan.md"])
    #expect(workspace.activePath == "Daily/2026-09-23.md")
    model.persistTabs()
    #expect(
      environment.preferences.lastOpenTabs == [
        "Ideas.md", "Daily/2026-09-23.md", "Projects/Plan.md",
      ])
    await model.teardown()
  }

  @Test func quittingFlushesUnsavedEdits() async throws {
    let client = FakeDaemonClient()
    let model = AppModel(environment: makeEnvironment(client: client))
    await model.boot()
    let workspace = try #require(model.workspace)
    type("- [ ] typed right before quitting", in: workspace)
    await model.prepareForTermination()
    #expect(client.note("Daily/2026-09-23.md")?.content == "- [ ] typed right before quitting")
    #expect(client.calls.contains("disconnect"))
  }
}
