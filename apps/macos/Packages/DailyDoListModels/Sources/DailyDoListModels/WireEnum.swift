import Foundation

/// A string enum on the wire that the daemon may extend without an API version bump (statuses,
/// categories, error codes…). Decoding never fails on an unknown value; code compares against the
/// known constants and handles anything else generically.
public protocol WireEnum: RawRepresentable, Codable, Hashable, Sendable, CustomStringConvertible,
  ExpressibleByStringLiteral
where RawValue == String {
  init(rawValue: String)
}

extension WireEnum {
  public init(stringLiteral value: String) { self.init(rawValue: value) }

  public init(from decoder: Decoder) throws {
    self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }

  public var description: String { rawValue }
}
