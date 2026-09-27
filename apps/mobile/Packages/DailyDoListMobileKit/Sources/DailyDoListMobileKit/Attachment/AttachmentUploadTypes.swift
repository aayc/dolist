import DailyDoListModels
import Foundation

public struct AttachmentDependency: Codable, Hashable, Sendable {
  public let operationID: UUID
  public let path: String
  public let sha256: String

  public init(operationID: UUID, path: String, sha256: String) {
    self.operationID = operationID
    self.path = path
    self.sha256 = sha256
  }

  func validate() throws {
    let prefix = "attachments/" + operationID.uuidString.lowercased() + "."
    let suffix = String(path.dropFirst(prefix.count))
    guard path.hasPrefix(prefix), (1...12).contains(suffix.utf8.count),
      suffix != "md", suffix.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) }),
      sha256.utf8.count == 64,
      sha256.utf8.allSatisfy({ (97...102).contains($0) || (48...57).contains($0) })
    else { throw AttachmentUploadError.corruptRecord }
  }
}

public enum AttachmentUploadState: String, Codable, Sendable {
  case queued, attempting, acknowledged, needsReview, cancelled
  public var unresolved: Bool { self != .acknowledged && self != .cancelled }
}

public enum AttachmentUploadReviewReason: String, Codable, Sendable {
  case pathCollision, uncertainMissing, remoteChanged, invalidReceipt
}

public struct AttachmentUpload: Codable, Sendable, Identifiable {
  public let id: UUID
  public let scope: WorkspaceScope
  public let path: String
  public let originalFilename: String
  public let sha256: String
  public let byteCount: Int
  public let createdAt: Date
  public var state: AttachmentUploadState
  public var attemptCount: Int
  public var receipt: VaultFileMetadata?
  public var reviewReason: AttachmentUploadReviewReason?
  public var revision: Int64
  public var dependency: AttachmentDependency {
    AttachmentDependency(operationID: id, path: path, sha256: sha256)
  }
}

public enum AttachmentUploadError: Error, Equatable, LocalizedError, Sendable {
  case tooLarge(maxBytes: Int)
  case invalidFilename
  case missingUpload
  case missingOriginal
  case corruptRecord
  case cannotCancelAttemptedUpload

  public var errorDescription: String? {
    switch self {
    case .tooLarge(let maxBytes): "The attachment exceeds the \(maxBytes)-byte upload limit."
    case .invalidFilename: "Choose an attachment with a valid filename."
    case .missingUpload: "This attachment upload is no longer available."
    case .missingOriginal: "The original attachment bytes are unavailable on this device."
    case .corruptRecord: "The saved attachment could not be verified. Its data has been retained."
    case .cannotCancelAttemptedUpload:
      "This attachment may already be uploaded. Review it before discarding it."
    }
  }
}

/// Every read and create must carry the expected workspace header and preserve authenticated
/// streaming bounds. A health preflight cannot replace that write-time workspace guard.
public protocol AttachmentUploadRemote: Sendable {
  var profileID: UUID { get }
  var origin: ConnectionOrigin { get }
  func identity() async throws -> RemoteWorkspaceIdentity
  func readAttachment(_ path: String) async throws -> VaultFilePayload?
  func createAttachment(_ path: String, data: Data, workspaceID: String) async throws
    -> VaultFileMetadata
}
