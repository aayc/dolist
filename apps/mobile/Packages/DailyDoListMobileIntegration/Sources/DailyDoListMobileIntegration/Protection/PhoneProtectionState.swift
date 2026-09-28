import DailyDoListMobileKit
import Darwin
import Foundation

public struct PhoneProtectionState: Codable, Equatable, Sendable {
  public var version = 1
  public var mode: MobileStorageProtectionMode
  public var pending: MobileStorageProtectionMode?
  public init(
    mode: MobileStorageProtectionMode = .afterFirstUnlock,
    pending: MobileStorageProtectionMode? = nil
  ) {
    self.mode = mode
    self.pending = pending
  }
  public var permitsBackgroundRefresh: Bool { pending == nil && mode == .afterFirstUnlock }
}

public protocol PhoneProtectionStateStore: Sendable {
  func read() throws -> PhoneProtectionState?
  func write(_ state: PhoneProtectionState) throws
}

/// Only protection modes live here, never credentials or content. An unreadable or future state
/// fails launch preparation rather than silently reopening the vault with weaker protection.
public struct FilePhoneProtectionStateStore: PhoneProtectionStateStore {
  private let file: URL
  public init(rootDirectory: URL) {
    file = rootDirectory.appendingPathComponent("storage-protection.json")
  }
  public func read() throws -> PhoneProtectionState? {
    try validatePaths()
    let data: Data
    do { data = try Data(contentsOf: file) } catch CocoaError.fileReadNoSuchFile { return nil }
    let state = try JSONDecoder().decode(PhoneProtectionState.self, from: data)
    guard state.version == 1 else { throw MobileStorageProtectionError.unsupportedState }
    return state
  }
  public func write(_ state: PhoneProtectionState) throws {
    try validatePaths()
    try FileManager.default.createDirectory(
      at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try JSONEncoder().encode(state)
    #if os(iOS)
      let strict = state.pending != nil || state.mode == .whileUnlocked
      try data.write(
        to: file,
        options: [
          .atomic,
          strict
            ? .completeFileProtection
            : .completeFileProtectionUntilFirstUserAuthentication,
        ])
    #else
      try data.write(to: file, options: .atomic)
    #endif
    let handle = try FileHandle(forWritingTo: file)
    defer { try? handle.close() }
    try handle.synchronize()
    let descriptor = Darwin.open(file.deletingLastPathComponent().path, O_RDONLY)
    guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
    defer { Darwin.close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else { throw CocoaError(.fileWriteUnknown) }
  }

  private func validatePaths() throws {
    for (url, expected) in [
      (file.deletingLastPathComponent(), FileAttributeType.typeDirectory),
      (file, FileAttributeType.typeRegular),
    ] {
      do {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == expected else {
          throw MobileStorageProtectionError.invalidPath
        }
      } catch CocoaError.fileReadNoSuchFile { continue }
    }
  }
}
