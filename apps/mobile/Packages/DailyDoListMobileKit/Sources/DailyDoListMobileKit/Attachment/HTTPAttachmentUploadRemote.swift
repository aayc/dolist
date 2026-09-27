import DailyDoListClient
import DailyDoListModels
import Foundation

public struct HTTPAttachmentUploadRemote: AttachmentUploadRemote {
  public let profileID: UUID
  public let origin: ConnectionOrigin
  private let scope: WorkspaceScope
  private let client: HTTPDaemonClient

  public init(client: HTTPDaemonClient, scope: WorkspaceScope) throws {
    guard client.expectedWorkspaceId == scope.workspaceID,
      client.endpoint.baseURL == scope.origin.url
    else { throw WorkspaceRepositoryError.workspaceMismatch }
    self.client = client
    self.scope = scope
    profileID = scope.profileID
    origin = scope.origin
  }

  public func identity() async throws -> RemoteWorkspaceIdentity {
    let health = try await client.health()
    guard let workspace = health.workspaceId, let host = health.hostId else {
      throw WorkspaceRepositoryError.unsupportedHost
    }
    return RemoteWorkspaceIdentity(
      workspaceID: workspace, hostID: host,
      supportsConditionalWorkspaceWrites: health.capabilities?.contains("workspace-identity-v1")
        == true,
      supportsAttachmentUploads: health.capabilities?.contains("binary-files-v1") == true)
  }

  public func readAttachment(_ path: String) async throws -> VaultFilePayload? {
    do { return try await client.readFile(path) } catch let error as DaemonClientError
      where error.httpStatus == 404
    { return nil }
  }

  public func createAttachment(_ path: String, data: Data, workspaceID: String) async throws
    -> VaultFileMetadata
  {
    guard workspaceID == scope.workspaceID else { throw WorkspaceRepositoryError.workspaceMismatch }
    do {
      return try await client.writeFile(path, data: data, baseVersion: .createOnly)
    } catch DaemonClientError.conflict { throw WorkspaceRemoteError.conflict }
  }
}
