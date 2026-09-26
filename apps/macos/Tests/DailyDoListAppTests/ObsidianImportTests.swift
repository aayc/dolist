import AppKit
import DailyDoListClient
import DailyDoListClientTestSupport
import DailyDoListDaemon
import DailyDoListModels
import DailyDoListUI
import DailyDoListUITestSupport
import Foundation
import SwiftUI
import Testing

@testable import DailyDoListApp

/// Settings → General → Vault and the import from Obsidian with scripted daemon answers: the
/// store, `import.progress` routing, the commands, and switching to the new vault (the app's
/// vault preference and a supervised restart, or the daemon's own switch). The integration tests
/// run the real daemon's import.
@MainActor
@Suite("Import from Obsidian", .serialized)
struct ObsidianImportTests {
  nonisolated static let obsidian = "/Users/me/Obsidian Notebook"
  nonisolated static let newVault = "/Users/me/Obsidian Notebook (Daily Do List)"
  nonisolated static let oldVault = "/Users/me/Test Vault"
  nonisolated static let connection = DaemonConnectionInfo(
    baseURL: URL(string: "http://127.0.0.1:7331")!, token: "test-token")

  nonisolated static func job(
    _ state: ObsidianImportJobState, kind: ObsidianImportJobKind = .import, id: String = "imp_1"
  ) -> ObsidianImportJob {
    ObsidianImportJob(
      id: id, kind: kind, state: state, phase: state == .running ? .copying : .finishing,
      source: obsidian, destination: kind == .import ? newVault : oldVault, startedAt: 1,
      progress: ObsidianImportProgress(files: 1, totalFiles: 3, bytes: 10, totalBytes: 30))
  }

  nonisolated static func refusal(_ status: Int, _ code: ApiErrorCode, _ message: String)
    -> DaemonClientError
  {
    .http(status: status, body: ApiErrorBody(error: code, message: message))
  }

  nonisolated static let preview = try! JSONDecoder().decode(
    ObsidianImportPreview.self,
    from: Data(
      """
      {"source":"\(obsidian)","defaultDestination":"\(newVault)","isObsidianVault":true,
      "files":3,"bytes":30,"notes":2,"folders":1,"attachments":{"count":0,"bytes":0,"byType":[]},
      "settings":{"files":[],"dailyNotes":null,"editor":{},"vimrc":false},
      "templates":{"folder":null,"count":0},"plugins":[],"canvases":{"count":0,"paths":[]},
      "drawings":{"count":0,"paths":[]},"skipped":{"count":0,"items":[]},
      "carryOver":{"vault":"\(oldVault)","dailyNotes":{"folder":"","format":"YYYY-MM-DD",
      "template":""},"dailyNotesFrom":"obsidian","notes":{"count":0,"items":[]},
      "daily":{"count":0,"merged":0,"items":[]},"collisions":{"count":0,"items":[]},"routines":0,
      "drawings":0,"agent":{"threads":0,"detached":0,"records":0,"approvals":0,"routines":0,
      "trackedNotes":0,"journal":0},"watchedOpenTasks":0,"actOnExistingTasks":false,
      "leftBehind":{"count":0,"paths":[]}},"warnings":[]}
      """.utf8))

  /// A daemon on `oldVault` that switches like the real one: afterwards it serves the new vault,
  /// says it was imported, and its health names it.
  func client(
    restart: DaemonRestart = .supervisor, lockedByEnv: Bool = false, imported: Bool = false
  ) -> FakeDaemonClient {
    let client = FakeDaemonClient()
    let vault = Locked(imported ? Self.newVault : Self.oldVault)
    client.script {
      $0.deviceVault = { DeviceVaultResponse(path: vault.current, lockedByEnv: lockedByEnv) }
      $0.obsidianImportStatus = {
        ObsidianImportStatusResponse(
          job: nil,
          imported: vault.current == Self.oldVault
            ? nil
            : ObsidianImportOrigin(
              source: Self.obsidian, importedAt: 1, previousVault: Self.oldVault))
      }
      $0.previewObsidianImport = { _ in Self.preview }
      $0.updateFromObsidian = { Self.job(.running, kind: .update, id: "imp_2") }
      $0.switchVault = { [weak client] request in
        vault.mutate { $0 = request.path }
        client?.withState { $0.health.vaultName = (request.path as NSString).lastPathComponent }
        return DeviceVaultResponse(path: request.path, lockedByEnv: false, restart: restart)
      }
    }
    return client
  }

