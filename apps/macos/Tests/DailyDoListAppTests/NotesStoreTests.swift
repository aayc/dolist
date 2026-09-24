import DailyDoListClient
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListApp

/// Plays the editor/workspace: holds live text per note and records callbacks.
@MainActor
final class RecordingNotesDelegate: NotesStoreDelegate {
  var live: [String: String] = [:]
  var applied: [(path: String, content: String)] = []
  var conflictCopies: [(copy: String, original: String)] = []
  var deletions: [(path: String, restored: Bool)] = []
  var failures: [String] = []
  var existing: Set<String> = []

  func notesStore(_ store: NotesStore, liveContentOf path: String) -> String? { live[path] }
  func notesStore(_ store: NotesStore, applyRemote content: String, to path: String) {
    applied.append((path, content))
    live[path] = content
  }
  func notesStore(_ store: NotesStore, didSaveConflictCopy copyPath: String, of path: String) {
    conflictCopies.append((copyPath, path))
  }
  func notesStore(_ store: NotesStore, noteWasDeletedRemotely path: String, restored: Bool) {
    deletions.append((path, restored))
  }
  func notesStore(_ store: NotesStore, didFailToSave path: String, error: Error) { failures.append(path) }
  func notesStore(_ store: NotesStore, pathExists path: String) -> Bool { existing.contains(path) }
}

@MainActor
@Suite("NotesStore")
struct NotesStoreTests {
  let client: FakeDaemonClient
  let scheduler = ManualScheduler()
  let delegate = RecordingNotesDelegate()
  let store: NotesStore
  let path = "Notes/Plan.md"

  init() async throws {
    client = FakeDaemonClient(notes: ["Notes/Plan.md": "base"])
    store = NotesStore(client: client, scheduler: scheduler)
    store.delegate = delegate
    try await store.load(path)
    delegate.live[path] = "base"
  }

  private func edit(_ text: String) {
    delegate.live[path] = text
    store.markDirty(path)
  }

  @Test func loadsAndReportsSaved() {
    #expect(store.has(path))
    #expect(store.saveStates[path] == .saved)
    #expect(store.serverContent(path) == "base")
  }

  @Test func autosaveWaitsForThreeHundredMillisecondsOfQuiet() async throws {
    edit("a")
    #expect(store.saveStates[path] == .dirty)
    scheduler.advance(by: 0.2)
    edit("ab")
    scheduler.advance(by: 0.2)
    await settle()
    #expect(client.writes.isEmpty, "no save while typing continues")
    scheduler.advance(by: 0.1)
    try await eventually("saved") { store.saveStates[path] == .saved }
    #expect(client.writes.map(\.content) == ["ab"])
    #expect(client.note(path)?.content == "ab")
  }

  @Test func oneWriteInFlightAndEditsCoalesceIntoTheNext() async throws {
    client.holdWrites = true
    edit("one")
    scheduler.advance(by: 0.3)
    try await eventually("first write held") { client.heldWriteCount == 1 }
    #expect(store.saveStates[path] == .saving)

    edit("one two")
    scheduler.advance(by: 0.3)
    edit("one two three")
    scheduler.advance(by: 0.3)
    await settle()
    #expect(client.writes.count == 1, "single flight: no second write while one is pending")

    client.holdWrites = false
    client.releaseAllWrites()
    try await eventually("follow-up write") { client.writes.count == 2 }
    try await eventually("saved") { store.saveStates[path] == .saved }
    #expect(client.writes.map(\.content) == ["one", "one two three"])
    #expect(client.note(path)?.content == "one two three")
    #expect(store.isDirty(path) == false)
  }

  @Test func flushWaitsForTheFollowUpWrite() async throws {
    client.holdWrites = true
    edit("first")
    store.saveNow(path)
    try await eventually { client.heldWriteCount == 1 }
    edit("second")
    let flushed = Task { await store.flush(path) }
    await settle()
    client.holdWrites = false
    client.releaseAllWrites()
    await flushed.value
    #expect(client.note(path)?.content == "second")
    #expect(store.saveStates[path] == .saved)
  }

  @Test func conflictWithoutLocalEditsTakesTheirs() async throws {
    client.setNote(path, "theirs")
    // Typed and undid: dirty revision, same text as the server copy we know.
    edit("base")
    scheduler.advance(by: 0.3)
    try await eventually("resolved") { store.saveStates[path] == .saved }
    #expect(delegate.applied.last?.content == "theirs")
    #expect(delegate.conflictCopies.isEmpty)
    #expect(store.serverContent(path) == "theirs")
    #expect(client.note(path)?.content == "theirs")
  }

