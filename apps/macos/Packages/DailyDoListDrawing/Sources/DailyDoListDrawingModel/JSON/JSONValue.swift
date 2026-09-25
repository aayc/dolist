import Foundation

/// A JSON value whose objects keep their keys in order, so a scene written back keeps its fields
/// (including the ones this engine doesn't know) where they were.
public enum JSONValue: Hashable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object(JSONObject)

  public var stringValue: String? {
    if case .string(let value) = self { return value }
    return nil
  }

  public var numberValue: Double? {
    if case .number(let value) = self { return value }
    return nil
  }

  public var boolValue: Bool? {
    if case .bool(let value) = self { return value }
    return nil
  }

  public var arrayValue: [JSONValue]? {
    if case .array(let value) = self { return value }
    return nil
  }

  public var objectValue: JSONObject? {
    if case .object(let value) = self { return value }
    return nil
  }

  public var isNull: Bool { self == .null }
}

/// A JSON object: key–value pairs in insertion order. Setting an existing key keeps its position;
/// a new key goes last; setting nil removes it.
public struct JSONObject: Hashable, Sendable, Sequence {
  public private(set) var keys: [String] = []
  private var values: [String: JSONValue] = [:]

  public init() {}

  public init(_ pairs: [(String, JSONValue)]) {
    for (key, value) in pairs { self[key] = value }
  }

  public var count: Int { keys.count }
  public var isEmpty: Bool { keys.isEmpty }

  public subscript(key: String) -> JSONValue? {
    get { values[key] }
    set {
      if let newValue {
        if values.updateValue(newValue, forKey: key) == nil { keys.append(key) }
      } else if values.removeValue(forKey: key) != nil {
        keys.removeAll { $0 == key }
      }
    }
  }

  public func contains(_ key: String) -> Bool { values[key] != nil }

  public func makeIterator() -> AnyIterator<(key: String, value: JSONValue)> {
    var index = 0
    return AnyIterator {
      guard index < keys.count else { return nil }
      defer { index += 1 }
      let key = keys[index]
      return (key, values[key] ?? .null)
    }
  }

  public static func == (lhs: JSONObject, rhs: JSONObject) -> Bool {
    lhs.keys == rhs.keys && lhs.values == rhs.values
  }

  public func hash(into hasher: inout Hasher) {
    hasher.combine(keys)
    for key in keys { hasher.combine(values[key]) }
  }
}