  func store(_ client: DaemonClient) -> ObsidianImportStore {
    let store = ObsidianImportStore()
    store.client = client
    return store
  }

  // MARK: - The store

  @Test func loadsTheVaultAndReadsAReport() async {
    let client = client()
    client.script {
      $0.previewObsidianImport = { request in
        guard request.source == Self.obsidian else {
          throw Self.refusal(400, .invalidRequest, "There's no folder at ~/Nope")
        }
        return Self.preview
      }
    }
    let store = store(client)
    await store.load()
    #expect(store.vault == DeviceVaultResponse(path: Self.oldVault, lockedByEnv: false))
    #expect(store.imported == nil && store.job == nil && !store.syncs && !store.isUnsupported)
    #expect(await store.readReport(source: Self.obsidian))
    #expect(store.preview?.isObsidianVault == true)
    #expect(store.destination == Self.newVault)
    #expect(await store.readReport(source: "~/Nope") == false)
    #expect(store.preview == nil)
    #expect(store.error(.preview) == "There's no folder at ~/Nope")
  }

  @Test func theJobFollowsTheDaemonAndARefusalSaysWhy() async {
    let client = client()
    let onDaemon = Locked<ObsidianImportJob?>(nil)
    client.script {
      $0.obsidianImportStatus = { ObsidianImportStatusResponse(job: onDaemon.current) }
      $0.cancelObsidianImport = {
        guard var job = onDaemon.current, job.state == .running else {
          throw Self.refusal(404, .notFound, "No import or update is running")
        }
        job.state = .cancelled
        return job
      }
      $0.startObsidianImport = { _ in
        guard onDaemon.current?.state != .running else {
          throw Self.refusal(409, .conflict, "An import or update is already running")
        }
        onDaemon.mutate { $0 = Self.job(.running) }
        return Self.job(.running)
      }
    }
    let store = store(client)
    #expect(await store.cancel() == false)
    #expect(store.error(.cancel) == "No import or update is running")
    await store.readReport(source: Self.obsidian)
    #expect(await store.startImport())
    #expect(store.currentImport?.state == .running && store.isRunning)
    #expect(await store.startImport() == false)
    #expect(store.error(.start) == "An import or update is already running")
    #expect(store.currentImport?.state == .running, "the running job stays")

    onDaemon.mutate { $0 = Self.job(.done) }
    await store.refreshStatus()
    #expect(store.currentImport?.state == .done)
    store.apply(Self.job(.running))
    #expect(store.currentImport?.state == .done, "a late running snapshot doesn't bring it back")
    store.startOver()
    #expect(store.currentImport == nil && store.preview != nil)

    onDaemon.mutate { $0 = Self.job(.running, id: "imp_3") }
    await store.refreshStatus()
    #expect(await store.cancel())
    #expect(store.currentImport?.state == .cancelled)
  }

  @Test func anOlderDaemonIsUnsupportedAndAPairedDeviceIsTold() async {
    let old = store(FakeDaemonClient())
    await old.load()
    #expect(old.isUnsupported && old.error(.load) == nil)

    let client = client()
    client.script {
      $0.deviceVault = {
        throw Self.refusal(403, .forbiddenDevice, "Only the Mac running the daemon can do this.")
      }
    }
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
    client.emit(.importProgress(Self.job(.running)))
    try await eventually("the job") { model.imports.job?.state == .running }
    client.emit(.importProgress(Self.job(.done)))
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
    environment.folderExists = { $0 == Self.oldVault }
    let model = AppModel(environment: environment)
    await model.boot()
    await model.imports.load()
    let catalog = CommandCatalog(model: model)
    let names = catalog.paletteCommands.map(\.paletteTitle)
    #expect(names.contains("Import from Obsidian…"))
    #expect(!names.contains("Update from Obsidian"), "nothing to update from yet")
    #expect(catalog.command(.importFromObsidian)?.shortcut == nil)

    catalog.run(.importFromObsidian)
    #expect(model.ui.obsidianImportPresented && model.ui.settingsPane == .general)

    _ = try await client.switchVault(DeviceVaultRequest(path: Self.newVault))
    await model.imports.load()
    #expect(model.imports.imported?.previousVault == Self.oldVault)
    #expect(catalog.paletteCommands.map(\.paletteTitle).contains("Update from Obsidian"))
    #expect(catalog.run(.revealPreviousVault))
    #expect(revealed == [URL(fileURLWithPath: Self.oldVault, isDirectory: true)])
    #expect(catalog.run(.updateFromObsidian))
    try await eventually("the update") { model.imports.job?.kind == .update }
    await model.teardown()
  }

