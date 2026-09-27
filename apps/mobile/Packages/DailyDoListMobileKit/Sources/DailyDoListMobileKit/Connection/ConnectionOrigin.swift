import Foundation

/// An origin, never an authenticated URL or an arbitrary endpoint path. Pairing and all later
/// requests use this exact authority; no credential is shared with another profile.
public struct ConnectionOrigin: Hashable, Codable, Sendable {
  public let url: URL

  public enum ValidationError: LocalizedError {
    case invalidOrigin
    public var errorDescription: String? {
      "Enter the host’s HTTPS address without a path, username, code, or token."
    }
  }

  public init(_ input: String) throws {
    let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard var parts = URLComponents(string: value),
      parts.scheme?.lowercased() == "https",
      let host = parts.host, !host.isEmpty,
      parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
      parts.path.isEmpty || parts.path == "/",
      parts.port.map({ (1...65535).contains($0) }) ?? true
    else { throw ValidationError.invalidOrigin }
    parts.scheme = "https"
    parts.host = host.lowercased()
    parts.path = ""
    if parts.port == 443 { parts.port = nil }
    guard let url = parts.url else { throw ValidationError.invalidOrigin }
    self.url = url
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    try self.init(container.decode(String.self))
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(url.absoluteString)
  }
}
