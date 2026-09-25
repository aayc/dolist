import Foundation

/// A JSON value, as read from a request line and written into a response line.
public enum JSONValue: Sendable, Equatable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object(JSONObject)

  /// Parses one JSON document. Booleans and numbers stay distinct (`true` is never `1`).
  public static func parse(_ text: String) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
  }

  /// Compact JSON on one line: control characters and U+2028/U+2029 are escaped, so the result
  /// never contains a line break.
  public var serialized: String {
    var out = ""
    write(to: &out)
    return out
  }

  private func write(to out: inout String) {
    switch self {
    case .null: out += "null"
    case .bool(let value): out += value ? "true" : "false"
    case .number(let value): out += Self.format(value)
    case .string(let value): Self.writeString(value, to: &out)
    case .array(let values):
      out += "["
      for (index, value) in values.enumerated() {
        if index > 0 { out += "," }
        value.write(to: &out)
      }
      out += "]"
    case .object(let object):
      out += "{"
      for (index, key) in object.keys.enumerated() {
        if index > 0 { out += "," }
        Self.writeString(key, to: &out)
        out += ":"
        (object[key] ?? .null).write(to: &out)
      }
      out += "}"
    }
  }

  /// Integers print without a fraction (`12`, not `12.0`); non-finite numbers aren't JSON, so
  /// they print as `null`.
  static func format(_ number: Double) -> String {
    guard number.isFinite else { return "null" }
    if number == number.rounded(), abs(number) < 1e15 { return String(Int64(number)) }
    return "\(number)"
  }

  private static func writeString(_ string: String, to out: inout String) {
    out += "\""
    for scalar in string.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if scalar.value < 0x20 || scalar.value == 0x2028 || scalar.value == 0x2029 {
          out += String(format: "\\u%04x", scalar.value)
        } else {
          out.unicodeScalars.append(scalar)
        }
      }
    }
    out += "\""
  }
}

extension JSONValue: Decodable {
  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      let members = try container.decode([String: JSONValue].self)
      self = .object(JSONObject(members.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }))
    }
  }
}

extension JSONValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral,
  ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByStringLiteral,
  ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral
{
  public init(nilLiteral: ()) { self = .null }
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(integerLiteral value: Int) { self = .number(Double(value)) }
  public init(floatLiteral value: Double) { self = .number(value) }
  public init(stringLiteral value: String) { self = .string(value) }
  public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
  public init(dictionaryLiteral elements: (String, JSONValue)...) {
    self = .object(JSONObject(elements))
  }
}

extension JSONValue {
  /// `.string`, or `.null` for nil.
  static func string(_ value: String?) -> JSONValue { value.map { .string($0) } ?? .null }

  var objectValue: JSONObject? {
    if case .object(let object) = self { return object }
    return nil
  }
}

/// A JSON object that keeps its keys in insertion order, so responses read the way they're built
/// (`id` first). Equality ignores the order.
public struct JSONObject: Sendable, Equatable {
  public private(set) var keys: [String] = []
  private var values: [String: JSONValue] = [:]

  public init() {}

  public init(_ members: [(String, JSONValue)]) {
    for (key, value) in members { self[key] = value }
  }

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

  public var isEmpty: Bool { keys.isEmpty }

  public static func == (lhs: JSONObject, rhs: JSONObject) -> Bool { lhs.values == rhs.values }
}

extension JSONObject: ExpressibleByDictionaryLiteral {
  public init(dictionaryLiteral elements: (String, JSONValue)...) { self.init(elements) }
}
