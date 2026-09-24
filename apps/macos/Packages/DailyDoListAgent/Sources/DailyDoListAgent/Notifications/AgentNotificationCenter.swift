import Foundation

/// The slice of `UNUserNotificationCenter` the notifier uses, with plain value types, so tests
/// (and `swift run`, where the real center is unavailable) can substitute their own.
@MainActor
public protocol AgentNotificationCenter: AnyObject {
  /// Asks for permission to show alerts and play sounds; true when granted.
  func requestAuthorization() async -> Bool
  func setCategories(_ categories: [AgentNotificationCategory])
  func post(_ notification: AgentNotification) async throws
  /// Removes delivered and scheduled notifications.
  func removeNotifications(withIdentifiers identifiers: [String])
  /// Called when the user clicks a notification or one of its actions.
  var onResponse: (@MainActor (AgentNotificationResponse) -> Void)? { get set }
}

public struct AgentNotification: Hashable, Sendable {
  public var id: String
  public var title: String
  public var subtitle: String?
  public var body: String
  public var categoryIdentifier: String
  /// Groups notifications (one group per thread).
  public var threadIdentifier: String?
  public var userInfo: [String: String]

  public init(
    id: String, title: String, subtitle: String? = nil, body: String, categoryIdentifier: String,
    threadIdentifier: String? = nil, userInfo: [String: String] = [:]
  ) {
    self.id = id
    self.title = title
    self.subtitle = subtitle
    self.body = body
    self.categoryIdentifier = categoryIdentifier
    self.threadIdentifier = threadIdentifier
    self.userInfo = userInfo
  }
}

public struct AgentNotificationCategory: Hashable, Sendable {
  public var identifier: String
  public var actions: [AgentNotificationAction]

  public init(identifier: String, actions: [AgentNotificationAction]) {
    self.identifier = identifier
    self.actions = actions
  }
}

public struct AgentNotificationAction: Hashable, Sendable {
  public var identifier: String
  public var title: String
  public var isDestructive: Bool
  /// The Mac must be unlocked to run it.
  public var requiresAuthentication: Bool

  public init(
    identifier: String, title: String, isDestructive: Bool = false,
    requiresAuthentication: Bool = false
  ) {
    self.identifier = identifier
    self.title = title
    self.isDestructive = isDestructive
    self.requiresAuthentication = requiresAuthentication
  }
}

public struct AgentNotificationResponse: Hashable, Sendable {
  /// The user clicked the notification itself.
  public static let defaultAction = "com.apple.UNNotificationDefaultActionIdentifier"
  /// The user dismissed it.
  public static let dismissAction = "com.apple.UNNotificationDismissActionIdentifier"

  public var notificationId: String
  public var actionIdentifier: String
  public var userInfo: [String: String]

  public init(notificationId: String, actionIdentifier: String, userInfo: [String: String]) {
    self.notificationId = notificationId
    self.actionIdentifier = actionIdentifier
    self.userInfo = userInfo
  }
}
