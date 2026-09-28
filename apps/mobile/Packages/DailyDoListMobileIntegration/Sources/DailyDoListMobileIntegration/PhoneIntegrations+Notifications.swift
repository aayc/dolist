import CryptoKit
import DailyDoListMobileKit
import DailyDoListModels
import Foundation

extension PhoneIntegrations {
  /// At most three bounded pages per pass. A nil cursor asks the host for a baseline, so enabling
  /// notifications does not replay historical routine runs. A later pass resumes durable backlog.
  public func catchUp() async throws {
    guard !catchingUp else { return }
    catchingUp = true
    defer { catchingUp = false }
    for attempt in 0..<3 {
      do {
        try await performCatchUp()
        return
      } catch WorkspaceRepositoryError.concurrentWrite {
        // The foreground Inbox or a live notification won a CAS while REST was in flight.
        // Restart with fresh generations; never deliver from that superseded approval snapshot.
        try Task.checkCancellation()
        if attempt == 2 { throw WorkspaceRepositoryError.concurrentWrite }
      }
    }
  }

  private func performCatchUp() async throws {
    let settings = await preferences()
    guard settings.enabled, await notificationCenter.authorized() else { return }
    let scope = try await selectedScope()
    let cache = try WorkspaceCache(rootDirectory: rootDirectory, scope: scope)
    let remote = try await makeRemote(scope)
    defer { remote.close() }
    for _ in 0..<3 {
      let saved = try await cache.notifications()
      let page = try await remote.notifications(cursor: saved?.value.cursor, limit: 100)
      try await ensureCurrent(scope)
      let notifications = page.notifications.compactMap { value -> CachedNotification? in
        guard let id = value.id, PhoneRoute.validID(id) else { return nil }
        return CachedNotification(id: id, notification: value)
      }
      _ = try await cache.mergeNotifications(
        notifications, cursor: page.cursor, replacing: saved?.revision)
      try await deliverRoutines(cache: cache, scope: scope)
      if !page.hasMore { break }
    }
    try await refreshApprovals(remote: remote, cache: cache, scope: scope)
  }

  /// Live events and catch-up share the same durable IDs. Events from a retired/different profile
  /// are refused; the host's decision already incorporates each routine's notification policy.
  public func receive(_ notification: RoutineNotification, scope: WorkspaceScope) async throws {
    try await ensureCurrent(scope)
    guard let id = notification.id, PhoneRoute.validID(id) else { return }
    let settings = await preferences()
    guard settings.enabled, await notificationCenter.authorized() else { return }
    let cache = try WorkspaceCache(rootDirectory: rootDirectory, scope: scope)
    let saved = try await cache.notifications()
    _ = try await cache.mergeNotifications(
      [CachedNotification(id: id, notification: notification)], cursor: saved?.value.cursor,
      replacing: saved?.revision)
    try await deliverRoutines(cache: cache, scope: scope)
  }

  /// Disabling notifications removes sensitive previews that may already be on the lock screen.
  public func clearNotifications() async throws {
    let identifiers = await notificationCenter.existingIdentifiers().filter {
      $0.hasPrefix("dolist.")
    }
    await notificationCenter.remove(Set(identifiers))
    try await notificationCenter.setBadge(0)
  }

  public func clearNotifications(for scope: WorkspaceScope) async {
    let prefixes = [
      Self.notificationPrefix(scope, kind: .approval),
      Self.notificationPrefix(scope, kind: .routine),
    ]
    let identifiers = await notificationCenter.existingIdentifiers().filter { id in
      prefixes.contains(where: id.hasPrefix)
    }
    await notificationCenter.remove(Set(identifiers))
    // Forget also runs after a restart, when no in-memory notification owner remains. A
    // remaining connection's next authoritative catch-up can publish its current count.
    try? await notificationCenter.setBadge(0)
  }

  public func backgroundRefreshAllowed() async -> Bool {
    let settings = await preferences()
    return settings.enabled && settings.backgroundRefresh && !settings.requiresUnlockedStorage
  }

