import Foundation
import Testing

@testable import DailyDoListMobileKit

struct StorageProtectionTests {
  @Test func migrationWaitsForDatabaseAndCheckpointLeasesAndPreservesData() throws {
    let f = try RepositoryFixture()
    defer { f.remove() }
    let policy = try MobileStorageProtection(rootDirectory: f.directory, mode: .afterFirstUnlock)
    defer { try? policy.unregister() }
    let files = try MarkdownCheckpointStore(
      directory: f.directory.appendingPathComponent("markdown"))
    let reference = try files.put("Synthetic unsent note")
    var index: SQLiteWorkspaceIndex? = try SQLiteWorkspaceIndex(
      url: f.directory.appendingPathComponent("index.sqlite"), scope: f.scope)
    #expect(try index?.documents().isEmpty == true)
    #expect(throws: MobileStorageProtectionError.busy) { try policy.beginMigration() }
    index = nil
    let access = try files.beginAccess()
    #expect(throws: MobileStorageProtectionError.busy) { try policy.beginMigration() }
    access?.release()
    try policy.beginMigration()
    #expect(throws: MobileStorageProtectionError.unavailable) { try files.read(reference) }
    #expect(throws: MobileStorageProtectionError.unavailable) {
      try SQLiteWorkspaceIndex(
        url: f.directory.appendingPathComponent("index.sqlite"), scope: f.scope)
    }
    try policy.protectExistingFiles(.whileUnlocked)
    policy.finishMigration(.whileUnlocked)
    #expect(try files.read(reference) == "Synthetic unsent note")
  }

  @Test(arguments: [MobileStorageProtectionMode.afterFirstUnlock, .whileUnlocked])
  func lockedAccessUsesTheActualPolicyForExistingStores(mode: MobileStorageProtectionMode) throws {
    let f = try RepositoryFixture()
    defer { f.remove() }
    let policy = try MobileStorageProtection(rootDirectory: f.directory, mode: mode)
    defer { try? policy.unregister() }
    let files = try MarkdownCheckpointStore(
      directory: f.directory.appendingPathComponent("markdown"))
    let reference = try files.put("Protected synthetic text")
    var index: SQLiteWorkspaceIndex? = try SQLiteWorkspaceIndex(
      url: f.directory.appendingPathComponent("index.sqlite"), scope: f.scope)
    policy.setProtectedDataAvailable(false)
    if mode == .whileUnlocked {
      #expect(throws: MobileStorageProtectionError.unavailable) { try files.read(reference) }
      #expect(throws: MobileStorageProtectionError.unavailable) { try index?.documents() }
    } else {
      #expect(try files.read(reference) == "Protected synthetic text")
      #expect(try index?.documents().isEmpty == true)
    }
    policy.setProtectedDataAvailable(true)
    #expect(try files.read(reference) == "Protected synthetic text")
    index = nil
  }

  @Test func appOwnedFilesFailClosedWhileStrictStorageIsLocked() throws {
    let f = try RepositoryFixture()
    defer { f.remove() }
    let policy = try MobileStorageProtection(rootDirectory: f.directory, mode: .whileUnlocked)
    defer { try? policy.unregister() }
    let file = MobileProtectedFile(url: f.directory.appendingPathComponent("library/shapes.json"))
    #expect(try file.read() == nil)
    try file.write(Data("Synthetic shapes".utf8))
    policy.setProtectedDataAvailable(false)
    #expect(throws: MobileStorageProtectionError.unavailable) { try file.read() }
    #expect(throws: MobileStorageProtectionError.unavailable) {
      try file.write(Data("Synthetic replacement".utf8))
    }
    policy.setProtectedDataAvailable(true)
    #expect(try file.read() == Data("Synthetic shapes".utf8))
  }

  @Test func migrationRejectsSymlinksWithoutFollowingThem() throws {
    let f = try RepositoryFixture()
    defer { f.remove() }
    let target = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try Data("Synthetic external file".utf8).write(to: target)
    defer { try? FileManager.default.removeItem(at: target) }
    let policy = try MobileStorageProtection(rootDirectory: f.directory, mode: .afterFirstUnlock)
    defer { try? policy.unregister() }
    try FileManager.default.createDirectory(at: f.directory, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(
      at: f.directory.appendingPathComponent("link"), withDestinationURL: target)
    try policy.beginMigration()
    #expect(throws: MobileStorageProtectionError.invalidPath) {
      try policy.protectExistingFiles(.whileUnlocked)
    }
    #expect(try Data(contentsOf: target) == Data("Synthetic external file".utf8))
  }
}
