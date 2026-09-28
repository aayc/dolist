import Darwin
import Foundation

public enum RecoveryStagingError: Error, Equatable, LocalizedError {
  case invalidRoot
  case released
  case cleanupFailed(Int)

  public var errorDescription: String? {
    switch self {
    case .invalidRoot:
      "The temporary recovery folder on this iPhone can't be used. Your local work is preserved."
    case .released: "This recovery copy was already removed. Export a new copy."
    case .cleanupFailed:
      "Some temporary recovery copies couldn't be removed from this iPhone. The app will try again the next time it starts."
    }
  }
}

public struct RecoveryStagingCleanup: Equatable, Sendable {
  public var removed = 0
  /// Exports still leased by this or another instance or process.
  public var active = 0
  /// Names that look like a staged export but were not created here. They are never touched.
  public var rejected: [String] = []
}

/// An opaque handle to one staged export. Its lease lasts until `RecoveryExportStaging.remove`, or
/// until this object or its process goes away; cleanup then removes the unleased container.
public final class RecoveryExportStage: @unchecked Sendable {
  let scope: WorkspaceScope
  let container: URL
  private let lock = NSLock()
  private var descriptor: Int32?

  init(scope: WorkspaceScope, container: URL, descriptor: Int32) {
    self.scope = scope
    self.container = container
    self.descriptor = descriptor
  }

  var leased: Bool { lock.withLock { descriptor != nil } }

  func release() {
    lock.lock()
    defer { lock.unlock() }
    guard let descriptor else { return }
    self.descriptor = nil
    _ = flock(descriptor, LOCK_UN)
    _ = Darwin.close(descriptor)
  }

  deinit { release() }
}

