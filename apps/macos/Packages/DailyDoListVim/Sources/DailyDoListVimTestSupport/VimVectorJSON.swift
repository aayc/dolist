import DailyDoListVim

/// A parsed JSON value whose strings keep their UTF-16 code units: the vectors contain lone
/// surrogates (vim splits emoji), which `JSONSerialization` and Swift strings can't represent.
public enum VimVectorJSON: Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string(VimText)
  case array([VimVectorJSON])
  /// Members in file order (JavaScript's property order, which the vectors rely on).
  case object([(key: String, value: VimVectorJSON)])

  public subscript(key: String) -> VimVectorJSON? {
    guard case .object(let members) = self else { return nil }
    return members.first { $0.key == key }?.value
  }

  public var text: VimText? {
    if case .string(let value) = self { return value }
    return nil
  }

  public var number: Double? {
    if case .number(let value) = self { return value }
    return nil
  }

  public var int: Int? { number.map { Int($0) } }

  public var bool: Bool? {
    if case .bool(let value) = self { return value }
    return nil
  }

  public var array: [VimVectorJSON]? {
    if case .array(let value) = self { return value }
    return nil
  }

  public var members: [(key: String, value: VimVectorJSON)]? {
    if case .object(let value) = self { return value }
    return nil
  }
}

public struct VimVectorJSONError: Error, CustomStringConvertible {
  public let offset: Int
  public let reason: String
  public var description: String { "JSON error at byte \(offset): \(reason)" }
}

extension VimVectorJSON {
  /// Parses strict JSON (RFC 8259) from UTF-8 bytes.
  public static func parse(_ bytes: some Collection<UInt8>) throws(VimVectorJSONError) -> VimVectorJSON {
    var parser = Parser(bytes: Array(bytes))
    parser.skipWhitespace()
    let value = try parser.parseValue()
    parser.skipWhitespace()
    guard parser.index == parser.bytes.count else { throw parser.error("trailing characters") }
    return value
  }
}

private struct Parser {
  let bytes: [UInt8]
  var index = 0

  init(bytes: [UInt8]) {
    self.bytes = bytes
  }

  func error(_ reason: String) -> VimVectorJSONError {
    VimVectorJSONError(offset: index, reason: reason)
  }

  mutating func skipWhitespace() {
    while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[index]) { index += 1 }
  }

  private mutating func expect(_ literal: String) throws(VimVectorJSONError) {
    for byte in literal.utf8 {
      guard index < bytes.count, bytes[index] == byte else { throw error("expected \(literal)") }
      index += 1
    }
  }

  mutating func parseValue() throws(VimVectorJSONError) -> VimVectorJSON {
    guard index < bytes.count else { throw error("unexpected end") }
    switch bytes[index] {
    case UInt8(ascii: "{"): return try parseObject()
    case UInt8(ascii: "["): return try parseArray()
    case UInt8(ascii: "\""): return .string(try parseString())
    case UInt8(ascii: "t"):
      try expect("true")
      return .bool(true)
    case UInt8(ascii: "f"):
      try expect("false")
      return .bool(false)
    case UInt8(ascii: "n"):
      try expect("null")
      return .null
    default: return .number(try parseNumber())
    }
  }

  private mutating func parseObject() throws(VimVectorJSONError) -> VimVectorJSON {
    index += 1
    var members: [(key: String, value: VimVectorJSON)] = []
    skipWhitespace()
    if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
      index += 1
      return .object(members)
    }
    while true {
      skipWhitespace()
      guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else { throw error("expected a key") }
      let key = try parseString().string
      skipWhitespace()
      try expect(":")
      skipWhitespace()
      members.append((key, try parseValue()))
      skipWhitespace()
      guard index < bytes.count else { throw error("unterminated object") }
      if bytes[index] == UInt8(ascii: ",") {
        index += 1
        continue
      }
      try expect("}")
      return .object(members)
    }
  }

  private mutating func parseArray() throws(VimVectorJSONError) -> VimVectorJSON {
    index += 1
    var elements: [VimVectorJSON] = []
    skipWhitespace()
    if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
      index += 1
      return .array(elements)
    }
    while true {
      skipWhitespace()
      elements.append(try parseValue())
      skipWhitespace()
      guard index < bytes.count else { throw error("unterminated array") }
      if bytes[index] == UInt8(ascii: ",") {
        index += 1
        continue
      }
      try expect("]")
      return .array(elements)
    }
  }

  private mutating func parseHex4() throws(VimVectorJSONError) -> UInt16 {
    guard index + 4 <= bytes.count else { throw error("short \\u escape") }
    var value: UInt16 = 0
    for _ in 0..<4 {
      let byte = bytes[index]
      let digit: UInt16
      switch byte {
      case 0x30...0x39: digit = UInt16(byte - 0x30)
      case 0x41...0x46: digit = UInt16(byte - 0x41 + 10)
      case 0x61...0x66: digit = UInt16(byte - 0x61 + 10)
      default: throw error("bad \\u escape")
      }
      value = value << 4 | digit
      index += 1
    }
    return value
  }

  private mutating func parseString() throws(VimVectorJSONError) -> VimText {
    index += 1
    var units: [UInt16] = []
    while true {
      guard index < bytes.count else { throw error("unterminated string") }
      let byte = bytes[index]
      if byte == UInt8(ascii: "\"") {
        index += 1
        return VimText(units: units)
      }
      if byte == UInt8(ascii: "\\") {
        index += 1
        guard index < bytes.count else { throw error("unterminated escape") }
        let escape = bytes[index]
        index += 1
        switch escape {
        case UInt8(ascii: "\""): units.append(0x22)
        case UInt8(ascii: "\\"): units.append(0x5C)
        case UInt8(ascii: "/"): units.append(0x2F)
        case UInt8(ascii: "b"): units.append(0x08)
        case UInt8(ascii: "f"): units.append(0x0C)
        case UInt8(ascii: "n"): units.append(0x0A)
        case UInt8(ascii: "r"): units.append(0x0D)
        case UInt8(ascii: "t"): units.append(0x09)
        case UInt8(ascii: "u"): units.append(try parseHex4())
        default: throw error("bad escape")
        }
        continue
      }
      guard byte >= 0x20 else { throw error("control character in string") }
      // One UTF-8 sequence.
      var scalar: UInt32
      var extra: Int
      switch byte {
      case 0x00..<0x80: scalar = UInt32(byte); extra = 0
      case 0xC0..<0xE0: scalar = UInt32(byte & 0x1F); extra = 1
      case 0xE0..<0xF0: scalar = UInt32(byte & 0x0F); extra = 2
      case 0xF0..<0xF8: scalar = UInt32(byte & 0x07); extra = 3
      default: throw error("invalid UTF-8")
      }
      index += 1
      for _ in 0..<extra {
        guard index < bytes.count, bytes[index] & 0xC0 == 0x80 else { throw error("invalid UTF-8") }
        scalar = scalar << 6 | UInt32(bytes[index] & 0x3F)
        index += 1
      }
      if scalar >= 0x10000 {
        let v = scalar - 0x10000
        units.append(UInt16(0xD800 + (v >> 10)))
        units.append(UInt16(0xDC00 + (v & 0x3FF)))
      } else {
        units.append(UInt16(scalar))
      }
    }
  }

  private mutating func parseNumber() throws(VimVectorJSONError) -> Double {
    let start = index
    while index < bytes.count, "+-0123456789.eE".utf8.contains(bytes[index]) { index += 1 }
    guard index > start, let value = Double(String(decoding: bytes[start..<index], as: UTF8.self)) else {
      throw error("bad number")
    }
    return value
  }
}
