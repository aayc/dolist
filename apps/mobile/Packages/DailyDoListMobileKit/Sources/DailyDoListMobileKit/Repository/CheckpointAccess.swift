import Darwin
import Foundation

/// A synchronous checkpoint/index access interval. Never retain a lease across a network await.
/// Separate file descriptors coordinate different actors, SQLite handles and app processes.
public final class CheckpointAccessLease: @unchecked Sendable {
  private let lock = NSLock()
  private var descriptor: Int32?

  init(_ descriptor: Int32) { self.descriptor = descriptor }

  public func release() {
    lock.lock()
    defer { lock.unlock() }
    guard let descriptor else { return }
    self.descriptor = nil
    _ = flock(descriptor, LOCK_UN)
    _ = Darwin.close(descriptor)
  }

  deinit { release() }
}

extension MarkdownCheckpointStore {
  public func beginAccess() throws -> CheckpointAccessLease? {
    try checkpointAccess(exclusive: false, wait: true)
  }

  /// Maintenance skips a busy namespace; explicit Forget may wait for active local saves.
  func beginExclusiveAccess(wait: Bool = false) throws -> CheckpointAccessLease? {
    try checkpointAccess(exclusive: true, wait: wait)
  }

  private func checkpointAccess(exclusive: Bool, wait: Bool) throws -> CheckpointAccessLease? {
    // This inode lives outside markdown and must survive Forget/GC. Unlinking a locked file
    // would let another process open a different inode and bypass the coordination barrier.
    let path = directory.deletingLastPathComponent().appendingPathComponent(
      "checkpoint-access.lock")
    let descriptor = Darwin.open(path.path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else {
      throw WorkspaceRepositoryError.storage("Cannot open checkpoint coordination.")
    }
    var accepted = false
    defer { if !accepted { Darwin.close(descriptor) } }
    var info = stat()
    guard Darwin.fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG else {
      throw WorkspaceRepositoryError.storage("Invalid checkpoint coordination file.")
    }
    #if os(iOS)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: path.path)
    #endif
    let operation = (exclusive ? LOCK_EX : LOCK_SH) | (wait ? 0 : LOCK_NB)
    while flock(descriptor, operation) != 0 {
      if errno == EINTR { continue }
      if !wait, errno == EWOULDBLOCK { return nil }
      throw WorkspaceRepositoryError.storage("Cannot coordinate checkpoint access.")
    }
    accepted = true
    return CheckpointAccessLease(descriptor)
  }
}
