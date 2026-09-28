import Foundation
import Testing

@testable import DailyDoListMobileKit

struct WorkspaceBoundedSearchTests {
  @Test func largeVaultMetadataAndSearchNeverMaterializeAllCheckpoints() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let index = try SQLiteWorkspaceIndex(
      url: fixture.directory.appendingPathComponent("index.sqlite"), scope: fixture.scope)
    let files = try MarkdownCheckpointStore(
      directory: fixture.directory.appendingPathComponent("text"))
    let clean = try files.put("needle from host")
    let dirty = try files.put("Unsent\n\nneedle from this phone")
    for number in 0..<1_000 {
      try index.commit(
        record(path: String(format: "Clean-%04d.md", number), reference: clean, state: .synced),
        pending: nil)
    }
    try index.commit(
      record(path: "Z-draft.md", reference: dirty, state: .waitingToSync), pending: nil)
    let reads = SearchCheckpointReads(files: files)
    let repository = try WorkspaceRepository(scope: fixture.scope, index: index, checkpoints: reads)

    let metadata = try await repository.cachedDocumentMetadata()
    #expect(metadata.count == 1_001)
    let draft = try #require(metadata.first { $0.path == "Z-draft.md" })
    #expect(
      draft.baseVersion == "v1" && draft.localRevision == 2 && draft.acknowledgedRevision == 1)
    #expect(reads.references.isEmpty)
    #expect(try await repository.search(" ").hits.isEmpty)
    #expect(reads.references.isEmpty)

    let first = try await repository.search("needle", limit: 1)
    #expect(first.hits.map(\.path) == ["Z-draft.md"])
    #expect(first.hits.first?.line == 2)
    #expect(first.downloadedNotes == 1_001 && first.searchedNotes == 1 && !first.isComplete)
    #expect(reads.references == [dirty])
    reads.reset()

    let bounded = try await repository.search(
      "needle", scanLimits: .init(maximumDocuments: 3, maximumBytes: 100))
    #expect(bounded.hits.count == 3 && bounded.hits.first?.path == "Z-draft.md")
    #expect(bounded.searchedNotes == 3 && !bounded.isComplete)
    #expect(reads.references.count == 3)
  }

  @Test func backlinkScanReservesLiveTextAndByteBudgetBeforeReadingOtherFiles() async throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let index = try SQLiteWorkspaceIndex(
      url: fixture.directory.appendingPathComponent("index.sqlite"), scope: fixture.scope)
    let files = try MarkdownCheckpointStore(
      directory: fixture.directory.appendingPathComponent("text"))
    let large = try files.put(String(repeating: "x", count: 100_000))
    let dirty = try files.put("[[Topic]]")
    let small = try files.put("short")
    try index.commit(record(path: "A-large.md", reference: large, state: .synced), pending: nil)
    try index.commit(record(path: "B-small.md", reference: small, state: .synced), pending: nil)
    try index.commit(record(path: "C-small.md", reference: small, state: .synced), pending: nil)
    try index.commit(
      record(path: "Z-dirty.md", reference: dirty, state: .waitingToSync), pending: nil)
    try index.commit(record(path: "Live.md", reference: large, state: .waitingToSync), pending: nil)
    let reads = SearchCheckpointReads(files: files)
    let repository = try WorkspaceRepository(scope: fixture.scope, index: index, checkpoints: reads)
    let scan = try await repository.cachedNoteTexts(
      limits: .init(maximumDocuments: 3, maximumBytes: 14, maximumDocumentBytes: 10),
      excludingPaths: ["Live.md"])
    #expect(scan.notes.map(\.metadata.path) == ["Z-dirty.md", "B-small.md"])
    #expect(scan.notes.reduce(0) { $0 + $1.content.utf8.count } == 14)
    #expect(!scan.isComplete && scan.downloadedNotes == 4)
    #expect(reads.references == [dirty, large, small])
    #expect(reads.limits == [10, 5, 5])
  }

  @Test func boundedFilesystemReadRejectsOversizedFilesAndStillValidatesSmallFiles() throws {
    let fixture = try RepositoryFixture()
    defer { fixture.remove() }
    let files = try MarkdownCheckpointStore(
      directory: fixture.directory.appendingPathComponent("text"))
    let reference = String(repeating: "0", count: 64)
    let url = try files.fileURL(reference)
    #expect(FileManager.default.createFile(atPath: url.path, contents: nil))
    let handle = try FileHandle(forWritingTo: url)
    try handle.truncate(atOffset: 64 * 1_024 * 1_024)
    try handle.close()
    #expect(try files.read(reference, maxBytes: 100) == nil)
    let original = try files.put("small 🌿")
    #expect(try files.read(original, maxBytes: 10) == "small 🌿")
    #expect(try files.read(original, maxBytes: 9) == nil)
    try Data("altered".utf8).write(to: files.fileURL(original))
    #expect(throws: WorkspaceRepositoryError.corruptCheckpoint) {
      try files.read(original, maxBytes: 10)
    }
  }

  private func record(path: String, reference: String, state: NoteSyncState) -> NoteIndexRecord {
    NoteIndexRecord(
      path: path, working: reference, base: reference, baseVersion: "v1", revision: 2,
      acknowledgedRevision: 1, state: state, recoveryCopies: [])
  }
}

private final class SearchCheckpointReads: NoteCheckpointStore, @unchecked Sendable {
  private let files: MarkdownCheckpointStore
  private let lock = NSLock()
  private var reads: [(String, Int)] = []
  init(files: MarkdownCheckpointStore) { self.files = files }
  var references: [String] { lock.withLock { reads.map(\.0) } }
  var limits: [Int] { lock.withLock { reads.map(\.1) } }
  func reset() { lock.withLock { reads = [] } }
  func beginAccess() throws -> CheckpointAccessLease? { try files.beginAccess() }
  func put(_ content: String) throws -> String { try files.put(content) }
  func fileURL(_ reference: String) throws -> URL { try files.fileURL(reference) }
  func read(_ reference: String) throws -> String { throw UnboundedRead() }
  func read(_ reference: String, maxBytes: Int) throws -> String? {
    lock.withLock { reads.append((reference, maxBytes)) }
    return try files.read(reference, maxBytes: maxBytes)
  }
  private struct UnboundedRead: Error {}
}
