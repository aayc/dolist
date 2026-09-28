import DailyDoListMobileKit
import DailyDoListModels
import Foundation
import Testing

@testable import DailyDoListMobileIntegration

struct IntegrationTests {
  @Test func lockedForegroundIntentsCannotReadCountsRouteOrQueueCaptures() async throws {
    let f = try Fixture()
    defer { f.remove() }
    let service = f.service(foregroundDataAvailable: { false })
    await #expect(throws: PhoneIntegrationError.self) { try await service.approvalCount() }
    await #expect(throws: PhoneIntegrationError.self) { try await service.route(.today) }
    await #expect(throws: PhoneIntegrationError.self) {
      try await service.capture(PhoneCaptureRequest(text: "A protected synthetic capture"))
    }
    #expect(await f.remote.attempts.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: f.root.path))
  }

  @Test func lockingDuringAnApprovalFetchDoesNotDiscloseFreshOrCachedCounts() async throws {
    let f = try Fixture()
    defer { f.remove() }
    let availability = MutableAvailability()
    let service = f.service(foregroundDataAvailable: { await availability.available })
    await f.remote.setApprovals([approval("synthetic-approval")])
    await f.remote.onApprovals { await availability.lock() }
    await #expect(throws: PhoneIntegrationError.protectedDataUnavailable) {
      try await service.approvalCount()
    }
  }

  @Test func foregroundCacheContentionRefetchesBeforeAlerting() async throws {
    let f = try Fixture()
    defer { f.remove() }
    await f.remote.setApprovals([approval("superseded")])
    await f.inbox.conflictNextWrite {
      await f.remote.setApprovals([approval("current")])
    }
    try await f.service().catchUp()
    #expect(await f.center.sent.count == 1)
    #expect(
      await f.center.sent.first?.route.destination == .thread("thread-1", approvalID: "current"))
    #expect(await f.inbox.approvals.map(\.id) == ["current"])
  }

  @Test func captureSurvivesLostReplyAndRestartWithFrozenPhoneDate() async throws {
    let f = try Fixture()
    defer { f.remove() }
    await f.remote.setLoseReply(true)
    let request = PhoneCaptureRequest(
      text: "A synthetic task", capturedAt: Date(timeIntervalSince1970: 1_767_227_400),
      timeZone: try #require(TimeZone(identifier: "America/Los_Angeles")))
    let first = try await f.service().capture(request)
    #expect(first.status == .waitingForConnection)
    #expect(first.localDate == "2025-12-31")
    let saved = try CaptureOutbox(rootDirectory: f.root, scope: f.scope)
    #expect(try await saved.capture(request.id)?.state == .sending)
    let repeated = try await f.service().capture(request)
    #expect(repeated.status == .added)
    #expect(await f.remote.commits == 1)
    #expect(await f.remote.attempts.count == 2)
    #expect(await f.remote.attempts.first == f.remote.attempts.last)
    await #expect(throws: CaptureError.operationIDReused) {
      try await f.service().capture(
        PhoneCaptureRequest(
          id: request.id, text: "Different task", capturedAt: request.capturedAt,
          timeZone: request.timeZone))
    }
  }

  @Test func shortIntentAttemptsOnlyItsOwnCaptureAndLeavesOlderWorkDurable() async throws {
    let f = try Fixture()
    defer { f.remove() }
    let outbox = try CaptureOutbox(rootDirectory: f.root, scope: f.scope)
    let older = try await outbox.enqueue(
      text: "Older queued task", capturedAt: Date(timeIntervalSince1970: 100),
      timeZone: TimeZone(secondsFromGMT: 0)!)
    let request = PhoneCaptureRequest(text: "The requested capture")
    #expect(try await f.service().capture(request).status == .added)
    #expect(await f.remote.attempts.map(\.id) == [request.id])
    #expect(try await outbox.capture(older.id)?.state == .queued)
  }

  @Test func baselineThenCatchUpIsPrivateDurableAndDeduplicatedAcrossLiveEvents() async throws {
    let f = try Fixture()
    defer { f.remove() }
    let service = f.service()
    try await service.catchUp()
    #expect(await f.remote.cursors == [nil])
    #expect(await f.center.sent.isEmpty)
    let update = routine("event-1")
    await f.remote.setNotifications([update])
    try await service.catchUp()
    #expect(await f.center.sent.count == 1)
    #expect(await f.center.sent.first?.body.contains("SECRET") == false)
    await f.center.dismissAll()
    try await f.service().catchUp()
    try await service.receive(update, scope: f.scope)
    #expect(await f.center.sent.count == 1)
    #expect(await f.center.permissionRequests == 0)
  }

  @Test func deliveryLostAcknowledgementUsesSystemIdentifierOnRestart() async throws {
    let f = try Fixture()
    defer { f.remove() }
    try await f.service().catchUp()
    await f.remote.setNotifications([routine("event-lost-ack")])
    await f.center.loseNextAcknowledgement()
    await #expect(throws: URLError.self) { try await f.service().catchUp() }
    #expect(await f.center.sent.count == 1)
    try await f.service().catchUp()
    #expect(await f.center.sent.count == 1)
    let cache = try WorkspaceCache(rootDirectory: f.root, scope: f.scope)
    #expect(try await cache.notifications()?.value.items.first?.delivered == true)
  }

  @Test func disablingPreviewsDuringDeliveryRemovesThePendingPrivateText() async throws {
    let f = try Fixture()
    defer { f.remove() }
    let preferences = MutablePreferences()
    let service = f.service(overridePreferences: { await preferences.value })
    try await service.catchUp()
    await f.remote.setNotifications([routine("event-privacy-race")])
    await f.center.onDelivery { await preferences.hidePreviews() }
    try await service.catchUp()
    #expect(await f.center.sent.first?.body == "SECRET routine details")
    #expect(await f.center.existing.isEmpty)
  }

  @Test func retiredWorkspaceCannotBeResurrectedByAnIntent() async throws {
    let f = try Fixture()
    defer { f.remove() }
    let repository = try WorkspaceRepository(rootDirectory: f.root, scope: f.scope)
    _ = try await repository.create(path: "Synthetic.md", content: "A saved note")
    let recovery = try WorkspaceRecovery(rootDirectory: f.root, scope: f.scope)
    try await recovery.forget(discardUnsyncedWork: true)
    await #expect(throws: WorkspaceRepositoryError.workspaceForgotten) {
      try await f.service().capture(PhoneCaptureRequest(text: "Must not reappear"))
    }
    #expect(await f.remote.commits == 0)
  }

  @Test func approvalsUseOneCacheClearObsoleteAlertsAndLabelOfflineCounts() async throws {
    let f = try Fixture()
    defer { f.remove() }
    await f.remote.setApprovals([approval("approval-1")])
    try await f.service().catchUp()
    #expect(await f.center.sent.count == 1)
    #expect(await f.center.badge == 1)
    #expect(await f.center.sent.first?.body.contains("SECRET") == false)
    let fresh = try await f.service().approvalCount()
    #expect(fresh.count == 1 && !fresh.isCached)
    await f.remote.setOffline(true)
    let cached = try await f.service().approvalCount()
    #expect(cached.count == 1 && cached.isCached && cached.cachedAt != nil)
    await f.remote.setOffline(false)
    await f.remote.setApprovals([])
    try await f.service().catchUp()
    #expect(await f.center.existing.isEmpty)
    #expect(await f.center.badge == 0)
  }

  @Test func visibleRoutineIsConsumedWithoutDelayedAlertAndPrivacyCanBeOptedIn() async throws {
    let f = try Fixture()
    defer { f.remove() }
    try await f.service().catchUp()
    await f.remote.setNotifications([routine("event-visible")])
    try await f.service(visible: PhoneVisibleDestination(scope: f.scope, routineID: "routine-1"))
      .catchUp()
    try await f.service().catchUp()
    #expect(await f.center.sent.isEmpty)
    await f.remote.setNotifications([routine("event-new")])
    try await f.service(previews: true).catchUp()
    #expect(await f.center.sent.first?.body == "SECRET routine details")
  }

  @Test func linksBindSavedAuthorityAndNeverCarryActionsOrCredentials() throws {
    let f = try Fixture()
    defer { f.remove() }
    let original = PhoneRoute(
      scope: f.scope, destination: .thread("thread-1", approvalID: "approval-1"))
    let url = try original.url()
    #expect(try PhoneRoute.parse(url, profiles: [f.profile]) == original)
    var changed = f.profile
    changed.hostID = "replacement-host"
    #expect(throws: PhoneIntegrationError.self) { try PhoneRoute.parse(url, profiles: [changed]) }
    for invalid in [
      url.absoluteString + "&token=secret", url.absoluteString + "&host=other",
      url.absoluteString.replacingOccurrences(of: "/thread/thread-1", with: "/approve/approval-1"),
      url.absoluteString.replacingOccurrences(of: "dolist://open", with: "dolist://user@open"),
    ] {
      #expect(throws: PhoneIntegrationError.self) {
        try PhoneRoute.parse(URL(string: invalid)!, profiles: [f.profile])
      }
    }
  }

  @Test func disabledAndStrictStorageNeverEnableBackgroundOrAskPermission() async throws {
    let f = try Fixture()
    defer { f.remove() }
    let disabled = f.service(enabled: false)
    try await disabled.catchUp()
    #expect(await f.remote.cursors.isEmpty)
    #expect(await disabled.backgroundRefreshAllowed() == false)
    #expect(await f.service(strict: true).backgroundRefreshAllowed() == false)
    #expect(await f.service().backgroundRefreshAllowed())
    #expect(await f.center.permissionRequests == 0)
    #expect(try await disabled.requestNotificationPermission())
    #expect(await f.center.permissionRequests == 1)
  }
}

