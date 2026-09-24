import Foundation

/// JavaScript number conversions used by vim.js (`parseInt`, `Number.prototype.toString`,
/// `Math.round`), with JavaScript's double-precision semantics (so `<C-a>` on a 20-digit number
/// loses precision exactly like the web app).
enum JSNumber {
  /// `parseInt(string, radix)`; `radix` 0 means "not given". NaN when nothing parses.
  static func parseInt(_ text: VimText, radix: Int = 0) -> Double {
    let units = text.units
    var i = 0
    while i < units.count && isJSWhitespace(units[i]) { i += 1 }
    var sign = 1.0
    if i < units.count && (units[i] == 0x2D || units[i] == 0x2B) {
      if units[i] == 0x2D { sign = -1 }
      i += 1
    }
    var r = radix
    var stripPrefix = true
    if r != 0 {
      if r < 2 || r > 36 { return .nan }
      if r != 16 { stripPrefix = false }
    } else {
      r = 10
    }
    if stripPrefix, i + 1 < units.count, units[i] == 0x30,
      units[i + 1] == 0x78 || units[i + 1] == 0x58
    {
      i += 2
      r = 16
    }
    // The digits as an exact integer, then rounded once to the nearest double (V8 rounds
    // correctly for radix 10 and the powers of two, the radices vim uses).
    var limbs: [UInt32] = [0]
    var digits = 0
    while i < units.count, let d = digitValue(units[i]), d < r {
      var carry = UInt64(d)
      for k in limbs.indices {
        let v = UInt64(limbs[k]) * UInt64(r) + carry
        limbs[k] = UInt32(truncatingIfNeeded: v)
        carry = v >> 32
      }
      if carry > 0 { limbs.append(UInt32(carry)) }
      digits += 1
      i += 1
    }
    if digits == 0 { return .nan }
    return sign * nearestDouble(limbs)
  }

  /// A little-endian base-2³² integer rounded to the nearest double (ties to even).
  private static func nearestDouble(_ limbs: [UInt32]) -> Double {
    var top = limbs.count - 1
    while top > 0 && limbs[top] == 0 { top -= 1 }
    if top == 0 { return Double(limbs[0]) }
    if top == 1 { return Double(UInt64(limbs[1]) << 32 | UInt64(limbs[0])) }
    let bitLength = top * 32 + (32 - limbs[top].leadingZeroBitCount)
    // The top 64 bits, with the lowest set if any bit below them is (so ties round correctly).
    let shift = bitLength - 64
    var window: UInt64 = 0
    var sticky = false
    for bit in stride(from: bitLength - 1, through: 0, by: -1) {
      let isSet = (limbs[bit / 32] >> UInt32(bit % 32)) & 1 == 1
      if bit >= shift {
        window = window << 1 | (isSet ? 1 : 0)
      } else if isSet {
        sticky = true
        break
      }
    }
    if sticky { window |= 1 }
    return Double(window) * Double(sign: .plus, exponent: shift, significand: 1)
  }

  /// `parseInt` of a Swift string (for key digits and the like).
  static func parseInt(_ text: String, radix: Int = 0) -> Double {
    parseInt(VimText(text), radix: radix)
  }

  private static func digitValue(_ u: UInt16) -> Int? {
    switch u {
    case 0x30...0x39: Int(u - 0x30)
    case 0x61...0x7A: Int(u - 0x61) + 10
    case 0x41...0x5A: Int(u - 0x41) + 10
    default: nil
    }
  }

  /// `Number.prototype.toString(radix)` for the values vim.js formats (integers, NaN, ±Infinity).
  static func toString(_ x: Double, radix: Int = 10) -> VimText {
    VimText(format(x, radix: radix))
  }

  static func format(_ x: Double, radix: Int = 10) -> String {
    if x.isNaN { return "NaN" }
    if x.isInfinite { return x < 0 ? "-Infinity" : "Infinity" }
    if x == 0 { return "0" }
    if radix == 10 { return formatDecimal(x) }
    let negative = x < 0
    let magnitude = abs(x)
    let integer = magnitude.rounded(.towardZero)
    var digits = integerDigits(integer, radix: radix)
    if integer != magnitude {
      digits += "." + fractionDigits(magnitude - integer, radix: radix)
    }
    return negative ? "-" + digits : digits
  }

