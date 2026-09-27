import CryptoKit
import Darwin
import Foundation

/// Immutable, UTF-8 markdown checkpoints. The SQLite transaction publishes their references
/// only after `put` succeeds; an interrupted transaction can leave harmless unreferenced files.
public protocol NoteCheckpointStore: Sendable {
  func beginAccess() throws -> CheckpointAccessLease?
  func put(_ content: String) throws -> String
  func read(_ reference: String) throws -> String
  func fileURL(_ reference: String) throws -> URL
}

extension NoteCheckpointStore {
  /// Injected stores without filesystem checkpoints need no file lease. Wrappers around a real
  /// MarkdownCheckpointStore must forward this operation as well as put/read.
  public func beginAccess() throws -> CheckpointAccessLease? { nil }
}

public struct MarkdownCheckpointStore: NoteCheckpointStore {
  public let directory: URL

  public init(directory: URL) throws {
    self.directory = directory
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  public func put(_ content: String) throws -> String {
    let access = try beginAccess()
    defer { access?.release() }
    let data = Data(content.utf8)
    let reference = Self.digest(data)
    let target = try fileURL(reference)
    if FileManager.default.fileExists(atPath: target.path) {
      guard try read(reference).utf8.elementsEqual(content.utf8) else {
        throw WorkspaceRepositoryError.corruptCheckpoint
      }
    } else {
      #if os(iOS)
        try data.write(
          to: target, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      #else
        try data.write(to: target, options: .atomic)
      #endif
    }
    // A prior attempt may have created this file but failed during synchronization. Existing
    // content must establish durability too before its reference can be acknowledged.
    let handle = try FileHandle(forWritingTo: target)
    defer { try? handle.close() }
    try handle.synchronize()
    // Publish the directory entry before SQLite may commit a reference to it.
    let descriptor = Darwin.open(directory.path, O_RDONLY)
    guard descriptor >= 0 else {
      throw WorkspaceRepositoryError.storage("Cannot open checkpoint folder.")
    }
    defer { Darwin.close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else {
      throw WorkspaceRepositoryError.storage("Cannot sync checkpoint folder.")
    }
    return reference
  }

  public func read(_ reference: String) throws -> String {
    let access = try beginAccess()
    defer { access?.release() }
    let data = try Data(contentsOf: fileURL(reference))
    guard Self.digest(data) == reference, let text = String(data: data, encoding: .utf8) else {
      throw WorkspaceRepositoryError.corruptCheckpoint
    }
    return text
  }

  public func fileURL(_ reference: String) throws -> URL {
    guard reference.count == 64,
      reference.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
    else {
      throw WorkspaceRepositoryError.corruptCheckpoint
    }
    return directory.appendingPathComponent(reference + ".md")
  }

  static func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
