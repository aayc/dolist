import Foundation
import Testing

@testable import DailyDoListMobileKit

struct WorkspaceSearchTests {
  @Test func offlineSearchUsesDurableEditsReportsCoverageAndKeepsZeroBasedLines() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let repository = try fixture.open()
    let note = try await repository.cache(
      RemoteNote(content: "Old value", version: "v1"), path: "Garden.md")
    _ = try await repository.save(
      path: note.path, content: "Heading\nCobalt lantern", expectedRevision: note.localRevision)
    _ = try await repository.create(path: "Cobalt.md", content: "A new draft")
    let reopened = try fixture.open()
    let result = try await reopened.search("cobalt")
    #expect(result.downloadedNotes == 2)
    #expect(result.hits.map(\.path) == ["Cobalt.md", "Garden.md"])
    #expect(result.hits.last?.line == 1)
    #expect(try await reopened.search("Old value").hits.isEmpty)
    #expect(try await reopened.search("cobalt", limit: 1).hits.count == 1)
  }
}
