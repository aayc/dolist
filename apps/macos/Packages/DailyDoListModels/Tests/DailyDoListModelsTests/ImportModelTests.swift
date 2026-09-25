import Foundation
import Testing

@testable import DailyDoListModels

/// The vault switch and the Obsidian import: what the daemon sends and what clients send back.
struct ImportModelTests {
  static func json<T: Encodable>(_ value: T) throws -> JSONValue {
    try JSONDecoder.daemon.decode(JSONValue.self, from: JSONEncoder.daemon.encode(value))
  }

  static func fixture<T: Decodable>(_ type: T.Type, _ schema: String, named prefix: String) throws
    -> T
  {
    let fixture = try #require(Fixtures.cases(schema).first { $0.name.hasPrefix(prefix) })
    return try Fixtures.decode(T.self, fixture.value)
  }

  @Test func thePreviewReadsLikeTheReportItIs() throws {
    let preview = try Self.fixture(
      ObsidianImportPreview.self, "ObsidianImportPreview", named: "an Obsidian vault")
    #expect(preview.isObsidianVault)
    #expect(preview.settings.dailyNotes?.format == "YYYY/MM/YYYY-MM-DD")
    #expect(
      preview.settings.editor.vimMode == true && preview.settings.editor.readableLineLength == nil)
    #expect(preview.settings.theme == .dark)
    #expect(preview.templates.folder == "Templates")
    #expect(preview.plugins.map(\.support) == [.partial, .supported, .unknown])
    #expect(preview.attachments.byType.first?.type == .image)
    #expect(preview.skipped.items.map(\.reason) == [.sidecar, .symlinkOutside])
    let plan = preview.carryOver
    #expect(plan.dailyNotesFrom == .obsidian)
    #expect(plan.daily.items.filter(\.merged).map(\.date) == ["2026-09-24"])
    #expect(plan.collisions.items == [ImportMove(from: "ideas.md", to: "ideas (Daily Do List).md")])
    #expect(plan.agent.detached == 1)
  }

  @Test func aPlainFolderHasNoDailyNotesOrTemplatesAndSaysSoWithNull() throws {
    let preview = try Self.fixture(
      ObsidianImportPreview.self, "ObsidianImportPreview", named: "a plain folder")
    #expect(preview.settings.dailyNotes == nil && preview.templates.folder == nil)
    #expect(preview.carryOver.dailyNotesFrom == .dailyDoList)
    guard case .object(let settings) = try Self.json(preview.settings),
      case .object(let templates) = try Self.json(preview.templates)
    else {
      Issue.record("objects expected")
      return
    }
    #expect(settings["dailyNotes"] == .null && templates["folder"] == .null)
  }

  @Test func jobsCarryTheirOutcome() throws {
    let done = try Self.fixture(
      ObsidianImportJobResponse.self, "ObsidianImportJobResponse", named: "a finished import"
    ).job
    #expect(done.kind == .import && done.state == .done && done.phase == .finishing)
    #expect(done.result?.copied == ObsidianImportCopied(files: 31, bytes: 2484))
    #expect(done.result?.manifest == ".daily-do-list/import/obsidian.json")

    let failed = try Self.fixture(
      ObsidianImportJobResponse.self, "ObsidianImportJobResponse", named: "a failed import"
    ).job
    #expect(failed.state == .failed && failed.phase == .carryingOver)
    #expect(failed.error == "Notes/Groceries.md in the current vault can't be read")

    let update = try Self.fixture(
      ObsidianImportJobResponse.self, "ObsidianImportJobResponse", named: "a finished update"
    ).job
    #expect(update.kind == .update && update.result == nil)
    #expect(update.update?.conflicts.items.first?.to == "Projects/Roadmap (Obsidian).md")
    #expect(update.update?.deletedInSource.paths == ["Projects/Café ☕/Idées d’été.md"])
  }

  @Test func noJobSinceStartIsNull() throws {
    let none = try Self.fixture(
      ObsidianImportStatusResponse.self, "ObsidianImportStatusResponse", named: "nothing")
    #expect(none.job == nil)
    #expect(try Self.json(none) == ["job": nil])
  }

  @Test func progressArrivesAsAnImportProgressEvent() throws {
    let fixture = try #require(
      Fixtures.cases("ServerEvent").first { $0.name == "import.progress while copying" })
    let event = try Fixtures.decode(ServerEvent.self, fixture.value)
    guard case .importProgress(let job) = event else {
      Issue.record("expected .importProgress, got \(event.type)")
      return
    }
    #expect(event.type == "import.progress")
    #expect(job.state == .running && job.phase == .copying)
    #expect(
      job.progress
        == ObsidianImportProgress(files: 12, totalFiles: 40, bytes: 1200, totalBytes: 3600))
    #expect(try Self.json(event) == fixture.value)
  }

  @Test func switchingVaultsSaysWhoRestartsTheDaemon() throws {
    let supervised = try Self.fixture(
      DeviceVaultResponse.self, "DeviceVaultResponse", named: "switching, the Mac app")
    #expect(supervised.restart == .supervisor)
    let settled = try Self.fixture(
      DeviceVaultResponse.self, "DeviceVaultResponse", named: "the vault from config.json")
    #expect(settled.restart == nil && !settled.lockedByEnv)
    let newer = try Fixtures.decode(
      DeviceVaultResponse.self,
      ["path": "/Users/me/Notes", "lockedByEnv": false, "restart": "launchd"])
    #expect(newer.restart?.rawValue == "launchd")
  }

  @Test func requestsEncodeOnlyWhatIsSet() throws {
    #expect(try Self.json(DeviceVaultRequest(path: "~/Notebook")) == ["path": "~/Notebook"])
    #expect(
      try Self.json(ObsidianImportPreviewRequest(source: "~/Obsidian")) == ["source": "~/Obsidian"])
    #expect(try Self.json(ObsidianImportRequest(source: "~/Obsidian")) == ["source": "~/Obsidian"])
    #expect(
      try Self.json(ObsidianImportRequest(source: "~/Obsidian", destination: "~/New"))
        == ["source": "~/Obsidian", "destination": "~/New"])
  }

  @Test func routesAndErrorCodes() {
    #expect(APIRoute.deviceVault == "/api/device/vault")
    #expect(APIRoute.importObsidianPreview == "/api/import/obsidian/preview")
    #expect(APIRoute.importObsidian == "/api/import/obsidian")
    #expect(APIRoute.importObsidianCancel == "/api/import/obsidian/cancel")
    #expect(APIRoute.importObsidianUpdate == "/api/import/obsidian/update")
    #expect(ApiErrorCode.forbiddenDevice.rawValue == "forbidden_device")
  }
}
