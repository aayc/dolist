import DailyDoListMobileKit
import DailyDoListModels
import Foundation

public enum PhoneIntegrationError: LocalizedError, Sendable {
  case notConfigured, chooseConnection, unverifiedConnection, invalidRoute, unsupportedHost,
    protectedDataUnavailable
  public var errorDescription: String? {
    switch self {
    case .notConfigured: "Open Do List to finish setting up phone integrations."
    case .chooseConnection: "Choose a connection in Do List before using this shortcut."
    case .unverifiedConnection: "Open Do List and verify this connection before using it."
    case .invalidRoute: "This link does not identify a valid Do List destination."
    case .unsupportedHost: "Update the connected host to use notification catch-up."
    case .protectedDataUnavailable: "Unlock this iPhone to use Do List."
    }
  }
}

public struct PhoneCaptureRequest: Sendable {
  public let id: UUID
  public let text: String
  public let capturedAt: Date
  public let timeZone: TimeZone
  public init(
    id: UUID = UUID(), text: String, capturedAt: Date = Date(), timeZone: TimeZone = .current
  ) {
    self.id = id
    self.text = text
    self.capturedAt = capturedAt
    self.timeZone = timeZone
  }
}

public struct PhoneCaptureResult: Sendable {
  public enum Status: Sendable { case added, waitingForConnection, needsReview }
  public let operationID: UUID
  public let status: Status
  public let localDate: String
  public let watchedByHost: Bool?
  public var spokenStatus: String {
    switch status {
    case .added: "Added to your do list."
    case .waitingForConnection: "Saved on this iPhone, waiting for connection."
    case .needsReview: "Saved on this iPhone. Open Do List to review the capture status."
    }
  }
}

public struct ApprovalCountResult: Sendable {
  public let count: Int
  public let cachedAt: Date?
  public let isCached: Bool
  public var spokenStatus: String {
    if isCached {
      return "The saved Inbox shows \(count) pending approvals. Connect in Do List to refresh it."
    }
    return "You have \(count) pending approvals. Open your Inbox to review them."
  }
}

public struct PhoneNotificationPreferences: Codable, Equatable, Sendable {
  public var enabled: Bool
  public var showPreviews: Bool
  public var backgroundRefresh: Bool
  public var requiresUnlockedStorage: Bool
  public init(
    enabled: Bool = false, showPreviews: Bool = false, backgroundRefresh: Bool = false,
    requiresUnlockedStorage: Bool = false
  ) {
    self.enabled = enabled
    self.showPreviews = showPreviews
    self.backgroundRefresh = backgroundRefresh
    self.requiresUnlockedStorage = requiresUnlockedStorage
  }
}

public struct PhoneVisibleDestination: Sendable {
  public var scope: WorkspaceScope?
  public var threadID: String?
  public var routineID: String?
  public init(scope: WorkspaceScope? = nil, threadID: String? = nil, routineID: String? = nil) {
    self.scope = scope
    self.threadID = threadID
    self.routineID = routineID
  }
}

public struct PhoneNotification: Sendable {
  public enum Kind: String, CaseIterable, Sendable { case approval, routine }
  public let id: String
  public let kind: Kind
  public let title: String
  public let body: String
  public let route: PhoneRoute
}

/// Implementations never provide Approve/Run buttons. A notification only opens a fresh review.
public protocol PhoneNotificationCenter: Sendable {
  func requestAuthorization() async throws -> Bool
  func authorized() async -> Bool
  func existingIdentifiers() async -> Set<String>
  func deliver(_ notification: PhoneNotification) async throws
  func remove(_ identifiers: Set<String>) async
  func setBadge(_ count: Int) async throws
}
