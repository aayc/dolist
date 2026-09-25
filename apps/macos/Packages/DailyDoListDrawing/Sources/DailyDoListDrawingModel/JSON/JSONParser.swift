import Foundation

/// Why a JSON text couldn't be read, with the UTF-8 byte offset where it went wrong.
public struct JSONParseError: Error, Equatable, CustomStringConvertible {
  public var message: String
  public var offset: Int

  public var description: String { "\(message) at byte \(offset)" }
}

/// A strict JSON parser (RFC 8259) that keeps object keys in order. A repeated key keeps its first
/// position and its last value, like `JSON.parse`. Lone surrogates become U+FFFD.
public enum JSONParser {
  public static func parse(_ text: String) throws -> JSONValue {
    var text = text
    return try text.withUTF8 { try parse(bytes: $0) }
  }

  public static func parse(_ data: Data) throws -> JSONValue {
    try data.withUnsafeBytes { raw in
      try parse(
        bytes: UnsafeBufferPointer(
          start: raw.bindMemory(to: UInt8.self).baseAddress, count: raw.count))
    }
  }

  static func parse(bytes: UnsafeBufferPointer<UInt8>) throws -> JSONValue {
    var reader = Reader(bytes: bytes)
    reader.skipWhitespace()
    let value = try reader.value(depth: 0)
    reader.skipWhitespace()
    guard reader.atEnd else { throw reader.error("unexpected text after the JSON value") }
    return value
  }

  private struct Reader {
    let bytes: UnsafeBufferPointer<UInt8>
    var position = 0

    static let maxDepth = 512

    var atEnd: Bool { position >= bytes.count }

    func error(_ message: String) -> JSONParseError {
      JSONParseError(message: message, offset: position)
    }

    func peek() -> UInt8? { position < bytes.count ? bytes[position] : nil }

    mutating func skipWhitespace() {
      while position < bytes.count {
        switch bytes[position] {
        case 0x20, 0x0A, 0x0D, 0x09: position += 1
        default: return
        }
      }
    }

    mutating func expect(_ literal: StaticString) throws {
      let count = literal.utf8CodeUnitCount
      guard position + count <= bytes.count else { throw error("unexpected end of input") }
      let expected = UnsafeBufferPointer(start: literal.utf8Start, count: count)
      for index in 0..<count where bytes[position + index] != expected[index] {
        throw error("invalid literal")
      }
      position += count
    }

    mutating func value(depth: Int) throws -> JSONValue {
      guard depth < Self.maxDepth else { throw error("nested too deeply") }
      guard let byte = peek() else { throw error("unexpected end of input") }
      switch byte {
      case UInt8(ascii: "{"): return .object(try object(depth: depth))
      case UInt8(ascii: "["): return .array(try array(depth: depth))
      case UInt8(ascii: "\""): return .string(try string())
      case UInt8(ascii: "t"):
        try expect("true")
        return .bool(true)
      case UInt8(ascii: "f"):
        try expect("false")
        return .bool(false)
      case UInt8(ascii: "n"):
        try expect("null")
        return .null
      case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"):
        return .number(try number())
      default:
        throw error("unexpected character")
      }
    }

    mutating func object(depth: Int) throws -> JSONObject {
      position += 1
      var result = JSONObject()
      skipWhitespace()
      if peek() == UInt8(ascii: "}") {
        position += 1
        return result
      }
      while true {
        skipWhitespace()
        guard peek() == UInt8(ascii: "\"") else { throw error("expected a key") }
        let key = try string()
        skipWhitespace()
        guard peek() == UInt8(ascii: ":") else { throw error("expected ':'") }
        position += 1
        skipWhitespace()
        result[key] = try value(depth: depth + 1)
        skipWhitespace()
        switch peek() {
        case UInt8(ascii: ","): position += 1
        case UInt8(ascii: "}"):
          position += 1
          return result
        default: throw error("expected ',' or '}'")
        }
      }
    }

    mutating func array(depth: Int) throws -> [JSONValue] {
      position += 1
      var result: [JSONValue] = []
      skipWhitespace()
      if peek() == UInt8(ascii: "]") {
        position += 1
        return result
      }
      while true {
        skipWhitespace()
        result.append(try value(depth: depth + 1))
        skipWhitespace()
        switch peek() {
        case UInt8(ascii: ","): position += 1
        case UInt8(ascii: "]"):
          position += 1
          return result
        default: throw error("expected ',' or ']'")
        }
      }
    }

