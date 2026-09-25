import AppKit
import DailyDoListClient
import DailyDoListDaemon
import DailyDoListModels
import DailyDoListUI
import DailyDoListUITestSupport
import Foundation
import SwiftUI
import Testing

@testable import DailyDoListApp

/// Settings → General → Vault and the import from Obsidian against the in-memory daemon: the
/// store, `import.progress` routing, the commands, and switching to the new vault (the app's
/// vault preference and a supervised restart, or the daemon's own switch).
@MainActor
@Suite("Import from Obsidian", .serialized)
struct ObsidianImportTests {
  static let obsidian = "/Users/me/Obsidian Notebook"
  static let newVault = "/Users/me/Obsidian Notebook (Daily Do List)"
  static let connection = DaemonConnectionInfo(
    baseURL: URL(string: "http://127.0.0.1:7331")!, token: "test-token")

  func client(_ remote: InMemoryDaemonClient.Remote = .standalone) -> InMemoryDaemonClient {
    InMemoryDaemonClient(
      seed: .demo, clock: .manual(start: referenceNow), agent: .disabled, clientId: "macos_test",
      remote: remote)
  }

  func store(_ client: DaemonClient) -> ObsidianImportStore {
    let store = ObsidianImportStore()
    store.client = client
    return store
  }

  // MARK: - The store

  @Test func loadsTheVaultAndReadsAReport() async {
    let client = client()
    let store = store(client)
    await store.load()
    #expect(store.vault == DeviceVaultResponse(path: "/Users/me/Demo Vault", lockedByEnv: false))
    #expect(store.imported == nil && store.job == nil && !store.syncs)
    #expect(await store.readReport(source: Self.obsidian))
    #expect(store.preview?.isObsidianVault == true)
    #expect(store.destination == Self.newVault)
    #expect(await store.readReport(source: "~/Nope") == false)
    #expect(store.preview == nil)
    #expect(store.error(.preview) == "There's no folder at ~/Nope")
  }

  @Test func importsWithProgressThenStartsOver() async {
    let client = client()
    let store = store(client)
    await store.readReport(source: Self.obsidian)
    #expect(await store.startImport())
    #expect(store.currentImport?.state == .running && store.isRunning)
    // A second start while one runs: the daemon's reason, and the running job stays.
    #expect(await store.startImport() == false)
    #expect(store.error(.start) == "An import or update is already running")
    await client.runUntilIdle()
    await store.refreshStatus()
    #expect(store.currentImport?.state == .done)
    #expect(store.currentImport?.result?.copied.files == 64)
    // A late running snapshot of the finished job doesn't bring it back.
    var late = store.currentImport!
    late.state = .running
    store.apply(late)
    #expect(store.currentImport?.state == .done)
    store.startOver()
    #expect(store.currentImport == nil && store.preview != nil)
  }

  @Test func cancelsAndSaysWhenNothingRuns() async {
    let client = client()
    let store = store(client)
    #expect(await store.cancel() == false)
    #expect(store.error(.cancel) == "No import or update is running")
    await store.readReport(source: "~/Plain notes")
    await store.startImport()
    await client.advance(by: .milliseconds(600))
    #expect(await store.cancel())
    #expect(store.currentImport?.state == .cancelled)
  }

  @Test func anOlderDaemonIsUnsupportedAndAPairedDeviceIsTold() async {
    let old = store(FakeDaemonClient())
    await old.load()
    #expect(old.isUnsupported && old.error(.load) == nil)

    let client = client()
    await client.simulateImportSettings(pairedDevice: true)
    let paired = store(client)
    await paired.load()
    #expect(paired.isForbidden)
    #expect(paired.error(.load) == ObsidianImportStore.pairedDeviceReason)
  }

  // MARK: - Events and commands

