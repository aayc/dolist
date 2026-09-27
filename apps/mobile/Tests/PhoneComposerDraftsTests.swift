import DailyDoListMobileKit
import Foundation
import Testing

@testable import DailyDoList

@MainActor
struct PhoneComposerDraftsTests {
  @Test func clearingAfterQueuedTypingCannotRestoreTheSentDraftOnRelaunch() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let scope = WorkspaceScope(
      profileID: UUID(), workspaceID: "workspace", hostID: "host",
      origin: try ConnectionOrigin("https://notes.example.test"))
    let cache = try WorkspaceCache(rootDirectory: root, scope: scope)
    let drafts = PhoneComposerDrafts(cache: cache)
    #expect(try await drafts.load("thread") == "")
    drafts.save("thread", "A")
    drafts.save("thread", "A reply")
    drafts.save("thread", "")
    await drafts.flush()
    let reopened = PhoneComposerDrafts(cache: try WorkspaceCache(rootDirectory: root, scope: scope))
    #expect(try await reopened.load("thread") == "")
    #expect(try await cache.composer(.thread("thread")).revision == 3)
  }

  @Test func checkedFlushRefusesAReplyThatNeverReachedDurableStorage() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let scope = WorkspaceScope(
      profileID: UUID(), workspaceID: "workspace", hostID: "host",
      origin: try ConnectionOrigin("https://notes.example.test"))
    let cache = try WorkspaceCache(rootDirectory: root, scope: scope)
    let drafts = PhoneComposerDrafts(cache: cache)
    _ = try await drafts.load("thread")
    let second = try WorkspaceCache(rootDirectory: root, scope: scope)
    _ = try await second.saveComposer(.thread("thread"), text: "Other window", replacing: 0)
    drafts.save("thread", "Keep this in-memory reply")
    await #expect(throws: PhoneRecoveryPreparationError.unsavedReplies) {
      try await drafts.flushChecked()
    }
    #expect(try await drafts.load("thread") == "Keep this in-memory reply")
    #expect(try await cache.composer(.thread("thread")).text == "Other window")
  }

}