    mutating func number() throws -> Double {
      let start = position
      if peek() == UInt8(ascii: "-") { position += 1 }
      guard let first = peek(), (0x30...0x39).contains(first) else { throw error("invalid number") }
      if first == 0x30 {
        position += 1
      } else {
        while let digit = peek(), (0x30...0x39).contains(digit) { position += 1 }
      }
      if peek() == UInt8(ascii: ".") {
        position += 1
        guard let digit = peek(), (0x30...0x39).contains(digit) else {
          throw error("invalid number")
        }
        while let digit = peek(), (0x30...0x39).contains(digit) { position += 1 }
      }
      if let e = peek(), e == UInt8(ascii: "e") || e == UInt8(ascii: "E") {
        position += 1
        if let sign = peek(), sign == UInt8(ascii: "+") || sign == UInt8(ascii: "-") {
          position += 1
        }
        guard let digit = peek(), (0x30...0x39).contains(digit) else {
          throw error("invalid number")
        }
        while let digit = peek(), (0x30...0x39).contains(digit) { position += 1 }
      }
      let literal = String(
        decoding: UnsafeBufferPointer(rebasing: bytes[start..<position]), as: UTF8.self)
      guard let value = Double(literal) else { throw error("invalid number") }
      return value
    }

    mutating func string() throws -> String {
      position += 1
      let start = position
      // Fast path: no escapes.
      while position < bytes.count {
        let byte = bytes[position]
        if byte == UInt8(ascii: "\"") {
          let slice = UnsafeBufferPointer(rebasing: bytes[start..<position])
          position += 1
          return String(decoding: slice, as: UTF8.self)
        }
        if byte == UInt8(ascii: "\\") || byte < 0x20 { break }
        position += 1
      }
      var scalars = String.UnicodeScalarView()
      var buffer: [UInt8] = Array(UnsafeBufferPointer(rebasing: bytes[start..<position]))
      func flush() {
        if !buffer.isEmpty {
          scalars.append(contentsOf: String(decoding: buffer, as: UTF8.self).unicodeScalars)
          buffer.removeAll(keepingCapacity: true)
        }
      }
      while true {
        guard position < bytes.count else { throw error("unterminated string") }
        let byte = bytes[position]
        if byte == UInt8(ascii: "\"") {
          position += 1
          flush()
          return String(scalars)
        }
        if byte < 0x20 { throw error("control character in a string") }
        if byte != UInt8(ascii: "\\") {
          buffer.append(byte)
          position += 1
          continue
        }
        flush()
        position += 1
        guard let escape = peek() else { throw error("unterminated string") }
        position += 1
        switch escape {
        case UInt8(ascii: "\""): scalars.append("\"")
        case UInt8(ascii: "\\"): scalars.append("\\")
        case UInt8(ascii: "/"): scalars.append("/")
        case UInt8(ascii: "b"): scalars.append("\u{08}")
        case UInt8(ascii: "f"): scalars.append("\u{0C}")
        case UInt8(ascii: "n"): scalars.append("\n")
        case UInt8(ascii: "r"): scalars.append("\r")
        case UInt8(ascii: "t"): scalars.append("\t")
        case UInt8(ascii: "u"):
          let unit = try hex4()
          if (0xD800...0xDBFF).contains(unit), peek() == UInt8(ascii: "\\"),
            position + 1 < bytes.count, bytes[position + 1] == UInt8(ascii: "u")
          {
            let saved = position
            position += 2
            let low = try hex4()
            if (0xDC00...0xDFFF).contains(low) {
              let scalar = 0x10000 + ((UInt32(unit) - 0xD800) << 10) + (UInt32(low) - 0xDC00)
              scalars.append(Unicode.Scalar(scalar) ?? "\u{FFFD}")
            } else {
              scalars.append("\u{FFFD}")
              position = saved
            }
          } else {
            scalars.append(Unicode.Scalar(UInt32(unit)) ?? "\u{FFFD}")
          }
        default:
          throw error("invalid escape")
        }
      }
    }

    mutating func hex4() throws -> UInt16 {
      guard position + 4 <= bytes.count else { throw error("invalid \\u escape") }
      var value: UInt16 = 0
      for _ in 0..<4 {
        let byte = bytes[position]
        let digit: UInt8
        switch byte {
        case 0x30...0x39: digit = byte - 0x30
        case 0x41...0x46: digit = byte - 0x41 + 10
        case 0x61...0x66: digit = byte - 0x61 + 10
        default: throw error("invalid \\u escape")
        }
        value = value << 4 | UInt16(digit)
        position += 1
      }
      return value
    }
  }
}
