import Foundation

/// Writes JSON the way `JSON.stringify(value, null, indent)` does, numbers included, so a scene
/// saved here reads byte for byte like one Excalidraw or the Obsidian plugin saved.
public enum JSONWriter {
  /// - Parameter indent: `"\t"` (the Obsidian plugin), `"  "`, or `""` for compact output.
  public static func string(_ value: JSONValue, indent: String = "\t") -> String {
    var output = ""
    output.reserveCapacity(4096)
    write(value, indent: indent, level: 0, into: &output)
    return output
  }

  static func write(_ value: JSONValue, indent: String, level: Int, into output: inout String) {
    switch value {
    case .null: output += "null"
    case .bool(let flag): output += flag ? "true" : "false"
    case .number(let number): output += JSNumberFormat.string(number)
    case .string(let text): writeString(text, into: &output)
    case .array(let items):
      guard !items.isEmpty else {
        output += "[]"
        return
      }
      output += "["
      for (index, item) in items.enumerated() {
        if index > 0 { output += "," }
        newline(indent: indent, level: level + 1, into: &output)
        write(item, indent: indent, level: level + 1, into: &output)
      }
      newline(indent: indent, level: level, into: &output)
      output += "]"
    case .object(let object):
      guard !object.isEmpty else {
        output += "{}"
        return
      }
      output += "{"
      var first = true
      for (key, item) in object {
        if !first { output += "," }
        first = false
        newline(indent: indent, level: level + 1, into: &output)
        writeString(key, into: &output)
        output += indent.isEmpty ? ":" : ": "
        write(item, indent: indent, level: level + 1, into: &output)
      }
      newline(indent: indent, level: level, into: &output)
      output += "}"
    }
  }

  private static func newline(indent: String, level: Int, into output: inout String) {
    guard !indent.isEmpty else { return }
    output += "\n"
    for _ in 0..<level { output += indent }
  }

  private static let hexDigits = Array("0123456789abcdef".unicodeScalars)

  static func writeString(_ text: String, into output: inout String) {
    output += "\""
    var needsEscape = false
    for byte in text.utf8
    where byte < 0x20 || byte == UInt8(ascii: "\"") || byte == UInt8(ascii: "\\") {
      needsEscape = true
      break
    }
    guard needsEscape else {
      output += text
      output += "\""
      return
    }
    var scalars = String.UnicodeScalarView()
    for scalar in text.unicodeScalars {
      switch scalar {
      case "\"": scalars.append(contentsOf: "\\\"".unicodeScalars)
      case "\\": scalars.append(contentsOf: "\\\\".unicodeScalars)
      case "\u{08}": scalars.append(contentsOf: "\\b".unicodeScalars)
      case "\u{0C}": scalars.append(contentsOf: "\\f".unicodeScalars)
      case "\n": scalars.append(contentsOf: "\\n".unicodeScalars)
      case "\r": scalars.append(contentsOf: "\\r".unicodeScalars)
      case "\t": scalars.append(contentsOf: "\\t".unicodeScalars)
      default:
        if scalar.value < 0x20 {
          scalars.append(contentsOf: "\\u00".unicodeScalars)
          scalars.append(hexDigits[Int(scalar.value >> 4)])
          scalars.append(hexDigits[Int(scalar.value & 0xF)])
        } else {
          scalars.append(scalar)
        }
      }
    }
    output += String(scalars)
    output += "\""
  }
}

/// `Number.prototype.toString()`: the shortest digits that round-trip, as an integer or a decimal
/// between 1e-7 and 1e21, else in exponent form (`1e-7`, `1.5e+21`).
public enum JSNumberFormat {
  public static func string(_ value: Double) -> String {
    guard value.isFinite else { return "null" }
    if value == 0 { return "0" }
    if value == value.rounded(), abs(value) < 1e15 {
      return String(Int64(value))
    }
    let negative = value < 0
    let (digits, exponent) = shortestDigits(abs(value))
    // value = 0.d1d2…dk × 10^exponent, i.e. the ECMAScript n is `exponent`.
    let k = digits.count
    let n = exponent
    var result = negative ? "-" : ""
    if k <= n && n <= 21 {
      result += digits + String(repeating: "0", count: n - k)
    } else if 0 < n && n <= 21 {
      let index = digits.index(digits.startIndex, offsetBy: n)
      result += digits[..<index] + "." + digits[index...]
    } else if -6 < n && n <= 0 {
      result += "0." + String(repeating: "0", count: -n) + digits
    } else {
      let e = n - 1
      let sign = e < 0 ? "-" : "+"
      if k == 1 {
        result += digits + "e" + sign + String(abs(e))
      } else {
        result += String(digits.first!) + "." + digits.dropFirst() + "e" + sign + String(abs(e))
      }
    }
    return result
  }

  /// The shortest round-trip decimal digits of a positive finite value (from Swift's own
  /// shortest representation) and n, where the value is 0.digits × 10^n.
  static func shortestDigits(_ value: Double) -> (String, Int) {
    let text = value.description  // "123.45", "1e-07", "1.2345e+22", "5.0"
    var mantissa = Substring(text)
    var exponent = 0
    if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
      mantissa = text[..<e]
      exponent = Int(text[text.index(after: e)...]) ?? 0
    }
    var digits = ""
    var pointPosition = mantissa.count
    for (offset, character) in mantissa.enumerated() {
      if character == "." {
        pointPosition = offset
      } else {
        digits.append(character)
      }
    }
    // value = digits × 10^(pointPosition - digits.count + exponent) as an integer string.
    var n = pointPosition + exponent
    while digits.hasPrefix("0") && digits.count > 1 {
      digits.removeFirst()
      n -= 1
    }
    while digits.hasSuffix("0") && digits.count > 1 { digits.removeLast() }
    return (digits, n)
  }
}
