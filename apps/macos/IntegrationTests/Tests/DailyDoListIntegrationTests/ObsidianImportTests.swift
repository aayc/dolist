import DailyDoListClient
import DailyDoListDaemon
import DailyDoListModels
import Foundation
import Testing

/// Importing a synthetic Obsidian vault with the real daemon (its own, in a temporary folder):
/// the report, the import and its events, the daemon refusing to switch while `DDL_VAULT` fixes
/// its vault, the switch the app makes then (the vault it passes, and a supervised restart), and
/// Update from Obsidian on the new vault.
@MainActor
@Suite(
  "Import from Obsidian (real daemon)", .serialized,
  .enabled(IntegrationEnvironment.skipReason) { await IntegrationEnvironment.isAvailable() })
struct ObsidianImportIntegrationTests {
  /// Invented content: config, two daily notes, a note, a canvas and an attachment.
  static let obsidianFiles: [String: String] = [
    ".obsidian/daily-notes.json":
      #"{"folder":"Journal/Daily","format":"YYYY/MM/YYYY-MM-DD","template":""}"#,
    ".obsidian/app.json": #"{"vimMode":true,"showLineNumber":false}"#,
    ".obsidian/community-plugins.json": #"["dataview","obsidian-excalidraw-plugin"]"#,
    "Journal/Daily/2026/09/2026-09-24.md": "- [x] Water the plants\n",
    "Journal/Daily/2026/09/2026-09-25.md": "- [ ] Call the plumber\n",
    "Projects/Garden.md": "# Garden\n- Raised beds\n",
    "Boards/Plan.canvas": #"{"nodes":[],"edges":[]}"#,
    "Attachments/scan.pdf": "%PDF-1.4\n%%EOF\n",
  ]

  static func write(_ files: [String: String], under root: URL) throws {
    for (path, content) in files {
      let url = root.appendingPathComponent(path)
      try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data(content.utf8).write(to: url)
    }
  }

  static func waitForJob(
    _ client: HTTPDaemonClient, until done: (ObsidianImportJob) -> Bool
  ) async throws -> ObsidianImportJob {
    let deadline = Date().addingTimeInterval(30)
    while Date() < deadline {
      if let job = try await client.obsidianImportStatus().job, done(job) { return job }
      try await Task.sleep(for: .milliseconds(100))
    }
    throw FixtureError("the import didn't finish")
  }

  @Test func previewImportSwitchAndUpdate() async throws {
    let fixture = try await DaemonFixture.launch()
    do {
      try await run(fixture)
    } catch {
      await fixture.shutdown()
      throw error
    }
    await fixture.shutdown()
  }

  private func run(_ fixture: DaemonFixture) async throws {
    let source = fixture.root.appendingPathComponent("Obsidian Notebook")
    try Self.write(Self.obsidianFiles, under: source)
    let destination = fixture.root.appendingPathComponent("Imported")
    let (client, log) = try await connectedClient(fixture)
    let vault = try await client.deviceVault()
    #expect(vault.lockedByEnv, "the fixture passes DDL_VAULT, like the app")
    let resolved = try #require(realpath(vault.path, nil))
    defer { free(resolved) }
    let realVault = String(cString: resolved)

    let preview = try await client.previewObsidianImport(
      ObsidianImportPreviewRequest(source: source.path))
    #expect(preview.isObsidianVault)
    #expect(preview.notes == 3)
    #expect(preview.canvases.count == 1)
    #expect(preview.settings.dailyNotes?.folder == "Journal/Daily")
    #expect(preview.plugins.map(\.id) == ["dataview", "obsidian-excalidraw-plugin"])
    #expect(preview.carryOver.vault == realVault)
    #expect(
      !FileManager.default.fileExists(atPath: destination.path), "a preview writes nothing")

    let started = try await client.startObsidianImport(
      ObsidianImportRequest(source: source.path, destination: destination.path))
    #expect(started.kind == .import)
    let done = try await Self.waitForJob(client) { $0.state != .running }
    #expect(done.state == .done, "\(done.error ?? "")")
    #expect(done.result?.copied.files == Self.obsidianFiles.count)
    _ = try await log.index(from: 0, for: "import.progress") { item in
      if case .event(.importProgress(let job)) = item { return job.id == started.id }
      return false
    }
    let copied = try String(
      contentsOf: destination.appendingPathComponent("Projects/Garden.md"), encoding: .utf8)
    #expect(copied == Self.obsidianFiles["Projects/Garden.md"])

    // The daemon can't switch a vault DDL_VAULT fixes; the app passes it the new vault instead.
    do {
      _ = try await client.switchVault(DeviceVaultRequest(path: done.destination))
      Issue.record("expected 409 locked_by_env")
    } catch let error as DaemonClientError {
      #expect(error.apiErrorCode == .lockedByEnv)
    }
    await client.disconnect()
    fixture.supervisor.configuration.vaultPath = URL(
      fileURLWithPath: done.destination, isDirectory: true)
    #expect(await fixture.supervisor.restart() != nil, "\(fixture.logTail)")

    let reopened = try fixture.makeClient()
    #expect(try await reopened.deviceVault().path == done.destination)
    let status = try await reopened.obsidianImportStatus()
    #expect(status.job == nil, "a new daemon")
    #expect(status.imported?.source == preview.source)
    #expect(status.imported?.previousVault == realVault)

    try Self.write(
      ["Journal/Daily/2026/09/2026-09-26.md": "- [ ] Written on the phone\n"], under: source)
    let update = try await reopened.updateFromObsidian()
    #expect(update.kind == .update)
    let updated = try await Self.waitForJob(reopened) { $0.id == update.id && $0.state != .running }
    #expect(updated.update?.added.paths == ["Journal/Daily/2026/09/2026-09-26.md"])
    #expect(try await reopened.obsidianImportStatus().imported?.updatedAt != nil)
  }
}
