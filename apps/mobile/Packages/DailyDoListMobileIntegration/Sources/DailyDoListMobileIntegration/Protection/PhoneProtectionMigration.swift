import DailyDoListMobileKit
import Foundation

/// Persistent two-phase protection migration. The owner quiesces active repositories before
/// changing attributes; an open SQLite handle makes migration fail without touching its bytes.
/// A crash/failure leaves a durable pending target that must finish before storage is reopened.
public actor PhoneProtectionMigration {
  public typealias CredentialUpdate = @Sendable (MobileStorageProtectionMode) async throws -> Void
  public typealias FileUpdate = @Sendable (MobileStorageProtectionMode) throws -> Void
  public nonisolated let initialState: PhoneProtectionState
  public nonisolated let storage: MobileStorageProtection
  private let persistence: any PhoneProtectionStateStore
  private let updateCredentials: CredentialUpdate
  private let updateFiles: FileUpdate
  private var state: PhoneProtectionState
  private var prepared = false
  private var operation: Task<Void, Error>?

  public init(
    rootDirectory: URL, credentials: KeychainConnectionCredentials,
    initialMode: MobileStorageProtectionMode = .afterFirstUnlock
  ) throws {
    let persistence = FilePhoneProtectionStateStore(rootDirectory: rootDirectory)
    let storage = try MobileStorageProtection(
      rootDirectory: rootDirectory, mode: .whileUnlocked, pending: true)
    let state = try persistence.read() ?? PhoneProtectionState(pending: initialMode)
    initialState = state
    self.persistence = persistence
    self.state = state
    self.storage = storage
    updateCredentials = { try await credentials.setProtection($0) }
    updateFiles = { try storage.protectExistingFiles($0) }
  }

  /// Injectable durable/fault boundary for deterministic migration tests.
  public init(
    rootDirectory: URL, persistence: any PhoneProtectionStateStore,
    updateCredentials: @escaping CredentialUpdate, updateFiles: @escaping FileUpdate
  ) throws {
    storage = try MobileStorageProtection(
      rootDirectory: rootDirectory, mode: .whileUnlocked, pending: true)
    let state = try persistence.read() ?? PhoneProtectionState(pending: .afterFirstUnlock)
    initialState = state
    self.persistence = persistence
    self.state = state
    self.updateCredentials = updateCredentials
    self.updateFiles = updateFiles
  }

  public func snapshot() -> PhoneProtectionState { state }
  public func isPrepared() -> Bool { prepared }

  /// Call before opening profile/workspace stores, including a cold App Intent invocation.
  public func prepare(quiesce: @escaping @Sendable () async throws -> Void = {}) async throws {
    if let operation {
      try await operation.value
      return
    }
    guard !prepared else { return }
    try await run(
      target: state.pending ?? state.mode, migrateFiles: state.pending != nil, quiesce: quiesce)
  }

  public func change(
    to target: MobileStorageProtectionMode,
    quiesce: @escaping @Sendable () async throws -> Void
  ) async throws {
    if let operation { try await operation.value }
    if !prepared { try await prepare(quiesce: quiesce) }
    guard state.mode != target else { return }
    var pending = state
    pending.pending = target
    // Persist the user's requested target before touching any protection attributes.
    try persistence.write(pending)
    state = pending
    prepared = false
    try await run(target: target, migrateFiles: true, quiesce: quiesce)
  }

  private func run(
    target: MobileStorageProtectionMode, migrateFiles: Bool,
    quiesce: @escaping @Sendable () async throws -> Void
  ) async throws {
    let work = Task {
      try await self.apply(target: target, migrateFiles: migrateFiles, quiesce: quiesce)
    }
    operation = work
    defer { operation = nil }
    try await work.value
  }

  private func apply(
    target: MobileStorageProtectionMode, migrateFiles: Bool,
    quiesce: @Sendable () async throws -> Void
  ) async throws {
    try await quiesce()
    try Task.checkCancellation()
    try storage.beginMigration(requireUnlocked: migrateFiles || target == .whileUnlocked)
    // The default bootstrap also writes its pending intent before the initial attribute walk.
    if migrateFiles {
      try persistence.write(state)
      try updateFiles(target)
    }
    try await updateCredentials(target)
    try Task.checkCancellation()
    let committed = PhoneProtectionState(mode: target)
    try persistence.write(committed)
    state = committed
    storage.finishMigration(target)
    prepared = true
  }
}
