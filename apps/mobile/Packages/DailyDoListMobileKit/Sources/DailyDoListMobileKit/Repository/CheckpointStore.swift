import CryptoKit
import Darwin
import Foundation

/// Immutable, UTF-8 markdown checkpoints. The SQLite transaction publishes their references
/// only after `put` succeeds; an interrupted transaction can leave harmless unreferenced files.
public protocol NoteCheckpointStore: Sendable {
  func beginAccess() throws -> CheckpointAccessLease?
  func put(_ content: String) throws -> String
  func read(_ reference: String) throws -> String
  /// Read-only previews/search may skip oversized content without allocating the full file.
  func read(_ reference: String, maxBytes: Int) throws -> String?
  func fileURL(_ reference: String) throws -> URL
}

extension NoteCheckpointStore {
  /// Injected stores without filesystem checkpoints need no file lease. Wrappers around a real
  /// MarkdownCheckpointStore must forward this operation as well as put/read.
  public func beginAccess() throws -> CheckpointAccessLease? { nil }

  public func read(_ reference: String, maxBytes: Int) throws -> String? {
    guard maxBytes > 0 else { return nil }
    let text = try read(reference)
    return text.utf8.count <= maxBytes ? text : nil
  }
}

public struct MarkdownCheckpointStore: NoteCheckpointStore {
  public let directory: URL

  public init(directory: URL) throws {
    self.directory = directory
    let access = try MobileStorageProtection.access(at: directory)
    defer { withExtendedLifetime(access) {} }
    try MobileStorageProtection.createDirectory(directory, mode: access.mode)
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
      let protection = try MobileStorageProtection.access(at: target)
      try data.write(to: target, options: protection.mode.writingOptions)
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

  public func read(_ reference: String, maxBytes: Int) throws -> String? {
    guard maxBytes > 0 else { return nil }
    let access = try beginAccess()
    defer { access?.release() }
    let handle = try FileHandle(forReadingFrom: fileURL(reference))
    defer { try? handle.close() }
    // Check the open file before allocating. The extra-byte check also rejects a file replaced
    // or extended outside our immutable checkpoint writer while this handle is open.
    guard try handle.seekToEnd() <= UInt64(maxBytes) else { return nil }
    try handle.seek(toOffset: 0)
    var data = Data()
    while data.count <= maxBytes {
      let count = min(64 * 1_024, maxBytes - data.count) + 1
      guard let chunk = try handle.read(upToCount: count), !chunk.isEmpty else { break }
      data.append(chunk)
    }
    guard data.count <= maxBytes else { return nil }
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
