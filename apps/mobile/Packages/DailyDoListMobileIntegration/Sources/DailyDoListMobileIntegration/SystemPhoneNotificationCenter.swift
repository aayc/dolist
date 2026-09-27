#if os(iOS)
  import Foundation
  @preconcurrency import UserNotifications

  /// Retain this delegate for the app lifetime. Routing is validated by PhoneIntegrations.parseRoute
  /// before the shell navigates; the notification contains no credential or executable decision.
  public final class SystemPhoneNotificationCenter: NSObject, PhoneNotificationCenter,
    UNUserNotificationCenterDelegate, Sendable
  {
    private let center: UNUserNotificationCenter
    private let openRoute: @Sendable (URL) async -> Void
    public init(
      center: UNUserNotificationCenter = .current(),
      openRoute: @escaping @Sendable (URL) async -> Void
    ) {
      self.center = center
      self.openRoute = openRoute
      super.init()
      center.delegate = self
      let open = UNNotificationAction(
        identifier: "dolist.open", title: "Open Do List",
        options: [.foreground, .authenticationRequired])
      center.setNotificationCategories(
        Set(
          PhoneNotification.Kind.allCases.map {
            UNNotificationCategory(
              identifier: "dolist." + $0.rawValue, actions: [open], intentIdentifiers: [],
              options: [])
          }))
    }
    public func requestAuthorization() async throws -> Bool {
      try await center.requestAuthorization(options: [.alert, .badge, .sound])
    }
    public func authorized() async -> Bool {
      let status = await center.notificationSettings().authorizationStatus
      return status == .authorized || status == .provisional || status == .ephemeral
    }
    public func existingIdentifiers() async -> Set<String> {
      let delivered = await center.deliveredNotifications().map { $0.request.identifier }
      let pending = await center.pendingNotificationRequests().map(\.identifier)
      return Set(delivered + pending)
    }
    public func deliver(_ notification: PhoneNotification) async throws {
      let content = UNMutableNotificationContent()
      content.title = notification.title
      content.body = notification.body
      content.sound = .default
      content.categoryIdentifier = "dolist." + notification.kind.rawValue
      content.threadIdentifier = notification.route.scope.profileID.uuidString
      content.userInfo = ["dolist.route": try notification.route.url().absoluteString]
      try await center.add(
        UNNotificationRequest(identifier: notification.id, content: content, trigger: nil))
    }
    public func remove(_ identifiers: Set<String>) async {
      center.removeDeliveredNotifications(withIdentifiers: Array(identifiers))
      center.removePendingNotificationRequests(withIdentifiers: Array(identifiers))
    }
    public func setBadge(_ count: Int) async throws {
      try await center.setBadgeCount(max(0, count))
    }
    public func userNotificationCenter(
      _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
      guard
        response.actionIdentifier == UNNotificationDefaultActionIdentifier
          || response.actionIdentifier == "dolist.open",
        let route = response.notification.request.content.userInfo["dolist.route"] as? String,
        let url = URL(string: route)
      else { return }
      await openRoute(url)
    }
    public func userNotificationCenter(
      _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
      [.banner, .list, .sound]
    }
  }
#endif
