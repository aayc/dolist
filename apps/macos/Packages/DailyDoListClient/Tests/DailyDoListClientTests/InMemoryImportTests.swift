import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListClient

/// Importing from Obsidian and switching vaults in `InMemoryDaemonClient`, like the daemon.
struct InMemoryImportTests {
  static let obsidian = "/Users/me/Obsidian Notebook"

  static func client(_ remote: InMemoryDaemonClient.Remote = .standalone) -> InMemoryDaemonClient {
    InMemoryDaemonClient(seed: .demo, clock: .manual(), clientId: "macos_test", remote: remote)
  }

  static func http(_ status: Int, _ code: ApiErrorCode, _ body: () async throws -> Void) async {
    await InMemoryRemoteTests.http(status, code, body)
  }

  static func progress(_ recorder: StreamRecorder) -> [ObsidianImportJob] {
    recorder.events.compactMap { if case .importProgress(let job) = $0 { job } else { nil } }
  }

  @Test func thePreviewReportsTheVaultAndTheCarryOverPlan() async throws {
    let client = Self.client()
    let preview = try await client.previewObsidianImport(
      ObsidianImportPreviewRequest(source: "~/Obsidian Notebook/"))
    #expect(preview.source == Self.obsidian)
    #expect(preview.defaultDestination == "/Users/me/Obsidian Notebook (Daily Do List)")
    #expect(preview.isObsidianVault && preview.plugins.map(\.support).contains(.partial))
    #expect(preview.carryOver.vault == "/Users/me/Demo Vault")
    #expect(preview.carryOver.dailyNotesFrom == .obsidian)
    #expect(preview.carryOver.daily.count > 0)
    #expect(preview.carryOver.daily.items.allSatisfy { $0.to.hasPrefix("Journal/Daily/") })
    #expect(preview.carryOver.collisions.items.map(\.to) == ["Ideas (Daily Do List).md"])
    #expect(preview.warnings.contains { $0.contains("(Daily Do List)") })
    let plain = try await client.previewObsidianImport(
      ObsidianImportPreviewRequest(source: "/Users/me/Plain notes"))
    #expect(!plain.isObsidianVault && plain.settings.dailyNotes == nil)
  }

  @Test func anImportRunsThroughItsPhasesOneAtATime() async throws {
    let client = Self.client()
    let recorder = StreamRecorder(client.events())
    await client.connect()
    let job = try await client.startObsidianImport(ObsidianImportRequest(source: Self.obsidian))
    #expect(job.state == .running && job.phase == .checking)
    await Self.http(409, .conflict) {
      _ = try await client.startObsidianImport(ObsidianImportRequest(source: Self.obsidian))
    }
    await client.runUntilIdle()
    try await recorder.waitFor("the import to finish") {
      if case .event(.importProgress(let job)) = $0 { job.state == .done } else { false }
    }
    let phases = Self.progress(recorder).map(\.phase.rawValue)
    #expect(
      phases.reduce(into: [String]()) { if $0.last != $1 { $0.append($1) } }
        == ["checking", "copying", "carrying_over", "finishing"])
    let done = try #require(Self.progress(recorder).last)
    #expect(done.result?.copied == ObsidianImportCopied(files: 64, bytes: 3_482_112))
    await Self.http(400, .invalidRequest) {
      _ = try await client.startObsidianImport(
        ObsidianImportRequest(source: Self.obsidian, destination: done.destination))
    }
    let again = try await client.previewObsidianImport(
      ObsidianImportPreviewRequest(source: Self.obsidian))
    #expect(again.defaultDestination == "/Users/me/Obsidian Notebook (Daily Do List 2)")
    await client.disconnect()
  }

  @Test func cancellingStopsTheJobAndNothingRunsAfter() async throws {
    let client = Self.client()
    await Self.http(404, .notFound) { _ = try await client.cancelObsidianImport() }
    _ = try await client.startObsidianImport(ObsidianImportRequest(source: "~/Plain notes"))
    await client.advance(by: .milliseconds(600))
    let cancelled = try await client.cancelObsidianImport()
    #expect(cancelled.state == .cancelled && cancelled.phase == .copying)
    await client.runUntilIdle()
    #expect(try await client.obsidianImportStatus().job?.state == .cancelled)
  }

  @Test func switchingOpensTheNewVaultWhichKnowsWhereItCameFrom() async throws {
    let client = Self.client()
    let job = try await client.startObsidianImport(ObsidianImportRequest(source: Self.obsidian))
    await Self.http(400, .invalidRequest) {
      _ = try await client.switchVault(DeviceVaultRequest(path: job.destination))
    }
    await Self.http(409, .conflict) {
      _ = try await client.switchVault(DeviceVaultRequest(path: "~/Plain notes"))
    }
    await client.runUntilIdle()
    let switched = try await client.switchVault(DeviceVaultRequest(path: job.destination))
    #expect(
      switched
        == DeviceVaultResponse(path: job.destination, lockedByEnv: false, restart: .supervisor))
    #expect(try await client.deviceVault().path == job.destination)
    let status = try await client.obsidianImportStatus()
    #expect(status.job == nil)
    #expect(
      status.imported
        == ObsidianImportOrigin(
          source: Self.obsidian, importedAt: job.startedAt, previousVault: "/Users/me/Demo Vault"))
    let same = try await client.switchVault(DeviceVaultRequest(path: job.destination))
    #expect(same.restart == nil)
  }

  @Test func anUpdateBringsInWhatChangedInObsidian() async throws {
    let client = Self.client()
    await Self.http(404, .notFound) { _ = try await client.updateFromObsidian() }
    let job = try await client.startObsidianImport(ObsidianImportRequest(source: Self.obsidian))
    await client.runUntilIdle()
    _ = try await client.switchVault(DeviceVaultRequest(path: job.destination))
    let update = try await client.updateFromObsidian()
    #expect(update.kind == .update && update.destination == job.destination)
    await client.runUntilIdle()
    let status = try await client.obsidianImportStatus()
    #expect(status.job?.update?.added.paths == ["Journal/Phone notes.md"])
    #expect(status.imported?.updatedAt != nil)
    #expect(try await client.readNote("Journal/Phone notes.md").content.contains("phone"))
  }

  @Test func refusesLikeTheDaemon() async throws {
    let client = Self.client(.alwaysOn)
    await Self.http(400, .invalidRequest) {
      _ = try await client.previewObsidianImport(ObsidianImportPreviewRequest(source: "Notes"))
    }
    await Self.http(400, .invalidRequest) {
      _ = try await client.previewObsidianImport(ObsidianImportPreviewRequest(source: "~/Nope"))
    }
    await Self.http(400, .invalidRequest) {
      _ = try await client.previewObsidianImport(
        ObsidianImportPreviewRequest(source: "~/Demo Vault"))
    }
    let job = try await client.startObsidianImport(ObsidianImportRequest(source: "~/Plain notes"))
    await client.runUntilIdle()
    await Self.http(409, .conflict) {
      _ = try await client.switchVault(DeviceVaultRequest(path: job.destination))
    }
    await client.simulateImportSettings(lockedByEnv: true)
    #expect(try await client.deviceVault().lockedByEnv)
    await Self.http(409, .lockedByEnv) {
      _ = try await client.switchVault(DeviceVaultRequest(path: job.destination))
    }
    await client.simulateImportSettings(pairedDevice: true)
    await Self.http(403, .forbiddenDevice) { _ = try await client.deviceVault() }
    await Self.http(403, .forbiddenDevice) { _ = try await client.obsidianImportStatus() }
    await Self.http(403, .forbiddenDevice) { _ = try await client.updateFromObsidian() }
  }
}
