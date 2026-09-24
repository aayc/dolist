import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListClient

/// REST semantics of `InMemoryDaemonClient` (vault, daily notes, search, settings).
struct InMemoryVaultTests {
  static func client(_ seed: InMemoryDaemonClient.Seed = .empty, agent: AgentSimulation = .enabled) -> InMemoryDaemonClient {
    InMemoryDaemonClient(seed: seed, clock: .immediate(), agent: agent, clientId: "macos_test")
  }

  @Test func writeReadAndVersions() async throws {
    let client = Self.client()
    let created = try await client.writeNote("Notes/Café.md", content: "hello", baseVersion: .createOnly)
    #expect(created == WriteNoteResponse(path: "Notes/Café.md", version: "106f3a63cd7226", mtime: 1_790_155_800_000))
    let note = try await client.readNote("Notes//./Café.md")
    #expect(note == NoteResponse(path: "Notes/Café.md", content: "hello", version: "106f3a63cd7226", mtime: 1_790_155_800_000))
    let updated = try await client.writeNote("Notes/Café.md", content: "hello!", baseVersion: .match(note.version))
    #expect(updated.version != note.version)
    let forced = try await client.writeNote("Notes/Café.md", content: "forced", baseVersion: .unconditional)
    #expect(try await client.readNote("Notes/Café.md").version == forced.version)
    let tree = try await client.tree()
    #expect(tree.vaultName == "Empty Vault")
    #expect(tree.entries == [
      VaultEntry(path: "Notes", kind: .folder),
      VaultEntry(path: "Notes/Café.md", kind: .file, size: 6, mtime: 1_790_155_800_000, version: forced.version),
    ])
  }

  @Test func baseVersionConflictsCarryTheCurrentNote() async throws {
    let client = Self.client(.files(["Ideas.md": "theirs"]))
    let current = try await client.readNote("Ideas.md")
    await #expect(throws: DaemonClientError.conflict(ConflictResponse(current: current))) {
      try await client.writeNote("Ideas.md", content: "mine", baseVersion: .createOnly)
    }
    await #expect(throws: DaemonClientError.conflict(ConflictResponse(current: current))) {
      try await client.writeNote("Ideas.md", content: "mine", baseVersion: .match("stale"))
    }
    await #expect(throws: DaemonClientError.conflict(ConflictResponse(current: nil))) {
      try await client.writeNote("Gone.md", content: "mine", baseVersion: .match("stale"))
    }
    #expect(try await client.readNote("Ideas.md").content == "theirs")
  }

  @Test func invalidPathsAndMissingNotes() async throws {
    let client = Self.client(.files(["a.md": "x"]))
    for path in ["../escape.md", ".obsidian/app.json", ".daily-do-list/x.md", "", "image.png", "a\u{1}b.md"] {
      do {
        _ = try await client.readNote(path)
        Issue.record("\(path) should be invalid")
      } catch let error as DaemonClientError {
        #expect(error.httpStatus == 400 && error.apiErrorCode == .invalidPath, "\(path): \(error)")
      }
    }
    await #expect(throws: DaemonClientError.http(status: 404, body: ApiErrorBody(error: .notFound, message: "No note at \"missing.md\""))) {
      try await client.readNote("missing.md")
    }
  }

  @Test func softDeleteMovesToTrashWithCollisionSuffixes() async throws {
    let client = Self.client()
    _ = try await client.writeNote("Ideas.md", content: "one", baseVersion: .unconditional)
    #expect(try await client.deleteNote("Ideas.md") == TrashResponse(trashedTo: ".trash/Ideas.md"))
    _ = try await client.writeNote("Ideas.md", content: "two", baseVersion: .unconditional)
    #expect(try await client.deleteNote("Ideas.md") == TrashResponse(trashedTo: ".trash/Ideas (2026-09-23 093000).md"))
    _ = try await client.writeNote("Ideas.md", content: "three", baseVersion: .unconditional)
    #expect(try await client.deleteNote("Ideas.md") == TrashResponse(trashedTo: ".trash/Ideas (2026-09-23 093000 2).md"))
    #expect(try await client.tree().entries.isEmpty, "trash is hidden")
    await #expect(throws: DaemonClientError.self) { try await client.readNote(".trash/Ideas.md") }
    await #expect(throws: DaemonClientError.http(status: 404, body: ApiErrorBody(error: .notFound, message: "No note at \"Ideas.md\""))) {
      try await client.deleteNote("Ideas.md")
    }
  }

  @Test func renamesNotesAndFolders() async throws {
    let client = Self.client(.files(["Projects/a.md": "A", "Projects/sub/b.md": "B", "Other.md": "O", "Taken.md": "T"]))
    let renamed = try await client.rename(from: "Other.md", to: "Archive/Other 2026.md")
    guard case .note(let note) = renamed else { throw TimeoutError(description: "expected a note rename") }
    #expect(note.path == "Archive/Other 2026.md")
    #expect(try await client.readNote("Archive/Other 2026.md").content == "O")

    let taken = try await client.readNote("Taken.md")
    await #expect(throws: DaemonClientError.conflict(ConflictResponse(current: taken))) {
      try await client.rename(from: "Archive/Other 2026.md", to: "Taken.md")
    }
    _ = try await client.createFolder("Dir.md")
    await #expect(throws: DaemonClientError.conflict(ConflictResponse(current: nil))) {
      try await client.rename(from: "Taken.md", to: "Dir.md")
    }
    await #expect(throws: DaemonClientError.http(status: 404, body: ApiErrorBody(error: .notFound, message: "No note at \"nope.md\""))) {
      try await client.rename(from: "nope.md", to: "x.md")
    }
    await #expect(throws: DaemonClientError.http(status: 400, body: ApiErrorBody(error: .invalidRequest, message: "Source and target are the same"))) {
      try await client.rename(from: "Taken.md", to: "./Taken.md")
    }

    #expect(try await client.rename(from: "Projects", to: "Work/Projects") == .folder(FolderRenameResponse(path: "Work/Projects", moved: 2)))
    #expect(try await client.readNote("Work/Projects/sub/b.md").content == "B")
    let paths = try await client.tree().entries.map(\.path)
    #expect(!paths.contains("Projects") && paths.contains("Work/Projects/sub"))
    _ = try await client.createFolder("Existing")
    await #expect(throws: DaemonClientError.http(status: 409, body: ApiErrorBody(error: .conflict, message: "\"Existing\" already exists"))) {
      try await client.rename(from: "Work", to: "Existing")
    }
    await #expect(throws: DaemonClientError.http(status: 409, body: ApiErrorBody(error: .conflict, message: "\"Work/Projects/Inner\" already exists or is inside \"Work/Projects\""))) {
      try await client.rename(from: "Work/Projects", to: "Work/Projects/Inner")
    }
  }

  @Test func foldersAreCreatedAndSoftDeleted() async throws {
    let client = Self.client(.files(["Projects/a.md": "A", "Projects/deep/b.md": "B"]))
    #expect(try await client.createFolder("Empty/Nested") == CreateFolderResponse(path: "Empty/Nested"))
    #expect(try await client.createFolder("Empty/Nested") == CreateFolderResponse(path: "Empty/Nested"), "idempotent")
    #expect(try await client.deleteFolder("Projects") == TrashResponse(trashedTo: ".trash/Projects"))
    let paths = try await client.tree().entries.map(\.path)
    #expect(paths == ["Empty", "Empty/Nested"])
    _ = try await client.writeNote("Projects/a.md", content: "again", baseVersion: .unconditional)
    #expect(try await client.deleteFolder("Projects") == TrashResponse(trashedTo: ".trash/Projects (2026-09-23 093000)"))
    #expect(try await client.deleteFolder("Empty") == TrashResponse(trashedTo: ".trash/Empty"))
    await #expect(throws: DaemonClientError.http(status: 404, body: ApiErrorBody(error: .notFound, message: "No folder at \"Nope\""))) {
      try await client.deleteFolder("Nope")
    }
    await #expect(throws: DaemonClientError.self) { try await client.createFolder("../out") }
  }

  @Test func dailyNotesAreCreatedFromTheTemplateOnce() async throws {
    let client = Self.client(.files(["Templates/Daily.md": "# {{title}}\n- [ ] "]))
    await #expect(throws: DaemonClientError.http(status: 404, body: ApiErrorBody(error: .notFound, message: "No daily note for 2026-09-23"))) {
      try await client.dailyNote("today", create: false)
    }
    let created = try await client.dailyNote("today", create: true)
    #expect(created.path == "Daily/2026-09-23.md" && created.date == "2026-09-23" && created.created)
    #expect(created.content == "# 2026-09-23\n- [ ] ")
    let again = try await client.dailyNote("2026-09-23", create: true)
    #expect(!again.created && again.version == created.version && again.note == created.note)
    await #expect(throws: DaemonClientError.http(status: 400, body: ApiErrorBody(error: .invalidRequest, message: "Date must be \"today\" or YYYY-MM-DD"))) {
      try await client.dailyNote("2023-02-29", create: true)
    }
    let empty = Self.client()
    #expect(try await empty.dailyNote("2026-09-24", create: true).content == "- [ ] ")
  }

  @Test func todayFollowsTheLocalTimeZone() async throws {
    // 2026-09-23 23:30 UTC is already the 24th in Tokyo and still the 23rd in Los Angeles.
    let instant = Date(timeIntervalSince1970: 1_790_206_200)
    let tokyo = InMemoryDaemonClient(seed: .empty, clock: .immediate(start: instant, timeZone: TimeZone(identifier: "Asia/Tokyo")!))
    let losAngeles = InMemoryDaemonClient(seed: .empty, clock: .immediate(start: instant, timeZone: TimeZone(identifier: "America/Los_Angeles")!))
    #expect(try await tokyo.dailyNote("today", create: true).date == "2026-09-24")
    #expect(try await losAngeles.dailyNote("today", create: true).date == "2026-09-23")
  }

  @Test func searchMatchesEveryTermNamesFirst() async throws {
    let client = Self.client(.files([
      "Groceries.md": "- [ ] Buy milk\n- [ ] buy eggs and MILK\nnothing here",
      "Buy milk list.md": "Buy it all",
      "Notes/Other.md": "milk\nbuy",
      "script.txt": "buy milk",
    ]))
    let hits = try await client.search("  MILK buy ", limit: nil).hits
    #expect(hits == [
      SearchHit(path: "Buy milk list.md", kind: .name, line: 0, preview: "Buy milk list.md"),
      SearchHit(path: "Groceries.md", kind: .content, line: 0, preview: "- [ ] Buy milk"),
      SearchHit(path: "Groceries.md", kind: .content, line: 1, preview: "- [ ] buy eggs and MILK"),
    ])
    #expect(try await client.search("milk", limit: 2).hits.count == 2)
    #expect(try await client.search("   ", limit: nil).hits.isEmpty)
    #expect(try await client.search("notes/oth", limit: nil).hits.first == SearchHit(path: "Notes/Other.md", kind: .name, line: 0, preview: "Notes/Other.md"))
    await #expect(throws: DaemonClientError.self) { try await client.search("x", limit: 0) }
    await #expect(throws: DaemonClientError.self) { try await client.search(String(repeating: "x", count: 501), limit: nil) }
  }

  @Test func settingsPatchesAreValidatedAndMerged() async throws {
    let client = Self.client()
    let recorder = StreamRecorder(client.events())
    await client.connect()
    let updated = try await client.updateSettings(
      SettingsPatch(theme: .dark, editor: .init(fontSize: 13.5), agent: .init(model: "  mock/other  ", watch: .init(futureDays: 14))))
    #expect(updated.theme == .dark && updated.editor.fontSize == 13.5 && updated.agent.watch.futureDays == 14)
    #expect(updated.agent.model == "mock/other", "model ids are trimmed")
    #expect(updated.agent.watch.pastDays == 0 && updated.editor.vimMode == false, "untouched fields keep their values")
    #expect(try await client.settings() == updated)

    for patch in [
      SettingsPatch(editor: .init(fontSize: 400)), SettingsPatch(agent: .init(settleMs: -1)),
      SettingsPatch(agent: .init(maxConcurrentSubagents: 0)), SettingsPatch(agent: .init(approvalTimeoutMs: 1000)),
      SettingsPatch(agent: .init(model: "   ")), SettingsPatch(agent: .init(watch: .init(pastDays: 400))),
      SettingsPatch(dailyNotes: .init(folder: ".hidden")), SettingsPatch(dailyNotes: .init(folder: "../out")),
      SettingsPatch(dailyNotes: .init(template: ".daily-do-list/t.md")),
      SettingsPatch(weeklyNotes: .init(format: String(repeating: "Y", count: 129))),
    ] {
      do {
        _ = try await client.updateSettings(patch)
        Issue.record("\(patch) should be rejected")
      } catch let error as DaemonClientError {
        #expect(error.httpStatus == 400 && error.apiErrorCode == .invalidRequest, "\(error)")
      }
    }
    #expect(try await client.settings() == updated, "rejected patches change nothing")

    let status = try await client.setAgentEnabled(false)
    #expect(!status.enabled)
    #expect(try await client.settings().agent.enabled == false)
    await client.disconnect()
    try await recorder.waitForFinish()
    let settingsEvents = recorder.events.filter { if case .settingsChanged = $0 { true } else { false } }
    #expect(settingsEvents.count == 2)
    #expect(recorder.events.contains(.agentStatus(status)))
  }

  @Test func ownWritesAreAttributedAndExternalOnesAreNot() async throws {
    let client = Self.client()
    let recorder = StreamRecorder(client.events())
    await client.connect()
    let first = try await client.writeNote("a.md", content: "1", baseVersion: .createOnly)
    let second = try await client.writeNote("a.md", content: "2", baseVersion: .match(first.version))
    _ = try await client.rename(from: "a.md", to: "b.md")
    _ = try await client.deleteNote("b.md")
    try await client.simulateExternalEdit("c.md", content: "from Obsidian")
    await client.disconnect()
    try await recorder.waitForFinish()
    let changes = recorder.events.compactMap { if case .vaultChanged(let event) = $0 { event } else { nil } }
    #expect(changes == [
      VaultChangedEvent(changes: [VaultChange(path: "a.md", kind: .created, version: first.version)], origin: .client, clientId: "macos_test"),
      VaultChangedEvent(changes: [VaultChange(path: "a.md", kind: .modified, version: second.version)], origin: .client, clientId: "macos_test"),
      VaultChangedEvent(
        changes: [VaultChange(path: "a.md", kind: .deleted), VaultChange(path: "b.md", kind: .created, version: second.version)],
        origin: .client, clientId: "macos_test"),
      VaultChangedEvent(changes: [VaultChange(path: "b.md", kind: .deleted)], origin: .client, clientId: "macos_test"),
      VaultChangedEvent(changes: [VaultChange(path: "c.md", kind: .created, version: ContentHash.version(of: "from Obsidian"))], origin: .external),
    ])
  }

  @Test func eventsFlowOnlyWhileConnected() async throws {
    let client = Self.client()
    let before = StreamRecorder(client.events())
    _ = try await client.writeNote("quiet.md", content: "x", baseVersion: .unconditional)
    await client.connect()
    await client.connect()
    _ = try await client.writeNote("loud.md", content: "x", baseVersion: .unconditional)
    await client.disconnect()
    try await before.waitForFinish()
    #expect(before.items.prefix(4) == [
      .state(.idle), .state(.connecting), .state(.connected(serverVersion: FakeDaemon.serverVersion)),
      .event(.hello(HelloEvent(serverVersion: FakeDaemon.serverVersion, apiVersion: 1))),
    ])
    #expect(before.events.count == 2, "hello + the write made while connected")
    #expect(before.items.last == .state(.disconnected))

    let after = StreamRecorder(client.events())
    await client.connect()
    try await after.waitFor("resync") { $0 == .resync }
    #expect(after.items == [
      .state(.disconnected), .state(.connecting), .state(.connected(serverVersion: FakeDaemon.serverVersion)),
      .event(.hello(HelloEvent(serverVersion: FakeDaemon.serverVersion, apiVersion: 1))), .resync,
    ])
    await client.disconnect()
  }

  @Test func demoSeedHasHistoryAndTodaysNote() async throws {
    let client = InMemoryDaemonClient(seed: .demo, clock: .immediate())
    let paths = try await client.tree().entries.map(\.path)
    for expected in ["Daily", "Projects", "Templates", "Daily/2026-09-23.md", "Daily/2026-09-22.md", "Daily/2026-09-21.md",
                     "Daily/2026-09-19.md", "Templates/Daily.md", "Ideas.md", "Welcome.md", "Projects/Garden Redesign.md"] {
      #expect(paths.contains(expected), "\(expected) missing")
    }
    #expect(!paths.contains("Daily/2026-09-20.md"), "history has a gap")
    let today = try await client.dailyNote("today", create: true)
    #expect(!today.created && today.content.hasSuffix("\n- [ ] "))
    #expect(try await client.readNote("Templates/Daily.md").content == "- [ ] ")
    let records = try await client.taskRecords(notePath: today.path)
    #expect(records.count == 2 && records.allSatisfy { $0.status == .done && $0.threadId != nil && $0.date == "2026-09-23" })
    let threads = try await client.threads(notePath: nil, taskId: nil)
    #expect(threads.count == 5 && threads.allSatisfy { $0.status == .done })
    let decided = try await client.approvals(status: .approved)
    #expect(decided.count == 2)
    #expect(try await client.approvals(status: .pending).isEmpty)
    let health = try await client.health()
    #expect(health == HealthResponse(version: FakeDaemon.serverVersion, apiVersion: 1, vaultName: "Demo Vault", agentMode: .mock))
    #expect(await client.waitUntilHealthy(timeout: .seconds(1)))
  }
}
