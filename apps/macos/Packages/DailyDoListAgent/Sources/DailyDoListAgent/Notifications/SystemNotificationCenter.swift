import Foundation
import OSLog
@preconcurrency import UserNotifications

/// `AgentNotificationCenter` backed by `UNUserNotificationCenter`. It only works inside a bundled
/// app (it needs a bundle identifier), so `makeIfSupported()` returns nil under `swift run` and in
/// tests, and the notifier degrades to doing nothing.
@MainActor
public final class SystemNotificationCenter: NSObject, AgentNotificationCenter {
  public var onResponse: (@MainActor (AgentNotificationResponse) -> Void)?
  private let center: UNUserNotificationCenter
  private static var loggedUnsupported = false
  static let logger = Logger(subsystem: "DailyDoList", category: "notifications")

  /// True inside a bundled `.app` that isn't running tests.
  public static var isSupported: Bool {
    let bundle = Bundle.main
    guard bundle.bundleIdentifier != nil, bundle.bundleURL.pathExtension == "app" else {
      return false
    }
    let environment = ProcessInfo.processInfo.environment
    if environment["XCTestConfigurationFilePath"] != nil || environment["XCTestBundlePath"] != nil {
      return false
    }
    return NSClassFromString("XCTestCase") == nil
  }

  /// The system center, or nil (logged once) where notifications can't work.
  public static func makeIfSupported() -> SystemNotificationCenter? {
    guard isSupported else {
      if !loggedUnsupported {
        loggedUnsupported = true
        logger.info("Notifications are off: not running as a bundled app")
      }
      return nil
    }
    return SystemNotificationCenter(center: .current())
  }

  private init(center: UNUserNotificationCenter) {
    self.center = center
    super.init()
    center.delegate = self
  }

  public func requestAuthorization() async -> Bool {
    do {
      return try await center.requestAuthorization(options: [.alert, .sound, .badge])
    } catch {
      Self.logger.error("Notification authorization failed: \(error.localizedDescription)")
      return false
    }
  }

  public func setCategories(_ categories: [AgentNotificationCategory]) {
    center.setNotificationCategories(
      Set(
        categories.map { category in
          UNNotificationCategory(
            identifier: category.identifier,
            actions: category.actions.map { action in
              var options: UNNotificationActionOptions = []
              if action.isDestructive { options.insert(.destructive) }
              if action.requiresAuthentication { options.insert(.authenticationRequired) }
              return UNNotificationAction(
                identifier: action.identifier, title: action.title, options: options)
            },
            intentIdentifiers: [])
        }))
  }

  public func post(_ notification: AgentNotification) async throws {
    let content = UNMutableNotificationContent()
    content.title = notification.title
    if let subtitle = notification.subtitle { content.subtitle = subtitle }
    content.body = notification.body
    content.categoryIdentifier = notification.categoryIdentifier
    if let thread = notification.threadIdentifier { content.threadIdentifier = thread }
    content.userInfo = notification.userInfo
    content.sound = .default
    try await center.add(
      UNNotificationRequest(identifier: notification.id, content: content, trigger: nil))
  }

  public func removeNotifications(withIdentifiers identifiers: [String]) {
    guard !identifiers.isEmpty else { return }
    center.removeDeliveredNotifications(withIdentifiers: identifiers)
    center.removePendingNotificationRequests(withIdentifiers: identifiers)
  }
}

extension SystemNotificationCenter: UNUserNotificationCenterDelegate {
  nonisolated public func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    let request = response.notification.request
    var userInfo: [String: String] = [:]
    for (key, value) in request.content.userInfo {
      if let key = key as? String, let value = value as? String { userInfo[key] = value }
    }
    let parsed = AgentNotificationResponse(
      notificationId: request.identifier, actionIdentifier: response.actionIdentifier,
      userInfo: userInfo)
    await MainActor.run { self.onResponse?(parsed) }
  }

  /// Show banners even while the app is frontmost (the notifier skips threads on screen).
  nonisolated public func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .list, .sound]
  }
}