  private func deliverRoutines(cache: WorkspaceCache, scope: WorkspaceScope) async throws {
    guard let saved = try await cache.notifications() else { return }
    var processed = Set<String>()
    let existing = await notificationCenter.existingIdentifiers()
    for item in saved.value.items where !item.delivered {
      try await ensureCurrent(scope)
      let value = item.notification
      guard PhoneRoute.validID(value.threadId) else {
        processed.insert(item.id)
        continue
      }
      let identifier = Self.notificationID(scope, kind: .routine, id: item.id)
      let visible = await visibleDestination()
      let isVisible =
        visible.scope == scope
        && (visible.threadID == value.threadId || visible.routineID == value.routineId)
      if !existing.contains(identifier), !isVisible {
        let current = await preferences()
        guard current.enabled else { return }
        try await deliver(
          PhoneNotification(
            id: identifier, kind: .routine,
            title: current.showPreviews ? String(value.title.prefix(160)) : "Do List update",
            body: current.showPreviews
              ? String(value.body.prefix(500))
              : "A routine has an update. Open Do List to view it.",
            route: PhoneRoute(scope: scope, destination: .thread(value.threadId, approvalID: nil))),
          settings: current)
      }
      processed.insert(item.id)
    }
    if !processed.isEmpty {
      _ = try await cache.markNotificationsDelivered(processed, replacing: saved.revision)
    }
  }

  private func refreshApprovals(
    remote: any PhoneIntegrationRemote, cache: WorkspaceCache, scope: WorkspaceScope
  ) async throws {
    let inbox = try approvalCacheFactory(scope)
    let prior = try await inbox.snapshot()
    let approvals = try await remote.pendingApprovals().filter(\.isPending)
    try await ensureCurrent(scope)
    try await inbox.replacePending(approvals, replacing: prior?.generation)
    let saved = try await cache.notifications()
    let seen = Set(saved?.value.seenIDs ?? [])
    let existing = await notificationCenter.existingIdentifiers()
    let prefix = Self.notificationPrefix(scope, kind: .approval)
    let currentIDs = Set(approvals.map { Self.notificationID(scope, kind: .approval, id: $0.id) })
    await notificationCenter.remove(
      Set(existing.filter { $0.hasPrefix(prefix) }).subtracting(currentIDs))
    var processed: [String] = []
    for approval in approvals {
      try await ensureCurrent(scope)
      guard PhoneRoute.validID(approval.id) else { continue }
      let identifier = Self.notificationID(scope, kind: .approval, id: approval.id)
      if seen.contains(identifier) { continue }
      let visible = await visibleDestination()
      let isVisible =
        visible.scope == scope && approval.threadId != nil && visible.threadID == approval.threadId
      if !existing.contains(identifier), !isVisible {
        let current = await preferences()
        guard current.enabled else { return }
        let destination: PhoneRoute.Destination
        if let thread = approval.threadId, PhoneRoute.validID(thread) {
          destination = .thread(thread, approvalID: approval.id)
        } else {
          destination = .inbox
        }
        try await deliver(
          PhoneNotification(
            id: identifier, kind: .approval, title: "Do List needs your review",
            body: current.showPreviews
              ? String(approval.summary.prefix(500))
              : "An action is waiting for approval. Open Do List to review it.",
            route: PhoneRoute(scope: scope, destination: destination)), settings: current)
      }
      processed.append(identifier)
    }
    if !processed.isEmpty {
      _ = try await cache.rememberNotificationIDs(processed, replacing: saved?.revision)
    }
    try await ensureCurrent(scope)
    try await notificationCenter.setBadge(approvals.count)
  }

  private func deliver(_ notification: PhoneNotification, settings: PhoneNotificationPreferences)
    async throws
  {
    try await ensureCurrent(notification.route.scope)
    do {
      try await notificationCenter.deliver(notification)
      try await ensureCurrent(notification.route.scope)
    } catch {
      let latest = await preferences()
      if !latest.enabled || latest.showPreviews != settings.showPreviews {
        await notificationCenter.remove([notification.id])
      }
      if (try? await selectedScope()) != notification.route.scope {
        await notificationCenter.remove([notification.id])
      }
      throw error
    }
    // Permission/privacy or the selected workspace can change while the system queues the alert.
    let latest = await preferences()
    if !latest.enabled || latest.showPreviews != settings.showPreviews {
      await notificationCenter.remove([notification.id])
    }
  }

  static func notificationPrefix(_ scope: WorkspaceScope, kind: PhoneNotification.Kind) -> String {
    let namespace = scope.profileID.uuidString + ":" + scope.workspaceID + ":" + scope.hostID
    return "dolist." + digest(namespace) + "." + kind.rawValue + "."
  }
  static func notificationID(_ scope: WorkspaceScope, kind: PhoneNotification.Kind, id: String)
    -> String
  {
    notificationPrefix(scope, kind: kind) + digest(id)
  }
  private static func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}
