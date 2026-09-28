import Foundation

public enum MobileStorageProtectionMode: String, Codable, CaseIterable, Sendable {
  case afterFirstUnlock, whileUnlocked
}

public enum MobileStorageProtectionError: LocalizedError, Equatable, Sendable {
  case unavailable, busy, invalidPath, unsupportedState
  public var errorDescription: String? {
    switch self {
    case .unavailable:
      "Unlock this iPhone and finish the storage protection change before continuing."
    case .busy:
      "Local storage is still in use. Wait for saving to finish, then retry the protection change."
    case .invalidPath: "The app's storage contains an unexpected file. Nothing was removed."
    case .unsupportedState:
      "This app cannot read the storage protection settings. Your data is preserved."
    }
  }
}

/// One registered application container. Migration waits for all database handles and short file
/// accesses to close, then prevents new access until the durable policy is committed. Runtime
/// configuration is deliberately separate from file attributes: changing a preference is not proof
/// that bytes or Keychain items have been migrated.
public final class MobileStorageProtection: @unchecked Sendable {
  public let rootDirectory: URL
  private let key: String
  private static let registry = Registry()

  public init(rootDirectory: URL, mode: MobileStorageProtectionMode, pending: Bool = false) throws {
    guard rootDirectory.isFileURL else { throw MobileStorageProtectionError.invalidPath }
    self.rootDirectory = rootDirectory.standardizedFileURL
    key = self.rootDirectory.path
    try Self.registry.register(key, mode: mode, blocked: pending)
  }

  public func setProtectedDataAvailable(_ available: Bool) {
    Self.registry.setAvailability(key, available)
  }

  /// The owner must checkpoint, stop network work and release every repository/cache first.
  /// A busy failure keeps existing objects usable so the owner can finish quiescing them.
  public func beginMigration(requireUnlocked: Bool = true) throws {
    try Self.registry.beginMigration(key, requireUnlocked: requireUnlocked)
  }

  /// Call only after all files, credentials and the durable committed policy agree.
  public func finishMigration(_ mode: MobileStorageProtectionMode) {
    Self.registry.finishMigration(key, mode)
  }

  public var allowsAccess: Bool { Self.registry.allowsAccess(key) }
  public var openAccessCount: Int { Self.registry.openCount(key) }

  /// Releases an unused test/application container registration, never active storage leases.
  public func unregister() throws { try Self.registry.unregister(key) }

  package static func access(at url: URL) throws -> MobileProtectionAccess {
    try registry.access(url.standardizedFileURL.path)
  }

  private final class Registry: @unchecked Sendable {
    struct Entry {
      var mode: MobileStorageProtectionMode
      var blocked: Bool
      var available = true
      var count = 0
      var allowed: Bool { !blocked && (mode == .afterFirstUnlock || available) }
    }
    private let lock = NSLock()
    private var entries: [String: Entry] = [:]

    func register(_ root: String, mode: MobileStorageProtectionMode, blocked: Bool) throws {
      lock.lock()
      defer { lock.unlock() }
      guard entries[root]?.count ?? 0 == 0 else { throw MobileStorageProtectionError.busy }
      entries[root] = Entry(mode: mode, blocked: blocked)
    }
    func unregister(_ root: String) throws {
      lock.lock()
      defer { lock.unlock() }
      guard entries[root]?.count ?? 0 == 0 else { throw MobileStorageProtectionError.busy }
      entries.removeValue(forKey: root)
    }
    func setAvailability(_ root: String, _ available: Bool) {
      lock.lock()
      defer { lock.unlock() }
      entries[root]?.available = available
    }
    func beginMigration(_ root: String, requireUnlocked: Bool) throws {
      lock.lock()
      defer { lock.unlock() }
      guard let entry = entries[root], !requireUnlocked || entry.available else {
        throw MobileStorageProtectionError.unavailable
      }
      guard entry.count == 0 else { throw MobileStorageProtectionError.busy }
      entries[root]?.blocked = true
    }
    func finishMigration(_ root: String, _ mode: MobileStorageProtectionMode) {
      lock.lock()
      defer { lock.unlock() }
      entries[root]?.mode = mode
      entries[root]?.blocked = false
    }
    func allowsAccess(_ root: String) -> Bool {
      lock.lock()
      defer { lock.unlock() }
      return entries[root]?.allowed == true
    }
    func openCount(_ root: String) -> Int {
      lock.lock()
      defer { lock.unlock() }
      return entries[root]?.count ?? 0
    }
    func access(_ path: String) throws -> MobileProtectionAccess {
      lock.lock()
      defer { lock.unlock() }
      // Longest root wins if an isolated nested container is registered for tests.
      guard
        let root = entries.keys.filter({ path == $0 || path.hasPrefix($0 + "/") })
          .max(by: { $0.count < $1.count }), let entry = entries[root]
      else { return MobileProtectionAccess(mode: .afterFirstUnlock) }
      guard entry.allowed else { throw MobileStorageProtectionError.unavailable }
      entries[root]?.count += 1
      return MobileProtectionAccess(
        mode: entry.mode,
        check: { [self] in
          guard allowsAccess(root) else { throw MobileStorageProtectionError.unavailable }
        },
        release: { [self] in
          lock.lock()
          defer { lock.unlock() }
          entries[root]?.count -= 1
        })
    }
  }
}

/// Database handles retain one lease for their lifetime; ordinary file operations retain it only
/// synchronously. Check a retained lease before every SQLite transaction/read when locking changes.
package final class MobileProtectionAccess: @unchecked Sendable {
  package let mode: MobileStorageProtectionMode
  private let check: @Sendable () throws -> Void
  private let release: @Sendable () -> Void
  package init(
    mode: MobileStorageProtectionMode,
    check: @escaping @Sendable () throws -> Void = {},
    release: @escaping @Sendable () -> Void = {}
  ) {
    self.mode = mode
    self.check = check
    self.release = release
  }
  package func checkAvailable() throws { try check() }
  deinit { release() }
}
