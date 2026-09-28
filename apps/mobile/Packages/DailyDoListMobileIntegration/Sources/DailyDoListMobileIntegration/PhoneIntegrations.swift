import DailyDoListMobileKit
import DailyDoListModels
import Foundation

#if os(iOS)
  import UIKit
#endif

/// Shared by foreground UI, App Intents and the optional short background refresh. Every invocation
/// binds a verified profile before it touches the durable workspace namespace or a remote host.
public actor PhoneIntegrations {
  public typealias RemoteFactory =
    @Sendable (WorkspaceScope, String) throws -> any PhoneIntegrationRemote
  public typealias ApprovalCacheFactory =
    @Sendable (WorkspaceScope) throws -> any PhoneApprovalCache
  let prepareStorage: @Sendable () async throws -> Void
  let foregroundDataAvailable: @Sendable () async -> Bool
  let rootDirectory: URL
  let profiles: any ConnectionProfileStore
  let credentials: any ConnectionCredentials
  let selectedProfile: @Sendable () async -> UUID?
  let preferences: @Sendable () async -> PhoneNotificationPreferences
  let visibleDestination: @Sendable () async -> PhoneVisibleDestination
  let notificationCenter: any PhoneNotificationCenter
  let remoteFactory: RemoteFactory
  let approvalCacheFactory: ApprovalCacheFactory
  var catchingUp = false

  public init(
    rootDirectory: URL, profiles: any ConnectionProfileStore,
    credentials: any ConnectionCredentials,
    selectedProfile: @escaping @Sendable () async -> UUID?,
    preferences: @escaping @Sendable () async -> PhoneNotificationPreferences,
    visibleDestination: @escaping @Sendable () async -> PhoneVisibleDestination = {
      PhoneVisibleDestination()
    },
    notificationCenter: any PhoneNotificationCenter,
    approvalCacheFactory: @escaping ApprovalCacheFactory,
    prepareStorage: @escaping @Sendable () async throws -> Void = {},
    foregroundDataAvailable: @escaping @Sendable () async -> Bool = {
      #if os(iOS)
        await MainActor.run { UIApplication.shared.isProtectedDataAvailable }
      #else
        true
      #endif
    },
    remoteFactory: @escaping RemoteFactory = {
      try HTTPPhoneIntegrationRemote(scope: $0, token: $1)
    }
  ) {
    self.prepareStorage = prepareStorage
    self.foregroundDataAvailable = foregroundDataAvailable
    self.rootDirectory = rootDirectory
    self.profiles = profiles
    self.credentials = credentials
    self.selectedProfile = selectedProfile
    self.preferences = preferences
    self.visibleDestination = visibleDestination
    self.notificationCenter = notificationCenter
    self.approvalCacheFactory = approvalCacheFactory
    self.remoteFactory = remoteFactory
  }

  /// Call only in response to the Settings permission button; catch-up never prompts.
  public func requestNotificationPermission() async throws -> Bool {
    try await notificationCenter.requestAuthorization()
  }

  public func capture(_ request: PhoneCaptureRequest) async throws -> PhoneCaptureResult {
    try await requireForegroundAccess()
    let scope = try await selectedScope()
    try await requireForegroundAccess()
    let outbox = try CaptureOutbox(rootDirectory: rootDirectory, scope: scope)
    _ = try await outbox.enqueue(
      text: request.text, capturedAt: request.capturedAt, timeZone: request.timeZone,
      operationID: request.id)
    do {
      try Task.checkCancellation()
      let remote = try await makeRemote(scope)
      defer { remote.close() }
      _ = try await outbox.synchronize(with: remote, operationIDs: [request.id])
    } catch {
      // The operation is already durable. Losing connectivity or cancellation cannot replace its ID.
    }
    guard let saved = try await outbox.capture(request.id) else {
      throw PhoneIntegrationError.notConfigured
    }
    try await requireForegroundAccess()
    let status: PhoneCaptureResult.Status
    switch saved.state {
    case .applied: status = .added
    case .indeterminate, .reconciled, .cancelled: status = .needsReview
    case .queued, .sending: status = .waitingForConnection
    }
    return PhoneCaptureResult(
      operationID: request.id, status: status, localDate: saved.operation.localDate,
      watchedByHost: saved.receipt?.watched)
  }

  public func route(_ destination: PhoneRoute.Destination) async throws -> PhoneRoute {
    try await requireForegroundAccess()
    let scope = try await selectedScope()
    try await requireForegroundAccess()
    return PhoneRoute(scope: scope, destination: destination)
  }

  public func parseRoute(_ url: URL) async throws -> PhoneRoute {
    try await PhoneRoute.parse(url, profiles: profiles.profiles())
  }

  public func approvalCount() async throws -> ApprovalCountResult {
    try await requireForegroundAccess()
    let scope = try await selectedScope()
    let cache = try approvalCacheFactory(scope)
    let saved = try await cache.snapshot()
    do {
      let remote = try await makeRemote(scope)
      defer { remote.close() }
      let approvals = try await remote.pendingApprovals()
      try await ensureCurrent(scope)
      try await cache.replacePending(approvals, replacing: saved?.generation)
      try await requireForegroundAccess()
      return ApprovalCountResult(
        count: approvals.filter(\.isPending).count, cachedAt: nil, isCached: false)
    } catch {
      try Task.checkCancellation()
      try await ensureCurrent(scope)
      try await requireForegroundAccess()
      guard let current = try await cache.snapshot(), let fetched = current.fetchedAt else {
        throw error
      }
      try await requireForegroundAccess()
      return ApprovalCountResult(
        count: current.approvals.filter(\.isPending).count, cachedAt: fetched, isCached: true)
    }
  }

  private func requireForegroundAccess() async throws {
    guard await foregroundDataAvailable() else {
      throw PhoneIntegrationError.protectedDataUnavailable
    }
  }

  func selectedScope() async throws -> WorkspaceScope {
    try await prepareStorage()
    try Task.checkCancellation()
    let all = try await profiles.profiles()
    let selected = await selectedProfile()
    let profile =
      selected.flatMap { id in all.first { $0.id == id } }
      ?? (selected == nil && all.count == 1 ? all.first : nil)
    guard let profile else { throw PhoneIntegrationError.chooseConnection }
    guard let workspace = profile.workspaceID, let host = profile.hostID else {
      throw PhoneIntegrationError.unverifiedConnection
    }
    return WorkspaceScope(
      profileID: profile.id, workspaceID: workspace, hostID: host, origin: profile.origin)
  }
  func ensureCurrent(_ scope: WorkspaceScope) async throws {
    guard try await selectedScope() == scope else {
      throw PhoneIntegrationError.unverifiedConnection
    }
    try Task.checkCancellation()
  }
  func makeRemote(_ scope: WorkspaceScope) async throws -> any PhoneIntegrationRemote {
    try await ensureCurrent(scope)
    guard let token = try await credentials.token(for: scope.profileID) else {
      throw PhoneIntegrationError.unverifiedConnection
    }
    try await ensureCurrent(scope)
    return try remoteFactory(scope, token)
  }
}
