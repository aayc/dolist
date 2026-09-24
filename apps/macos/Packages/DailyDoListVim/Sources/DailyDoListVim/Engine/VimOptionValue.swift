/// The value of a vim option (`:set`): JavaScript values keep their type (`:set tw=40` passes the
/// string "40", the API may pass the number 40).
public enum VimOptionValue: Hashable, Sendable, CustomStringConvertible {
  case bool(Bool)
  case number(Double)
  case string(String)

  /// JavaScript's `String(value)`.
  public var description: String {
    switch self {
    case .bool(let b): b ? "true" : "false"
    case .number(let n): JSNumber.format(n)
    case .string(let s): s
    }
  }

  /// JavaScript truthiness.
  var isTruthy: Bool {
    switch self {
    case .bool(let b): b
    case .number(let n): n != 0 && !n.isNaN
    case .string(let s): !s.isEmpty
    }
  }

  var stringValue: String? {
    if case .string(let s) = self { return s }
    return description
  }

  /// `Number(value)` rounded toward zero, nil for NaN.
  var intValue: Int? {
    let n = numberValue
    return n.isNaN || n.isInfinite ? nil : Int(n)
  }

  /// JavaScript's `Number(value)`.
  var numberValue: Double {
    switch self {
    case .bool(let b): return b ? 1 : 0
    case .number(let n): return n
    case .string(let s):
      let trimmed = VimText(s).trim()
      if trimmed.isEmpty { return 0 }
      return Double(trimmed.string) ?? .nan
    }
  }

  public static func from(_ value: Bool) -> VimOptionValue { .bool(value) }
  public static func from(_ value: Int) -> VimOptionValue { .number(Double(value)) }
  public static func from(_ value: String) -> VimOptionValue { .string(value) }
}

extension VimOptionValue: ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral, ExpressibleByStringLiteral {
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(integerLiteral value: Int) { self = .number(Double(value)) }
  public init(stringLiteral value: String) { self = .string(value) }
}

/// A JavaScript object used as a map: `for…in` visits integer-like keys in ascending order, then
/// the other keys in insertion order (vim.js lists registers and marks this way).
struct JSObjectMap<Value> {
  private(set) var storage: [String: Value] = [:]
  private var insertionOrder: [String] = []

  subscript(key: String) -> Value? {
    get { storage[key] }
    set {
      if let newValue {
        if storage[key] == nil { insertionOrder.append(key) }
        storage[key] = newValue
      } else if storage.removeValue(forKey: key) != nil {
        insertionOrder.removeAll { $0 == key }
      }
    }
  }

  /// The keys in JavaScript's enumeration order.
  var keys: [String] {
    let integers = insertionOrder.filter(Self.isArrayIndex).sorted { UInt32($0)! < UInt32($1)! }
    return integers + insertionOrder.filter { !Self.isArrayIndex($0) }
  }

  private static func isArrayIndex(_ key: String) -> Bool {
    guard let value = UInt32(key), value != UInt32.max else { return false }
    return String(value) == key
  }
}