  @Test func progressEventsReachTheStoreAndTheEndIsAnnounced() async throws {
    let client = client()
    let model = AppModel(environment: makeEnvironment(client: client))
    await model.boot()
    try await eventually("connected") { model.connection.isOnline }
    _ = try await client.startObsidianImport(ObsidianImportRequest(source: Self.obsidian))
    try await eventually("the job") { model.imports.job?.state == .running }
    await client.runUntilIdle()
    try await eventually("the job to finish") { model.imports.job?.state == .done }
    #expect(
      model.toasts.toasts.contains {
        $0.title == "Import from Obsidian finished" && $0.actionLabel == "Open"
      })
    await model.teardown()
  }

  @Test func theCommandsOpenTheSheetUpdateAndRevealTheOldVault() async throws {
    let client = client()
    var environment = makeEnvironment(client: client)
    var revealed: [URL] = []
    environment.revealInFinder = { revealed.append($0) }
    environment.folderExists = { $0 == "/Users/me/Demo Vault" }
    let model = AppModel(environment: environment)
    await model.boot()
    try await eventually("connected") { model.connection.isOnline }
    let catalog = CommandCatalog(model: model)
    let names = catalog.paletteCommands.map(\.paletteTitle)
    #expect(names.contains("Import from Obsidian…"))
    #expect(!names.contains("Update from Obsidian"), "nothing to update from yet")
    #expect(catalog.command(.importFromObsidian)?.shortcut == nil)

    catalog.run(.importFromObsidian)
    #expect(model.ui.obsidianImportPresented && model.ui.settingsPane == .general)

    let job = try await client.startObsidianImport(ObsidianImportRequest(source: Self.obsidian))
    await client.runUntilIdle()
    // Its progress events reach the app before the switch, as they would before anyone clicks.
    try await eventually("the job to finish") { model.imports.job?.state == .done }
    _ = try await client.switchVault(DeviceVaultRequest(path: job.destination))
    await model.imports.load()
    #expect(model.imports.imported?.previousVault == "/Users/me/Demo Vault")
    #expect(catalog.paletteCommands.map(\.paletteTitle).contains("Update from Obsidian"))
    #expect(catalog.run(.revealPreviousVault))
    #expect(revealed == [URL(fileURLWithPath: "/Users/me/Demo Vault", isDirectory: true)])
    #expect(catalog.run(.updateFromObsidian))
    try await eventually("the update") { model.imports.job?.kind == .update }
    await model.teardown()
  }

  @Test func theVaultSectionsButtonsRunTheirCommandsAndSpellNoShortcut() async throws {
    let client = client()
    var environment = makeEnvironment(client: client)
    environment.folderExists = { _ in true }
    let model = AppModel(environment: environment)
    await model.boot()
    try await eventually("connected") { model.connection.isOnline }
    let job = try await client.startObsidianImport(ObsidianImportRequest(source: Self.obsidian))
    await client.runUntilIdle()
    // Its progress events reach the app before the switch, as they would before anyone clicks.
    try await eventually("the job to finish") { model.imports.job?.state == .done }
    _ = try await client.switchVault(DeviceVaultRequest(path: job.destination))
    await model.imports.load()
    let size = CGSize(width: 600, height: 520)
    let hosting = NSHostingView(
      rootView: Form { VaultSettingsSection(model: model, imports: model.imports) }
        .formStyle(.grouped)
        .environment(\.tooltipCenter, QuietTooltips.makeCenter()))
    let window = NSWindow(
      contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless],
      backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = hosting
    hosting.frame = NSRect(origin: .zero, size: size)
    window.setFrameOrigin(NSPoint(x: -20_000, y: -20_000))
    window.orderFrontRegardless()
    defer { window.close() }
    for _ in 0..<6 {
      hosting.layoutSubtreeIfNeeded()
      window.displayIfNeeded()
      SnapshotTests.pumpRunLoop(0.02)
    }
    let anchors = tooltipAnchors(in: hosting)
    for command in [CommandID.importFromObsidian, .updateFromObsidian, .revealPreviousVault] {
      let anchor = try #require(
        anchors.first { $0.command == command.rawValue }, "a control runs \(command.rawValue)")
      let content = try #require(anchor.tooltipContent())
      #expect(content.lines.first?.keys == command.shortcut)
      #expect(!content.plainText.contains(where: TooltipTests.modifierGlyphs.contains))
    }
    await model.teardown()
  }

  // MARK: - Switching

  /// A managed daemon this app launched, and the vault it opens from the app's preference.
  func managedModel(
    _ client: InMemoryDaemonClient, vaultPreference: String?
  ) async throws -> (AppModel, FakeSupervisor) {
    let supervisor = FakeSupervisor()
    let environment = makeEnvironment(client: client, supervisor: supervisor, mode: .managed)
    environment.preferences.vaultPath = vaultPreference
    let model = AppModel(environment: environment)
    await model.boot()
    supervisor.state = .running(pid: 41, connection: Self.connection)
    await model.imports.load()
    return (model, supervisor)
  }

  func importDone(_ model: AppModel, _ client: InMemoryDaemonClient) async throws -> String {
    await model.imports.readReport(source: Self.obsidian)
    await model.imports.startImport()
    await client.runUntilIdle()
    await model.imports.refreshStatus()
    return try #require(model.imports.currentImport?.destination)
  }

  @Test func withTheAppsVaultPreferenceItChangesItAndRestartsTheDaemon() async throws {
    let client = client()
    let (model, supervisor) = try await managedModel(
      client, vaultPreference: "/Users/me/Demo Vault")
    #expect(model.vaultSwitchMethod == .preference)
    let destination = try await importDone(model, client)
    let workspace = try #require(model.workspace)
    type("- [ ] Written just before switching", in: workspace)

    #expect(await model.switchVault(to: destination) == nil)
    #expect(model.preferences.vaultPath == destination)
    #expect(supervisor.configuration.vaultPath?.path == destination)
    #expect(supervisor.stopCount == 1, "restarted")
    #expect(model.phase == .ready && model.workspace !== workspace)
    let today = try #require(model.todayNotePath)
    #expect(try await client.readNote(today).content.contains("Written just before switching"))
    await model.teardown()
  }

  @Test func underTheAppsSupervisorTheDaemonSwitchesAndIsRelaunched() async throws {
    let client = client()
    let (model, supervisor) = try await managedModel(client, vaultPreference: nil)
    #expect(model.vaultSwitchMethod == .daemon)
    let destination = try await importDone(model, client)
    let switching = Task { await model.switchVault(to: destination) }
    try await eventually("waiting for the relaunch") {
      if case .booting(let text) = model.phase {
        text.hasPrefix("Restarting the daemon")
      } else {
        false
      }
    }
    supervisor.state = .running(pid: 42, connection: Self.connection)
    #expect(await switching.value == nil)
    #expect(model.phase == .ready)
    #expect(model.connection.health?.vaultName == "Obsidian Notebook (Daily Do List)")
    #expect(model.preferences.vaultPath == nil, "the daemon's config.json names the vault")
    await model.teardown()
  }

  @Test func anExternalDaemonSwitchesAndTheAppReconnectsOnceItOpensTheNewVault() async throws {
    let client = client()
    let model = AppModel(environment: makeEnvironment(client: client))
    await model.boot()
    await model.imports.load()
    let destination = try await importDone(model, client)
    #expect(await model.switchVault(to: destination) == nil)
    #expect(model.phase == .ready)
    try await eventually("the new vault's status") { model.imports.vault?.path == destination }
    #expect(model.imports.imported?.source == Self.obsidian)
    await model.teardown()
  }

  @Test func syncDDLVaultAndTheDemoBlockTheSwitchAndSayWhy() async throws {
    let syncing = client(.alwaysOn)
    let model = AppModel(environment: makeEnvironment(client: syncing))
    await model.boot()
    await model.imports.load()
    let destination = try await importDone(model, syncing)
    #expect(model.vaultSwitchBlocker?.hasPrefix("This device syncs its vault") == true)
    #expect(await model.switchVault(to: destination) == model.vaultSwitchBlocker)
    #expect(model.phase == .ready, "nothing happened")
    await model.teardown()

    let locked = client()
    await locked.simulateImportSettings(lockedByEnv: true)
    let lockedModel = AppModel(environment: makeEnvironment(client: locked))
    await lockedModel.boot()
    await lockedModel.imports.load()
    #expect(lockedModel.vaultSwitchBlocker?.contains("DDL_VAULT") == true)
    await lockedModel.teardown()

    let demo = AppModel(
      environment: makeEnvironment(
        client: client(), demo: true, demoClient: { InMemoryDaemonClient(clock: .manual()) }))
    await demo.boot()
    #expect(demo.vaultSwitchBlocker == "The demo can't switch vaults.")
    #expect(CommandCatalog(model: demo).command(.importFromObsidian)?.isEnabled() == false)
    await demo.teardown()
  }
}
