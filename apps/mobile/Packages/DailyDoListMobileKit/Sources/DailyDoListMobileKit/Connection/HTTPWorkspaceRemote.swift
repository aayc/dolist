import DailyDoListClient
import DailyDoListModels
import Foundation

/// The repository cannot be handed a legacy/unguarded client by accident. The same immutable
/// workspace header protects its reads and the actual conditional write after the handshake.
public struct HTTPWorkspaceRemote: WorkspaceRemote, CaptureRemote {
  public let profileID: UUID
  public let origin: ConnectionOrigin
  private let workspaceID: String
  private let client: HTTPDaemonClient

  public init(client: HTTPDaemonClient, scope: WorkspaceScope) throws {
    guard client.expectedWorkspaceId == scope.workspaceID,
      client.endpoint.baseURL == scope.origin.url
    else { throw WorkspaceRepositoryError.workspaceMismatch }
    self.client = client
    profileID = scope.profileID
    origin = scope.origin
    workspaceID = scope.workspaceID
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
      supportsAtomicCapture: health.capabilities?.contains("daily-append-v1") == true)
  }

  public func readNote(_ path: String) async throws -> RemoteNote? {
    do {
      let note = try await client.readNote(path)
      return RemoteNote(content: note.content, version: note.version)
    } catch let error as DaemonClientError where error.httpStatus == 404 {
      return nil
    }
  }

  public func writeNote(_ path: String, content: String, baseVersion: String?, workspaceID: String)
    async throws -> RemoteNote
  {
    guard self.workspaceID == workspaceID else { throw WorkspaceRepositoryError.workspaceMismatch }
    do {
      let result = try await client.writeNote(
        path, content: content,
        baseVersion: baseVersion.map { .match($0) } ?? .createOnly)
      return RemoteNote(content: content, version: result.version)
    } catch DaemonClientError.conflict {
      throw WorkspaceRemoteError.conflict
    }
  }
  public func append(_ capture: CaptureOperation) async throws -> CaptureReceipt {
    guard capture.scope.profileID == profileID, capture.scope.origin == origin,
      capture.scope.workspaceID == workspaceID
    else { throw WorkspaceRepositoryError.workspaceMismatch }
    let response = try await client.appendDailyNote(
      capture.localDate,
      request: DailyAppendRequest(
        operationId: capture.id.uuidString, hostId: capture.scope.hostID, text: capture.text,
        capturedAt: capture.capturedAt, timeZone: capture.timeZone))
    guard let id = UUID(uuidString: response.operationId) else {
      throw CaptureError.receiptMismatch
    }
    return CaptureReceipt(
      operationID: id, workspaceID: response.workspaceId,
      hostID: response.hostId, hostDate: response.hostDate, hostTimeZone: response.hostTimeZone,
      watched: response.watched, outcome: response.outcome == .applied ? .applied : .indeterminate,
      note: response.note, path: response.path)
  }

}
