import Darwin
import Foundation

/// An app-owned file under the managed storage root that no repository owns, such as the drawing
/// library. Each call holds a short storage lease: it fails closed while strict storage is locked
/// or a protection change runs, and new bytes get the policy's current file protection class.
public struct MobileProtectedFile: Sendable {
  public let url: URL

  public init(url: URL) { self.url = url }

  /// Nil only when the file does not exist; unavailable storage throws instead.
  public func read() throws -> Data? {
    let access = try MobileStorageProtection.access(at: url)
    defer { withExtendedLifetime(access) {} }
    do { return try Data(contentsOf: url) } catch CocoaError.fileReadNoSuchFile { return nil }
  }

  /// Replaces the file atomically and durably, or leaves the previous bytes in place.
  public func write(_ data: Data) throws {
    let access = try MobileStorageProtection.access(at: url)
    defer { withExtendedLifetime(access) {} }
    let directory = url.deletingLastPathComponent()
    try MobileStorageProtection.createDirectory(directory, mode: access.mode)
    try data.write(to: url, options: access.mode.writingOptions)
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    try handle.synchronize()
    let descriptor = Darwin.open(directory.path, O_RDONLY)
    guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
    defer { Darwin.close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else { throw CocoaError(.fileWriteUnknown) }
  }
}
