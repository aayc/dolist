import DailyDoListClient
import DailyDoListModels
import Foundation
import Testing

extension RealDaemonTests {
  @MainActor
  @Suite("Vault over REST")
  struct Vault {
    @Test func healthReportsACompatibleAPIVersion() async throws {
      let fixture = try Fixtures.current()
      let client = try fixture.makeClient()

      let health = try await client.health()

      #expect(health.ok)
      #expect(health.apiVersion == DaemonProtocol.apiVersion)
      #expect(DaemonProtocol.isCompatible(apiVersion: health.apiVersion))
      #expect(health.agentMode == .mock)
      #expect(health.vaultName == "vault")
      #expect(fixture.supervisor.health?.apiVersion == health.apiVersion)
      #expect(fixture.supervisor.health?.version == health.version)
    }

    @Test func aWrongTokenIsUnauthorized() async throws {
      let connection = try Fixtures.current().connection
      let client = HTTPDaemonClient(
        endpoint: DaemonEndpoint(
          baseURL: connection.baseURL, token: String(repeating: "0", count: 64)),
        session: URLSession(configuration: .ephemeral))

      #expect(await captureError { try await client.health() } == .unauthorized)
    }

    @Test func dailyNoteIsCreatedFromTheTemplateExactlyOnce() async throws {
      let client = try Fixtures.current().makeClient()
      _ = try await client.writeNote(
        "Templates/Daily.md", content: "# {{title}}\n\n{{date:dddd, MMMM D, YYYY}}\n\n- [ ] ",
        baseVersion: .unconditional)

      let first = try await client.dailyNote("2030-01-15", create: true)
      let second = try await client.dailyNote("2030-01-15", create: true)

      #expect(first.created)
      #expect(first.path == "Daily/2030-01-15.md")
      #expect(first.date == "2030-01-15")
      #expect(first.content == "# 2030-01-15\n\nTuesday, January 15, 2030\n\n- [ ] ")
      #expect(!second.created, "the second call returns the existing note")
      #expect(second.version == first.version)
      #expect(try await client.readNote(first.path).content == first.content)
      let missing = await captureError { try await client.dailyNote("2030-01-16", create: false) }
      #expect(missing?.httpStatus == 404)
      #expect(missing?.apiErrorCode == .notFound)
    }

    @Test func writesUseOptimisticConcurrency() async throws {
      let client = try Fixtures.current().makeClient()
      let path = "Projects/Launch plan \(unique()).md"

      let created = try await client.writeNote(path, content: "v1", baseVersion: .createOnly)
      let duplicate = await captureError {
        try await client.writeNote(path, content: "again", baseVersion: .createOnly)
      }
      let updated = try await client.writeNote(
        path, content: "v2", baseVersion: .match(created.version))
      let stale = await captureError {
        try await client.writeNote(
          path, content: "lost update", baseVersion: .match(created.version))
      }

      guard case .conflict(let exists)? = duplicate, case .conflict(let changed)? = stale else {
        Issue.record(
          "expected conflicts, got \(String(describing: duplicate)) and \(String(describing: stale))"
        )
        return
      }
      #expect(exists.error == .conflict)
      #expect(exists.current?.content == "v1", "the conflict carries the note as it is now")
      #expect(exists.current?.version == created.version)
      #expect(updated.version != created.version)
      #expect(changed.current?.content == "v2")
      #expect(changed.current?.version == updated.version)

      let read = try await client.readNote(path)
      #expect(read.content == "v2")
      #expect(read.version == updated.version)
      _ = try await client.writeNote(path, content: "v3", baseVersion: .unconditional)
      #expect(try await client.readNote(path).content == "v3")

      let missing = await captureError {
        try await client.readNote("Projects/Missing \(unique()).md")
      }
      #expect(missing?.httpStatus == 404)
      #expect(missing?.apiErrorCode == .notFound)
    }

    @Test func deletesAreSoftAndFoldersMoveAsAWhole() async throws {
      let fixture = try Fixtures.current()
      let client = try fixture.makeClient()
      let id = unique()

      _ = try await client.writeNote(
        "Scratch \(id)/Idea.md", content: "idea", baseVersion: .createOnly)
      let trashed = try await client.deleteNote("Scratch \(id)/Idea.md")
      #expect(trashed.ok)
      #expect(trashed.trashedTo.hasPrefix(".trash/"))
      #expect(
        FileManager.default.fileExists(
          atPath: fixture.vault.appendingPathComponent(trashed.trashedTo).path),
        "moved into the vault's trash, not deleted")
      var tree = try await client.tree()
      #expect(!tree.entries.contains { $0.path == "Scratch \(id)/Idea.md" })
      #expect(!tree.entries.contains { $0.path.hasPrefix(".trash") }, "the trash is hidden")