  /// JavaScript's Number::toString(10): shortest round-trip digits, positional below 1e21.
  private static func formatDecimal(_ x: Double) -> String {
    let negative = x < 0
    let magnitude = abs(x)
    if magnitude < 9_007_199_254_740_992, magnitude == magnitude.rounded(.towardZero) {
      return (negative ? "-" : "") + String(UInt64(magnitude))
    }
    // Decompose Swift's shortest representation ("1.2345e+21", "123.5", "5e-07") into digits and
    // a decimal exponent n such that value = 0.d1d2... × 10^n.
    var text = "\(magnitude)"
    var exponent = 0
    if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
      exponent = Int(text[text.index(after: e)...]) ?? 0
      text = String(text[..<e])
    }
    var digits = ""
    var pointIndex = text.count
    for (offset, ch) in text.enumerated() {
      if ch == "." { pointIndex = offset } else { digits.append(ch) }
    }
    var n = pointIndex + exponent
    while digits.hasPrefix("0") && digits.count > 1 {
      digits.removeFirst()
      n -= 1
    }
    while digits.hasSuffix("0") && digits.count > 1 { digits.removeLast() }
    let k = digits.count
    let sign = negative ? "-" : ""
    if k <= n && n <= 21 { return sign + digits + String(repeating: "0", count: n - k) }
    if 0 < n && n <= 21 {
      let index = digits.index(digits.startIndex, offsetBy: n)
      return sign + digits[..<index] + "." + digits[index...]
    }
    if -6 < n && n <= 0 { return sign + "0." + String(repeating: "0", count: -n) + digits }
    let e = n - 1
    let expText = e >= 0 ? "+\(e)" : "-\(-e)"
    if k == 1 { return sign + digits + "e" + expText }
    return sign + String(digits.first!) + "." + digits.dropFirst() + "e" + expText
  }

  /// Exact digits of a non-negative integral double in `radix`.
  private static func integerDigits(_ value: Double, radix: Int) -> String {
    if value < 18_446_744_073_709_551_616 { return String(UInt64(value), radix: radix) }
    // value = mantissa × 2^exponent exactly; convert with 32-bit limbs.
    let exponent = value.exponent - 52
    var limbs: [UInt32] = []
    var mantissa = UInt64(value.significandBitPattern | (1 << 52))
    while mantissa > 0 {
      limbs.append(UInt32(truncatingIfNeeded: mantissa))
      mantissa >>= 32
    }
    for _ in 0..<Int(exponent) {
      var carry: UInt32 = 0
      for i in limbs.indices {
        let next = limbs[i] >> 31
        limbs[i] = (limbs[i] << 1) | carry
        carry = next
      }
      if carry != 0 { limbs.append(carry) }
    }
    var out: [Character] = []
    let symbols = Array("0123456789abcdefghijklmnopqrstuvwxyz")
    while !limbs.isEmpty {
      var remainder: UInt64 = 0
      for i in stride(from: limbs.count - 1, through: 0, by: -1) {
        let current = (remainder << 32) | UInt64(limbs[i])
        limbs[i] = UInt32(current / UInt64(radix))
        remainder = current % UInt64(radix)
      }
      out.append(symbols[Int(remainder)])
      while let last = limbs.last, last == 0 { limbs.removeLast() }
    }
    return String(out.reversed())
  }

  /// Fraction digits (V8's DoubleToRadixCString, simplified: 52 digits at most).
  private static func fractionDigits(_ fraction: Double, radix: Int) -> String {
    var f = fraction
    var out = ""
    let symbols = Array("0123456789abcdefghijklmnopqrstuvwxyz")
    var delta = 0.5 * (fraction.nextUp - fraction)
    delta = max(Double.leastNonzeroMagnitude, delta)
    repeat {
      f *= Double(radix)
      delta *= Double(radix)
      let digit = Int(f)
      out.append(symbols[digit])
      f -= Double(digit)
    } while f >= delta && out.count < 52
    return out
  }

  /// `Math.round(x)`.
  static func round(_ x: Double) -> Double {
    guard x.isFinite else { return x }
    // x - floor(x) is exact, unlike x + 0.5 (0.49999999999999994 + 0.5 rounds up to 1).
    let floor = x.rounded(.down)
    let result = x - floor >= 0.5 ? floor + 1 : floor
    return result == 0 && x < 0 ? -0.0 : result
  }
}
