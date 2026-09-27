import Darwin
import Foundation

public struct CheckpointFile: Sendable {
  public let reference: String
  public let bytes: Int
  public init(reference: String, bytes: Int) {
    self.reference = reference
    self.bytes = bytes
  }
}

/// Inject filesystem failures without replacing the real SQLite transaction or access barrier.
public protocol CheckpointFileSystem: Sendable {
  func files() throws -> [CheckpointFile]
  func remove(_ reference: String) throws
  func synchronize() throws
}

public struct FoundationCheckpointFileSystem: CheckpointFileSystem {
  public let directory: URL
  public init(directory: URL) { self.directory = directory }

  public func files() throws -> [CheckpointFile] {
    guard try validDirectory() else { return [] }
    var result: [CheckpointFile] = []
    for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) {
      guard name.hasSuffix(".md"), Self.valid(String(name.dropLast(3))) else { continue }
      let path = directory.appendingPathComponent(name).path
      var info = stat()
      guard Darwin.lstat(path, &info) == 0 else {
        throw WorkspaceRepositoryError.storage("Cannot inspect checkpoint storage.")
      }
      // Never traverse symlinks or directories, including ones named like a valid hash.
      guard info.st_mode & S_IFMT == S_IFREG, info.st_size >= 0 else { continue }
      result.append(CheckpointFile(reference: String(name.dropLast(3)), bytes: Int(info.st_size)))
    }
    return result.sorted { $0.reference < $1.reference }
  }

  public func remove(_ reference: String) throws {
    guard try validDirectory() else { throw WorkspaceStorageError.unavailableCheckpoint }
    guard Self.valid(reference) else { throw WorkspaceRepositoryError.corruptCheckpoint }
    let path = directory.appendingPathComponent(reference + ".md").path
    var info = stat()
    guard Darwin.lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG else {
      throw WorkspaceRepositoryError.storage("Checkpoint changed during cleanup.")
    }
    guard Darwin.unlink(path) == 0 else {
      throw WorkspaceRepositoryError.storage("Cannot remove unused checkpoint.")
    }
  }

  public func synchronize() throws {
    guard try validDirectory() else { return }
    let descriptor = Darwin.open(directory.path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard descriptor >= 0 else {
      throw WorkspaceRepositoryError.storage("Cannot open checkpoint folder.")
    }
    defer { Darwin.close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else {
      throw WorkspaceRepositoryError.storage("Cannot sync checkpoint cleanup.")
    }
  }

  private func validDirectory() throws -> Bool {
    var info = stat()
    guard Darwin.lstat(directory.path, &info) == 0 else {
      if errno == ENOENT { return false }
      throw WorkspaceRepositoryError.storage("Cannot inspect checkpoint folder.")
    }
    guard info.st_mode & S_IFMT == S_IFDIR else {
      throw WorkspaceRepositoryError.storage("Checkpoint folder is not a directory.")
    }
    return true
  }

  private static func valid(_ reference: String) -> Bool {
    reference.count == 64
      && reference.utf8.allSatisfy {
        (48...57).contains($0) || (97...102).contains($0)
      }
  }
}
