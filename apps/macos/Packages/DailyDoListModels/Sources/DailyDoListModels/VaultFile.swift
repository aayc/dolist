import Foundation

public struct VaultFileMetadata: Codable, Hashable, Sendable {
  public var path: String
  public var version: String
  public var mtime: EpochMillis
  public var size: Int
  public var mimeType: String

  public init(path: String, version: String, mtime: EpochMillis, size: Int, mimeType: String) {
    self.path = path
    self.version = version
    self.mtime = mtime
    self.size = size
    self.mimeType = mimeType
  }
}

/// Authenticated bytes. Native previews consume this data; never construct bearer-token URLs.
public struct VaultFilePayload: Sendable {
  public var data: Data
  public var metadata: VaultFileMetadata

  public init(data: Data, metadata: VaultFileMetadata) {
    self.data = data
    self.metadata = metadata
  }
}