private func routine(_ id: String) -> RoutineNotification {
  RoutineNotification(
    routineId: "routine-1", title: "SECRET title", body: "SECRET routine details",
    threadId: "thread-1", status: .done, at: 1, id: id)
}
private func approval(_ id: String) -> ApprovalRequest {
  ApprovalRequest(
    id: id, threadId: "thread-1", taskId: nil, toolName: "synthetic", input: .null,
    summary: "SECRET action", risk: .high, categories: [], reason: "Review", status: .pending,
    createdAt: 1)
}

private struct Fixture {
  let root: URL
  let scope: WorkspaceScope
  let profile: ConnectionProfile
  let remote: FakeRemote
  let center = FakeCenter()
  let inbox = FakeApprovalCache()
  init() throws {
    root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    var profile = ConnectionProfile(
      name: "Synthetic connection", origin: try ConnectionOrigin("https://integration.invalid"))
    profile.workspaceID = "workspace-test"
    profile.hostID = "host-test"
    self.profile = profile
    scope = WorkspaceScope(
      profileID: profile.id, workspaceID: "workspace-test", hostID: "host-test",
      origin: profile.origin)
    remote = FakeRemote(scope: scope)
  }
  func remove() { try? FileManager.default.removeItem(at: root) }
  func service(
    previews: Bool = false, visible: PhoneVisibleDestination = PhoneVisibleDestination(),
    enabled: Bool = true, strict: Bool = false,
    overridePreferences: (@Sendable () async -> PhoneNotificationPreferences)? = nil,
    foregroundDataAvailable: @escaping @Sendable () async -> Bool = { true }
  ) -> PhoneIntegrations {
    PhoneIntegrations(
      rootDirectory: root, profiles: FakeProfiles(profile: profile), credentials: FakeCredentials(),
      selectedProfile: { profile.id },
      preferences: overridePreferences ?? {
        PhoneNotificationPreferences(
          enabled: enabled, showPreviews: previews, backgroundRefresh: true,
          requiresUnlockedStorage: strict)
      }, visibleDestination: { visible }, notificationCenter: center,
      approvalCacheFactory: { _ in inbox }, foregroundDataAvailable: foregroundDataAvailable,
      remoteFactory: { _, _ in remote })
  }
}
private struct FakeProfiles: ConnectionProfileStore {
  let profile: ConnectionProfile
  func profiles() async throws -> [ConnectionProfile] { [profile] }
  func save(_ profile: ConnectionProfile) async throws {}
  func remove(_ id: UUID) async throws {}
}
private struct FakeCredentials: ConnectionCredentials {
  func token(for profileID: UUID) async throws -> String? { "synthetic-test-credential" }
  func save(_ token: String, for profileID: UUID) async throws {}
  func remove(_ profileID: UUID) async throws {}
}
private actor FakeApprovalCache: PhoneApprovalCache {
  var approvals: [ApprovalRequest] = []
  var generation: Int64 = 0
  var nextConflict: (@Sendable () async -> Void)?
  func conflictNextWrite(_ action: @escaping @Sendable () async -> Void) { nextConflict = action }
  func snapshot() async throws -> PhoneApprovalSnapshot? {
    generation == 0
      ? nil
      : PhoneApprovalSnapshot(
        approvals: approvals, fetchedAt: Date(timeIntervalSince1970: 100), generation: generation)
  }
  func replacePending(_ approvals: [ApprovalRequest], replacing generation: Int64?) async throws {
    if let action = nextConflict {
      nextConflict = nil
      await action()
      self.generation += 1
      throw WorkspaceRepositoryError.concurrentWrite
    }
    guard generation == (self.generation == 0 ? nil : self.generation) else {
      throw WorkspaceRepositoryError.concurrentWrite
    }
    self.approvals = approvals
    self.generation += 1
  }
}
private actor MutablePreferences {
  var value = PhoneNotificationPreferences(enabled: true, showPreviews: true)
  func hidePreviews() { value.showPreviews = false }
}
private actor MutableAvailability {
  var available = true
  func lock() { available = false }
}
private actor FakeCenter: PhoneNotificationCenter {
  var sent: [PhoneNotification] = []
  var existing: Set<String> = []
  var badge = 0
  var permissionRequests = 0
  var loseAcknowledgement = false
  var deliveryHook: (@Sendable () async -> Void)?
  func onDelivery(_ action: @escaping @Sendable () async -> Void) { deliveryHook = action }
  func loseNextAcknowledgement() { loseAcknowledgement = true }
  func requestAuthorization() async throws -> Bool {
    permissionRequests += 1
    return true
  }
  func authorized() async -> Bool { true }
  func existingIdentifiers() async -> Set<String> { existing }
  func deliver(_ notification: PhoneNotification) async throws {
    sent.append(notification)
    existing.insert(notification.id)
    await deliveryHook?()
    if loseAcknowledgement {
      loseAcknowledgement = false
      throw URLError(.networkConnectionLost)
    }
  }
  func remove(_ identifiers: Set<String>) async { existing.subtract(identifiers) }
  func setBadge(_ count: Int) async throws { badge = count }
  func dismissAll() { existing.removeAll() }
}
private actor FakeRemote: PhoneIntegrationRemote {
  nonisolated let profileID: UUID
  nonisolated let origin: ConnectionOrigin
  let scope: WorkspaceScope
  var loseReply = false
  var offline = false
  var commits = 0
  var attempts: [CaptureOperation] = []
  var receipts: [UUID: CaptureReceipt] = [:]
  var cursors: [String?] = []
  var updates: [RoutineNotification] = []
  var approvals: [ApprovalRequest] = []
  var approvalsHook: (@Sendable () async -> Void)?
  init(scope: WorkspaceScope) {
    self.scope = scope
    profileID = scope.profileID
    origin = scope.origin
  }
  func setLoseReply(_ value: Bool) { loseReply = value }
  func setOffline(_ value: Bool) { offline = value }
  func setNotifications(_ value: [RoutineNotification]) { updates = value }
  func setApprovals(_ value: [ApprovalRequest]) { approvals = value }
  func onApprovals(_ action: @escaping @Sendable () async -> Void) { approvalsHook = action }
  func identity() async throws -> RemoteWorkspaceIdentity {
    if offline { throw URLError(.notConnectedToInternet) }
    return RemoteWorkspaceIdentity(
      workspaceID: scope.workspaceID, hostID: scope.hostID,
      supportsConditionalWorkspaceWrites: true, supportsAtomicCapture: true)
  }
  func append(_ operation: CaptureOperation) async throws -> CaptureReceipt {
    attempts.append(operation)
    if let prior = receipts[operation.id] { return prior }
    let value = CaptureReceipt(
      operationID: operation.id, workspaceID: scope.workspaceID, hostID: scope.hostID,
      hostDate: operation.localDate, hostTimeZone: "UTC", watched: false, outcome: .applied,
      note: DailyNoteResponse(
        path: "Daily/" + operation.localDate + ".md", content: operation.text, version: "v1",
        mtime: 1, date: operation.localDate, created: true))
    receipts[operation.id] = value
    commits += 1
    if loseReply {
      loseReply = false
      throw URLError(.networkConnectionLost)
    }
    return value
  }
  func pendingApprovals() async throws -> [ApprovalRequest] {
    if offline { throw URLError(.notConnectedToInternet) }
    await approvalsHook?()
    return approvals
  }
  func notifications(cursor: String?, limit: Int) async throws -> AgentNotificationsResponse {
    if offline { throw URLError(.notConnectedToInternet) }
    cursors.append(cursor)
    return AgentNotificationsResponse(
      notifications: cursor == nil ? [] : updates, cursor: "cursor-1", hasMore: false)
  }
  nonisolated func close() {}
}
