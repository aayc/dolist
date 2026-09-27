import DailyDoListClient
import DailyDoListMobileKit
import DailyDoListModels
import Foundation

public protocol PhoneIntegrationRemote: CaptureRemote {
  func pendingApprovals() async throws -> [ApprovalRequest]
  func notifications(cursor: String?, limit: Int) async throws -> AgentNotificationsResponse
  func close()
}

public struct PhoneApprovalSnapshot: Sendable {
  public let approvals: [ApprovalRequest]
  public let fetchedAt: Date?
  public let generation: Int64?
  public init(approvals: [ApprovalRequest], fetchedAt: Date?, generation: Int64?) {
    self.approvals = approvals
    self.fetchedAt = fetchedAt
    self.generation = generation
  }
}

/// The app's existing Inbox cache supplies this adapter; cached requests never authorize decisions.
public protocol PhoneApprovalCache: Sendable {
  func snapshot() async throws -> PhoneApprovalSnapshot?
  func replacePending(_ approvals: [ApprovalRequest], replacing generation: Int64?) async throws
}

public final class HTTPPhoneIntegrationRemote: PhoneIntegrationRemote, Sendable {
  public let profileID: UUID
  public let origin: ConnectionOrigin
  private let scope: WorkspaceScope
  private let session: URLSession
  private let client: HTTPDaemonClient
  private let capture: HTTPWorkspaceRemote

  public init(scope: WorkspaceScope, token: String) throws {
    self.scope = scope
    profileID = scope.profileID
    origin = scope.origin
    session = PrivateConnectionSession().makeSession()
    client = HTTPDaemonClient(
      endpoint: DaemonEndpoint(
        baseURL: scope.origin.url, token: token, forceHeaderAuthentication: true),
      session: session, clientVersion: "iphone/integration",
      options: HTTPDaemonClient.Options(requestTimeout: .seconds(5)),
      expectedWorkspaceId: scope.workspaceID)
    capture = try HTTPWorkspaceRemote(client: client, scope: scope)
  }
  public func identity() async throws -> RemoteWorkspaceIdentity { try await capture.identity() }
  public func append(_ operation: CaptureOperation) async throws -> CaptureReceipt {
    try await capture.append(operation)
  }
  public func pendingApprovals() async throws -> [ApprovalRequest] {
    try await verify()
    return try await client.approvals(status: .pending)
  }
  public func notifications(cursor: String?, limit: Int) async throws -> AgentNotificationsResponse
  {
    try await verify(requireNotifications: true)
    return try await client.agentNotifications(cursor: cursor, limit: limit)
  }
  public func close() { session.invalidateAndCancel() }
  private func verify(requireNotifications: Bool = false) async throws {
    let health = try await client.health()
    guard health.workspaceId == scope.workspaceID, health.hostId == scope.hostID,
      health.capabilities?.contains("workspace-identity-v1") == true
    else { throw PhoneIntegrationError.unverifiedConnection }
    if requireNotifications, health.capabilities?.contains("notification-catch-up-v1") != true {
      throw PhoneIntegrationError.unsupportedHost
    }
  }
}
