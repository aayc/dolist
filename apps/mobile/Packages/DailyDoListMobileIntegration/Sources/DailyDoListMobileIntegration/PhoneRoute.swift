import DailyDoListMobileKit
import Foundation

/// Opaque routing only: never a bearer credential, note body, approval decision or remote URL.
public struct PhoneRoute: Codable, Hashable, Sendable {
  public enum Destination: Codable, Hashable, Sendable {
    case today, inbox
    case thread(String, approvalID: String?)
  }
  public let scope: WorkspaceScope
  public let destination: Destination
  public init(scope: WorkspaceScope, destination: Destination) {
    self.scope = scope
    self.destination = destination
  }

  public func url(scheme: String = "dolist") throws -> URL {
    var parts = URLComponents()
    parts.scheme = scheme
    parts.host = "open"
    switch destination {
    case .today: parts.path = "/today"
    case .inbox: parts.path = "/inbox"
    case .thread(let id, _):
      guard Self.validID(id) else { throw PhoneIntegrationError.invalidRoute }
      parts.path = "/thread/" + id
    }
    parts.queryItems = [
      URLQueryItem(name: "profile", value: scope.profileID.uuidString),
      URLQueryItem(name: "workspace", value: scope.workspaceID),
      URLQueryItem(name: "host", value: scope.hostID),
    ]
    if case .thread(_, let approval) = destination, let approval {
      guard Self.validID(approval) else { throw PhoneIntegrationError.invalidRoute }
      parts.queryItems?.append(URLQueryItem(name: "approval", value: approval))
    }
    guard let url = parts.url else { throw PhoneIntegrationError.invalidRoute }
    return url
  }

  public static func parse(_ url: URL, profiles: [ConnectionProfile], scheme: String = "dolist")
    throws -> PhoneRoute
  {
    guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
      parts.scheme?.lowercased() == scheme.lowercased(), parts.host == "open",
      parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
      let items = parts.queryItems, Set(items.map(\.name)).count == items.count,
      items.allSatisfy({ ["profile", "workspace", "host", "approval"].contains($0.name) })
    else { throw PhoneIntegrationError.invalidRoute }
    let fields = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
    guard let id = fields["profile"].flatMap(UUID.init(uuidString:)),
      let profile = profiles.first(where: { $0.id == id }),
      let workspace = profile.workspaceID, let host = profile.hostID,
      fields["workspace"] == workspace, fields["host"] == host
    else { throw PhoneIntegrationError.invalidRoute }
    let destination: Destination
    switch parts.path {
    case "/today": destination = .today
    case "/inbox": destination = .inbox
    default:
      let segments = parts.path.split(separator: "/", omittingEmptySubsequences: false)
      guard segments.count == 3, segments[0].isEmpty, segments[1] == "thread",
        Self.validID(String(segments[2])),
        fields["approval"].map(Self.validID) ?? true
      else { throw PhoneIntegrationError.invalidRoute }
      destination = .thread(String(segments[2]), approvalID: fields["approval"])
    }
    if fields["approval"] != nil, case .thread = destination {
    } else if fields["approval"] != nil {
      throw PhoneIntegrationError.invalidRoute
    }
    return PhoneRoute(
      scope: WorkspaceScope(
        profileID: id, workspaceID: workspace, hostID: host, origin: profile.origin),
      destination: destination)
  }

  static func validID(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 128
      && value.utf8.allSatisfy {
        (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
          || [45, 46, 58, 95].contains($0)
      }
  }
}
