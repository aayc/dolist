import Darwin
import Foundation

/// Public metadata only. Tokens live in the device-only Keychain, never in this file or a URL.
public struct ConnectionProfile: Codable, Hashable, Sendable, Identifiable {
  public let id: UUID
  public var name: String
  public let origin: ConnectionOrigin
  public var deviceID: String?
  public var workspaceID: String?
  public var hostID: String?
  public var vaultName: String?

  public init(id: UUID = UUID(), name: String, origin: ConnectionOrigin) {
    self.id = id
    self.name = name
    self.origin = origin
  }
}

public protocol ConnectionProfileStore: Sendable {
  func profiles() async throws -> [ConnectionProfile]
  func save(_ profile: ConnectionProfile) async throws
  func remove(_ id: UUID) async throws
}

/// Atomic, versioned metadata. A malformed/future file is an error, never an empty profile list
/// that could detach durable drafts from their original connection.
public actor FileConnectionProfileStore: ConnectionProfileStore {
  private struct Document: Codable {
    var version = 1
    var profiles: [ConnectionProfile] = []
  }
  public enum StoreError: LocalizedError {
    case unsupportedVersion
    case duplicateProfile
    case changedIdentity
    public var errorDescription: String? {
      switch self {
      case .unsupportedVersion:
        "This app cannot read the saved connection format. Your data is preserved."
      case .duplicateProfile:
        "The connection file contains duplicate profiles. Your data is preserved."
      case .changedIdentity:
        "This connection belongs to another workspace or host. Add a new connection to keep its drafts separate."
      }
    }
  }
  private let file: URL

  public init(directory: URL) {
    file = directory.appendingPathComponent("connections.json")
  }

  public func profiles() throws -> [ConnectionProfile] { try read().profiles }

  public func save(_ profile: ConnectionProfile) throws {
    var document = try read()
    if let index = document.profiles.firstIndex(where: { $0.id == profile.id }) {
      let old = document.profiles[index]
      guard old.origin == profile.origin,
        old.workspaceID == nil || old.workspaceID == profile.workspaceID,
        old.hostID == nil || old.hostID == profile.hostID
      else { throw StoreError.changedIdentity }
      document.profiles[index] = profile
    } else {
      document.profiles.append(profile)
    }
    try write(document)
  }

  public func remove(_ id: UUID) throws {
    var document = try read()
    document.profiles.removeAll { $0.id == id }
    try write(document)
  }

  private func read() throws -> Document {
    let access = try MobileStorageProtection.access(at: file)
    defer { withExtendedLifetime(access) {} }
    let data: Data
    do {
      data = try Data(contentsOf: file)
    } catch CocoaError.fileReadNoSuchFile {
      return Document()
    }
    let document = try JSONDecoder().decode(Document.self, from: data)
    guard document.version == 1 else { throw StoreError.unsupportedVersion }
    guard Set(document.profiles.map(\.id)).count == document.profiles.count else {
      throw StoreError.duplicateProfile
    }
    return document
  }

  private func write(_ document: Document) throws {
    let protection = try MobileStorageProtection.access(at: file)
    defer { withExtendedLifetime(protection) {} }
    try MobileStorageProtection.createDirectory(
      file.deletingLastPathComponent(), mode: protection.mode)
    let data = try JSONEncoder().encode(document)
    try data.write(to: file, options: protection.mode.writingOptions)
    let handle = try FileHandle(forWritingTo: file)
    defer { try? handle.close() }
    try handle.synchronize()
    let descriptor = Darwin.open(file.deletingLastPathComponent().path, O_RDONLY)
    guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
    defer { Darwin.close(descriptor) }
    guard Darwin.fsync(descriptor) == 0 else { throw CocoaError(.fileWriteUnknown) }
  }
}