/// App-owned temporary home for recovery exports offered to the Files picker. A staged export
/// holds full unsynced originals, so each lives in a generated container that is removed once the
/// picker finishes, and at startup or retirement once no live export holds its lease. Callers
/// never name a path: the user's copy in Files is outside this root and never touched.
public actor RecoveryExportStaging {
  private static let lockName = "staging.lock"
  private static let leaseName = "lease"
  private let root: URL
  private let protection: FileProtectionType
  private let removeItem: @Sendable (URL) throws -> Void

  /// `protection` applies to each container, so every staged file is created with that class.
  public init(rootDirectory: URL, protection: FileProtectionType = .complete) {
    self.init(rootDirectory: rootDirectory, protection: protection) {
      try FileManager.default.removeItem(at: $0)
    }
  }

  init(
    rootDirectory: URL, protection: FileProtectionType = .complete,
    removeItem: @escaping @Sendable (URL) throws -> Void
  ) {
    root = rootDirectory.standardizedFileURL
    self.protection = protection
    self.removeItem = removeItem
  }

  public func begin(for scope: WorkspaceScope) throws -> RecoveryExportStage {
    guard let rootLock = try lockRoot(creating: true) else {
      throw RecoveryStagingError.invalidRoot
    }
    defer { Self.unlock(rootLock) }
    let container = root.appendingPathComponent(
      scope.profileID.uuidString + "." + UUID().uuidString, isDirectory: true)
    guard Darwin.mkdir(container.path, 0o700) == 0 else {
      throw WorkspaceRepositoryError.storage("Cannot create a recovery export folder.")
    }
    do {
      #if os(iOS)
        try FileManager.default.setAttributes(
          [.protectionKey: protection], ofItemAtPath: container.path)
      #endif
      guard
        let lease = try Self.openLock(
          container.appendingPathComponent(Self.leaseName), creating: true)
      else { throw RecoveryStagingError.invalidRoot }
      guard Self.tryLock(lease) == true else {
        Darwin.close(lease)
        throw WorkspaceRepositoryError.storage("Cannot lease a recovery export folder.")
      }
      return RecoveryExportStage(scope: scope, container: container, descriptor: lease)
    } catch {
      try? removeItem(container)
      throw error
    }
  }

  /// Removes the staged copy after the picker finishes. A failed removal keeps the lease so the
  /// owner can retry; once released, the next cleanup removes it.
  public func remove(_ stage: RecoveryExportStage) throws {
    guard stage.leased else { return }
    guard stage.container.deletingLastPathComponent().standardizedFileURL.path == root.path else {
      throw RecoveryStagingError.invalidRoot
    }
    guard let rootLock = try lockRoot(creating: false) else {
      stage.release()
      return
    }
    defer { Self.unlock(rootLock) }
    do { try removeItem(stage.container) } catch let error as CocoaError
      where error.code == .fileNoSuchFile
    {}
    stage.release()
  }

  /// Startup cleanup (every profile) or retirement cleanup (one profile). Live leases are skipped,
  /// symlinks are never followed, and only containers created here are removed. Every container
  /// is attempted before a failure is reported, so the caller can retry.
  @discardableResult
  public func removeAbandoned(for profileID: UUID? = nil) throws -> RecoveryStagingCleanup {
    var result = RecoveryStagingCleanup()
    guard let rootLock = try lockRoot(creating: false) else { return result }
    defer { Self.unlock(rootLock) }
    var failures = 0
    for name in try FileManager.default.contentsOfDirectory(atPath: root.path).sorted() {
      guard let owner = Self.owner(ofContainerNamed: name), profileID == nil || owner == profileID
      else { continue }
      let container = root.appendingPathComponent(name, isDirectory: true)
      var info = stat()
      guard Darwin.lstat(container.path, &info) == 0 else {
        failures += 1
        continue
      }
      guard info.st_mode & S_IFMT == S_IFDIR, info.st_uid == geteuid() else {
        result.rejected.append(name)
        continue
      }
      let lease: Int32?
      do {
        lease = try Self.openLock(
          container.appendingPathComponent(Self.leaseName), creating: false)
      } catch RecoveryStagingError.invalidRoot {
        result.rejected.append(name)
        continue
      } catch {
        failures += 1
        continue
      }
      defer { if let lease { Darwin.close(lease) } }
      if let lease {
        guard let acquired = Self.tryLock(lease) else {
          failures += 1
          continue
        }
        guard acquired else {
          result.active += 1
          continue
        }
      }
      do {
        try removeItem(container)
        result.removed += 1
      } catch { failures += 1 }
    }
    if failures > 0 { throw RecoveryStagingError.cleanupFailed(failures) }
    return result
  }

  static func owner(ofContainerNamed name: String) -> UUID? {
    let parts = name.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 2, let owner = UUID(uuidString: String(parts[0])),
      owner.uuidString == parts[0],
      let export = UUID(uuidString: String(parts[1])), export.uuidString == parts[1]
    else { return nil }
    return owner
  }

  /// Serializes container creation, removal and cleanup across instances and processes, so a
  /// container is never seen between its creation and its lease.
  private func lockRoot(creating: Bool) throws -> Int32? {
    var info = stat()
    if Darwin.lstat(root.path, &info) != 0 {
      guard errno == ENOENT else { throw RecoveryStagingError.invalidRoot }
      guard creating else { return nil }
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
      guard Darwin.lstat(root.path, &info) == 0 else { throw RecoveryStagingError.invalidRoot }
    }
    guard info.st_mode & S_IFMT == S_IFDIR, info.st_uid == geteuid() else {
      throw RecoveryStagingError.invalidRoot
    }
    guard
      let descriptor = try Self.openLock(root.appendingPathComponent(Self.lockName), creating: true)
    else { throw RecoveryStagingError.invalidRoot }
    while flock(descriptor, LOCK_EX) != 0 {
      if errno == EINTR { continue }
      Darwin.close(descriptor)
      throw WorkspaceRepositoryError.storage("Cannot coordinate recovery export folders.")
    }
    return descriptor
  }

  private static func unlock(_ descriptor: Int32) {
    _ = flock(descriptor, LOCK_UN)
    _ = Darwin.close(descriptor)
  }

  /// Nil only when the file is missing and `creating` is false. A symlink or any other file type
  /// throws `invalidRoot`: this manager never creates one.
  private static func openLock(_ url: URL, creating: Bool) throws -> Int32? {
    let flags = O_RDWR | O_CLOEXEC | O_NOFOLLOW | (creating ? O_CREAT : 0)
    let descriptor = Darwin.open(url.path, flags, 0o600)
    guard descriptor >= 0 else {
      if errno == ENOENT, !creating { return nil }
      if errno == ELOOP { throw RecoveryStagingError.invalidRoot }
      throw WorkspaceRepositoryError.storage("Cannot open recovery export coordination.")
    }
    var info = stat()
    guard Darwin.fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG else {
      Darwin.close(descriptor)
      throw RecoveryStagingError.invalidRoot
    }
    #if os(iOS)
      // Content-free lock files stay usable while the device is locked, unlike the exports.
      if creating {
        do {
          try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path)
        } catch {
          Darwin.close(descriptor)
          throw error
        }
      }
    #endif
    return descriptor
  }

  /// True when acquired, false when another descriptor holds it, nil on any other failure.
  private static func tryLock(_ descriptor: Int32) -> Bool? {
    while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
      if errno == EINTR { continue }
      return errno == EWOULDBLOCK ? false : nil
    }
    return true
  }
}
