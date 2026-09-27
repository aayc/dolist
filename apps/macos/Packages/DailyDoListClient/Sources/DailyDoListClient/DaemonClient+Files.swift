import DailyDoListModels
import Foundation

extension DaemonClient {
  /// Compatibility fallback; HTTPDaemonClient caps the stream before allocating the whole body.
  public func artifact(threadId: String, artifactId: String, maxBytes: Int) async throws
    -> ArtifactPayload
  {
    guard maxBytes > 0 else {
      throw DaemonClientError.invalidRequest("The download limit must be positive.")
    }
    let result = try await artifact(threadId: threadId, artifactId: artifactId)
    guard result.data.count <= maxBytes else { throw RESTTransport.downloadTooLarge(maxBytes) }
    return result
  }

  public func readFile(_ path: String) async throws -> VaultFilePayload {
    throw DaemonClientError.notFound("This client does not serve vault attachment bytes.")
  }
  public func writeFile(_ path: String, data: Data, baseVersion: BaseVersion) async throws
    -> VaultFileMetadata
  {
    throw DaemonClientError.notFound("This client does not upload vault attachments.")
  }
  public func deleteFile(_ path: String) async throws -> TrashResponse {
    throw DaemonClientError.notFound("This client does not delete vault attachments.")
  }
}