  @Test func conflictWithLocalEditsKeepsOursAndSavesTheirsAsACopy() async throws {
    client.setNote(path, "theirs")
    edit("ours")
    scheduler.advance(by: 0.3)
    try await eventually("resolved") { store.saveStates[path] == .saved }
    #expect(client.note(path)?.content == "ours")
    #expect(client.note("Notes/Plan (conflict).md")?.content == "theirs")
    #expect(delegate.conflictCopies.map(\.copy) == ["Notes/Plan (conflict).md"])
    #expect(delegate.applied.isEmpty, "our text stays in the editor")
  }

  @Test func conflictCopySkipsNamesThatExist() async throws {
    delegate.existing = ["Notes/Plan (conflict).md"]
    client.setNote("Notes/Plan (conflict 2).md", "older copy")
    client.setNote(path, "theirs")
    edit("ours")
    scheduler.advance(by: 0.3)
    try await eventually("resolved") { store.saveStates[path] == .saved }
    #expect(delegate.conflictCopies.map(\.copy) == ["Notes/Plan (conflict 3).md"])
    #expect(client.note("Notes/Plan (conflict 3).md")?.content == "theirs")
  }

  @Test func externalChangeIsAppliedWhenThereAreNoLocalEdits() async throws {
    let version = client.setNote(path, "fresh")
    await store.handleRemoteChange(path, version: version)
    #expect(delegate.applied.map(\.content) == ["fresh"])
    #expect(store.serverContent(path) == "fresh")
    #expect(store.version(path) == version)
  }

  @Test func echoOfTheKnownVersionIsIgnored() async throws {
    let known = try #require(store.version(path))
    client.resetLog()
    await store.handleRemoteChange(path, version: known)
    #expect(client.calls("readNote").isEmpty)
  }

  @Test func externalChangeWithLocalEditsResolvesOnTheNextSave() async throws {
    edit("mine")
    client.setNote(path, "theirs")
    await store.handleRemoteChange(path)
    #expect(store.saveStates[path] == .conflict)
    #expect(delegate.applied.isEmpty, "local edits are never clobbered")
    scheduler.advance(by: 0.3)
    try await eventually("resolved") { store.saveStates[path] == .saved }
    #expect(client.note(path)?.content == "mine")
    #expect(client.note("Notes/Plan (conflict).md")?.content == "theirs")
  }

  @Test func remoteDeleteOfACleanNoteForgetsIt() {
    store.handleRemoteDelete(path)
    #expect(store.has(path) == false)
    #expect(store.saveStates[path] == nil)
    #expect(delegate.deletions.map(\.restored) == [false])
  }

  @Test func remoteDeleteWithLocalEditsWritesThemBack() async throws {
    edit("keep me")
    client.removeNote(path)
    store.handleRemoteDelete(path)
    #expect(store.has(path))
    scheduler.advance(by: 0.3)
    try await eventually("restored") { delegate.deletions.count == 1 }
    #expect(delegate.deletions.first?.restored == true)
    #expect(client.note(path)?.content == "keep me")
  }

  @Test func failedSaveRetriesWithBackoff() async throws {
    client.fail("writeNote", with: .unreachable("offline"))
    edit("draft")
    scheduler.advance(by: 0.3)
    try await eventually("error state") { store.saveStates[path] == .error }
    #expect(delegate.failures == [path])
    client.fail("writeNote", with: nil)
    scheduler.advance(by: 2)
    try await eventually("saved after retry") { store.saveStates[path] == .saved }
    #expect(client.note(path)?.content == "draft")
  }

  @Test func renameMovesBookkeepingIncludingFolders() async throws {
    edit("renamed text")
    store.rename(from: "Notes", to: "Archive")
    #expect(store.has("Archive/Plan.md"))
    #expect(store.has(path) == false)
    #expect(store.saveStates["Archive/Plan.md"] == .dirty)
  }

  @Test func adoptNeverClobbersLocalEdits() async throws {
    edit("local")
    store.adopt(NoteResponse(path: path, content: "server", version: "v99", mtime: 0))
    #expect(delegate.applied.isEmpty)
    #expect(store.serverContent(path) == "base")
  }

  @Test func flushAllSavesEveryDirtyNote() async throws {
    client.setNote("Other.md", "x")
    try await store.load("Other.md")
    edit("plan edit")
    delegate.live["Other.md"] = "other edit"
    store.markDirty("Other.md")
    await store.flushAll()
    #expect(client.note(path)?.content == "plan edit")
    #expect(client.note("Other.md")?.content == "other edit")
    #expect(store.hasUnsavedChanges == false)
  }
}
