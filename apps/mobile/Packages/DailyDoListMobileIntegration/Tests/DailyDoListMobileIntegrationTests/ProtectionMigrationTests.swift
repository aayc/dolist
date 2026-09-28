import DailyDoListMobileKit
import Foundation
import Testing

@testable import DailyDoListMobileIntegration

struct ProtectionMigrationTests {
  enum Boundary: CaseIterable, Sendable { case files, credentials, commit }

  @MainActor @Test func coldPreparationDoesNotWaitOnItsCallerButLiveChangesAndRetriesQuiesce()
    async throws
  {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let migration = try PhoneProtectionMigration(
      rootDirectory: root, persistence: FaultPolicyStore(),
      updateCredentials: { _ in }, updateFiles: { _ in })
    defer { try? migration.storage.unregister() }
    var stops = 0
    var resumes = 0
    let controller = PhoneStorageProtectionController(
      migration: migration, quiesce: {}, resume: { resumes += 1 })
    controller.quiesce = { [weak controller] in
      stops += 1
      await #expect(throws: MobileStorageProtectionError.busy) { try await controller?.prepare() }
      if stops == 1 { throw MobileStorageProtectionError.busy }
    }
    try await controller.prepare()
    #expect(stops == 0 && controller.ready)
    await controller.change(to: .whileUnlocked)
    #expect(stops == 1 && !controller.ready && resumes == 0)
    await controller.retry()
    #expect(stops == 2 && controller.ready && resumes == 1)
    #expect(controller.state.mode == .whileUnlocked)
  }

  @Test(arguments: Boundary.allCases)
  func failedMigrationRetainsIntentAndBytesUntilRestartCompletes(boundary: Boundary) async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let original = Data("Synthetic saved attachment bytes".utf8)
    let file = root.appendingPathComponent("original.bin")
    try original.write(to: file)
    let store = FaultPolicyStore(failCommit: boundary == .commit)
    let migration = try PhoneProtectionMigration(
      rootDirectory: root, persistence: store,
      updateCredentials: { mode in
        if mode == .whileUnlocked && boundary == .credentials {
          throw CocoaError(.fileWriteUnknown)
        }
      },
      updateFiles: { _ in
        if boundary == .files { throw CocoaError(.fileWriteUnknown) }
      })
    try await migration.prepare()
    await #expect(throws: CocoaError.self) {
      try await migration.change(to: .whileUnlocked, quiesce: {})
    }
    #expect(store.read()?.pending == .whileUnlocked)
    #expect(!migration.storage.allowsAccess)
    #expect(try Data(contentsOf: file) == original)
    let restarted = try PhoneProtectionMigration(
      rootDirectory: root, persistence: store,
      updateCredentials: { _ in }, updateFiles: { _ in })
    defer { try? restarted.storage.unregister() }
    try await restarted.prepare()
    #expect(await restarted.snapshot() == PhoneProtectionState(mode: .whileUnlocked))
    #expect(restarted.storage.allowsAccess)
    #expect(try Data(contentsOf: file) == original)
  }

  @Test func defaultColdRefreshCanPrepareAfterFirstUnlockWhileStrictModeCannot() async throws {
    for mode in [MobileStorageProtectionMode.afterFirstUnlock, .whileUnlocked] {
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      let migration = try PhoneProtectionMigration(
        rootDirectory: root,
        persistence: FaultPolicyStore(mode: mode), updateCredentials: { _ in },
        updateFiles: { _ in })
      defer { try? migration.storage.unregister() }
      migration.storage.setProtectedDataAvailable(false)
      if mode == .afterFirstUnlock {
        try await migration.prepare()
        #expect(migration.storage.allowsAccess)
      } else {
        await #expect(throws: MobileStorageProtectionError.unavailable) {
          try await migration.prepare()
        }
        #expect(!migration.storage.allowsAccess)
      }
    }
  }

  @Test func unreadableOrFuturePolicyNeverFallsBackToTheDefault() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = FilePhoneProtectionStateStore(rootDirectory: root)
    var future = PhoneProtectionState(mode: .whileUnlocked)
    future.version = 99
    try store.write(future)
    #expect(throws: MobileStorageProtectionError.unsupportedState) {
      try PhoneProtectionMigration(
        rootDirectory: root, persistence: store,
        updateCredentials: { _ in }, updateFiles: { _ in })
    }
    let data = Data("invalid policy".utf8)
    try data.write(to: root.appendingPathComponent("storage-protection.json"))
    #expect(throws: DecodingError.self) { try store.read() }
    #expect(try Data(contentsOf: root.appendingPathComponent("storage-protection.json")) == data)
    #expect(throws: MobileStorageProtectionError.unavailable) {
      try MarkdownCheckpointStore(directory: root.appendingPathComponent("markdown"))
    }
    let registration = try MobileStorageProtection(
      rootDirectory: root, mode: .whileUnlocked, pending: true)
    try registration.unregister()
  }

  @Test func policyNeverReadsOrReplacesAnExternalSymlinkTarget() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let external = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let original = try JSONEncoder().encode(PhoneProtectionState(mode: .whileUnlocked))
    try original.write(to: external)
    defer {
      try? FileManager.default.removeItem(at: root)
      try? FileManager.default.removeItem(at: external)
    }
    let policy = root.appendingPathComponent("storage-protection.json")
    try FileManager.default.createSymbolicLink(at: policy, withDestinationURL: external)
    let store = FilePhoneProtectionStateStore(rootDirectory: root)
    #expect(throws: MobileStorageProtectionError.invalidPath) { try store.read() }
    #expect(throws: MobileStorageProtectionError.invalidPath) {
      try store.write(PhoneProtectionState())
    }
    #expect(try Data(contentsOf: external) == original)
    #expect(try policy.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true)
  }
}

private final class FaultPolicyStore: PhoneProtectionStateStore, @unchecked Sendable {
  private let lock = NSLock()
  private var state: PhoneProtectionState
  private var failCommit: Bool
  init(mode: MobileStorageProtectionMode = .afterFirstUnlock, failCommit: Bool = false) {
    state = PhoneProtectionState(mode: mode)
    self.failCommit = failCommit
  }
  func read() -> PhoneProtectionState? {
    lock.lock()
    defer { lock.unlock() }
    return state
  }
  func write(_ next: PhoneProtectionState) throws {
    lock.lock()
    defer { lock.unlock() }
    if failCommit && next.mode == .whileUnlocked && next.pending == nil {
      failCommit = false
      throw CocoaError(.fileWriteUnknown)
    }
    state = next
  }
}