  @Test func theVaultSectionsButtonsRunTheirCommandsAndSpellNoShortcut() async throws {
    var environment = makeEnvironment(client: client(imported: true))
    environment.folderExists = { _ in true }
    let model = AppModel(environment: environment)
    await model.boot()
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
    _ client: FakeDaemonClient, vaultPreference: String?
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

  @Test func withTheAppsVaultPreferenceItChangesItAndRestartsTheDaemon() async throws {
    let client = client()
    let (model, supervisor) = try await managedModel(client, vaultPreference: Self.oldVault)
    #expect(model.vaultSwitchMethod == .preference)
    let workspace = try #require(model.workspace)
    type("- [ ] Written just before switching", in: workspace)

    #expect(await model.switchVault(to: Self.newVault) == nil)
    #expect(model.preferences.vaultPath == Self.newVault)
    #expect(supervisor.configuration.vaultPath?.path == Self.newVault)
    #expect(supervisor.stopCount == 1, "restarted")
    #expect(client.calls("switchVault").isEmpty, "the daemon would refuse: DDL_VAULT fixes it")
    #expect(model.phase == .ready && model.workspace !== workspace)
    let today = try #require(model.todayNotePath)
    #expect(client.note(today)?.content.contains("Written just before switching") == true)
    await model.teardown()
  }

  @Test func underTheAppsSupervisorTheDaemonSwitchesAndIsRelaunched() async throws {
    let client = client()
    let (model, supervisor) = try await managedModel(client, vaultPreference: nil)
    #expect(model.vaultSwitchMethod == .daemon)
    let switching = Task { await model.switchVault(to: Self.newVault) }
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
    let model = AppModel(environment: makeEnvironment(client: client()))
    await model.boot()
    await model.imports.load()
    #expect(await model.switchVault(to: Self.newVault) == nil)
    #expect(model.phase == .ready)
    try await eventually("the new vault's status") { model.imports.vault?.path == Self.newVault }
    #expect(model.imports.imported?.source == Self.obsidian)
    await model.teardown()
  }

  @Test func syncDDLVaultAndTheDemoBlockTheSwitchAndSayWhy() async throws {
    let syncing = client()
    syncing.script {
      $0.syncStatus = {
        SyncStatusResponse(
          state: .idle, target: .remote, lastSyncedAt: nil, pendingChanges: 0, conflicts: [])
      }
    }
    let model = AppModel(environment: makeEnvironment(client: syncing))
    await model.boot()
    await model.imports.load()
    #expect(model.vaultSwitchBlocker?.hasPrefix("This device syncs its vault") == true)
    #expect(await model.switchVault(to: Self.newVault) == model.vaultSwitchBlocker)
    #expect(syncing.calls("switchVault").isEmpty && model.phase == .ready, "nothing happened")
    await model.teardown()

    let lockedModel = AppModel(environment: makeEnvironment(client: client(lockedByEnv: true)))
    await lockedModel.boot()
    await lockedModel.imports.load()
    #expect(lockedModel.vaultSwitchBlocker?.contains("DDL_VAULT") == true)
    await lockedModel.teardown()

    let demo = AppModel(environment: makeEnvironment(client: client(), demo: true))
    await demo.boot()
    #expect(demo.vaultSwitchBlocker == "The demo can't switch vaults.")
    #expect(CommandCatalog(model: demo).command(.importFromObsidian)?.isEnabled() == false)
    await demo.teardown()
  }
}