      #expect(try await client.createFolder("Areas \(id)/Health").path == "Areas \(id)/Health")
      _ = try await client.writeNote(
        "Areas \(id)/Health/Sleep.md", content: "8h", baseVersion: .createOnly)
      _ = try await client.writeNote(
        "Areas \(id)/Health/Food.md", content: "veg", baseVersion: .createOnly)
      let renamed = try await client.rename(from: "Areas \(id)", to: "Archive \(id)/Areas")
      #expect(renamed == .folder(FolderRenameResponse(path: "Archive \(id)/Areas", moved: 2)))
      tree = try await client.tree()
      #expect(
        tree.entries.contains {
          $0.path == "Archive \(id)/Areas/Health/Sleep.md" && $0.kind == .file
        })
      #expect(!tree.entries.contains { $0.path.hasPrefix("Areas \(id)") })

      let removed = try await client.deleteFolder("Archive \(id)")
      #expect(removed.trashedTo.hasPrefix(".trash/"))
      tree = try await client.tree()
      #expect(!tree.entries.contains { $0.path.hasPrefix("Archive \(id)") })

      _ = try await client.writeNote("Names \(id)/Old.md", content: "old", baseVersion: .createOnly)
      _ = try await client.writeNote(
        "Names \(id)/Taken.md", content: "taken", baseVersion: .createOnly)
      let moved = try await client.rename(from: "Names \(id)/Old.md", to: "Names \(id)/New.md")
      #expect(moved.path == "Names \(id)/New.md")
      #expect(try await client.readNote("Names \(id)/New.md").content == "old")
      let clash = await captureError {
        try await client.rename(from: "Names \(id)/New.md", to: "Names \(id)/Taken.md")
      }
      guard case .conflict(let conflict)? = clash else {
        Issue.record("expected a rename conflict, got \(String(describing: clash))")
        return
      }
      #expect(conflict.current?.content == "taken")
    }

    @Test func searchFindsNamesFirstThenMatchingLines() async throws {
      let client = try Fixtures.current().makeClient()
      let id = unique()
      _ = try await client.writeNote(
        "Search \(id)/Fox facts.md", content: "nothing to see", baseVersion: .createOnly)
      _ = try await client.writeNote(
        "Search \(id)/Notes.md", content: "first line\nThe quick brown FOX jumps\nlazy dog\n",
        baseVersion: .createOnly)

      let hits = try await client.search("fox", limit: nil).hits

      let name = try #require(
        hits.firstIndex { $0.kind == .name && $0.path == "Search \(id)/Fox facts.md" })
      let line = try #require(
        hits.firstIndex { $0.kind == .content && $0.path == "Search \(id)/Notes.md" })
      #expect(name < line, "name matches come first")
      #expect(hits[name].preview == "Search \(id)/Fox facts.md")
      #expect(hits[line].line == 1, "lines are 0-based")
      #expect(hits[line].preview == "The quick brown FOX jumps", "case-insensitive")
      #expect(
        try await client.search("quick fox", limit: nil).hits.map(\.path) == [
          "Search \(id)/Notes.md"
        ])
      #expect(
        try await client.search("quick dog", limit: nil).hits.isEmpty, "all terms on one line")
      #expect(try await client.search("fox", limit: 1).hits.count == 1)

      _ = try await client.writeNote(
        "Search \(id)/Gone.md", content: "zebra \(id)", baseVersion: .createOnly)
      #expect(try await client.search("zebra \(id)", limit: nil).hits.count == 1)
      _ = try await client.deleteNote("Search \(id)/Gone.md")
      #expect(
        try await client.search("zebra \(id)", limit: nil).hits.isEmpty,
        "trashed notes aren't searched")
    }

    @Test func settingsPatchesMergeAndInvalidValuesAreRejected() async throws {
      let client = try Fixtures.current().makeClient()
      let before = try await client.settings()

      let after = try await client.updateSettings(SettingsPatch(editor: .init(fontSize: 17)))
      let rejected = await captureError {
        try await client.updateSettings(SettingsPatch(editor: .init(fontSize: 500)))
      }

      #expect(after.editor.fontSize == 17)
      #expect(after.editor.vimMode == before.editor.vimMode, "untouched fields keep their values")
      #expect(after.dailyNotes == before.dailyNotes)
      #expect(rejected?.httpStatus == 400)
      #expect([ApiErrorCode.invalidRequest, .invalidSettings].contains(rejected?.apiErrorCode))
      #expect(try await client.settings().editor.fontSize == 17, "a rejected patch changes nothing")
      _ = try await client.updateSettings(
        SettingsPatch(editor: .init(fontSize: before.editor.fontSize)))
    }
  }
}
