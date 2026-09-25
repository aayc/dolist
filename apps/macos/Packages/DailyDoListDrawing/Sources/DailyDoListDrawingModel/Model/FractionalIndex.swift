import Foundation

/// Fractional indices (the `index` field): base-62 order keys between two neighbors, a port of
/// rocicorp/fractional-indexing 3.2.0 (CC0), which Excalidraw uses to order elements in merges.
public enum FractionalIndex {
  static let digits = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".utf8)
  static let zero = digits[0]

  /// A key sorting after `a` and before `b` (either may be nil: the start or the end); nil when
  /// the neighbors aren't valid keys or aren't in order.
  public static func key(between a: String?, and b: String?) -> String? {
    let aBytes = a.map { Array($0.utf8) }
    let bBytes = b.map { Array($0.utf8) }
    guard let result = try? generateKeyBetween(aBytes, bBytes) else { return nil }
    return String(decoding: result, as: UTF8.self)
  }

  /// Whether a string is a valid order key.
  public static func isValid(_ key: String) -> Bool {
    (try? validateOrderKey(Array(key.utf8))) != nil
  }

  struct InvalidKey: Error {}

  private static func index(of digit: UInt8) -> Int? { digits.firstIndex(of: digit) }

  private static func lessThan(_ a: [UInt8], _ b: [UInt8]) -> Bool {
    a.lexicographicallyPrecedes(b)
  }

  static func midpoint(_ a: [UInt8], _ b: [UInt8]?) throws -> [UInt8] {
    if let b, !lessThan(a, b) { throw InvalidKey() }
    if a.last == zero || b?.last == zero { throw InvalidKey() }
    if let b {
      var n = 0
      while (n < a.count ? a[n] : zero) == (n < b.count ? b[n] : nil) { n += 1 }
      if n > 0 {
        return Array(b[..<n]) + (try midpoint(Array(a.dropFirst(n)), Array(b.dropFirst(n))))
      }
    }
    let digitA = a.isEmpty ? 0 : (index(of: a[0]) ?? 0)
    let digitB =
      b.map { $0.isEmpty ? digits.count : (index(of: $0[0]) ?? digits.count) } ?? digits.count
    if digitB - digitA > 1 {
      // Math.round(0.5 * (a + b)) rounds halves up.
      return [digits[(digitA + digitB + 1) / 2]]
    }
    if let b, b.count > 1 { return [b[0]] }
    return [digits[digitA]] + (try midpoint(Array(a.dropFirst()), nil))
  }

  static func integerLength(_ head: UInt8) throws -> Int {
    if head >= UInt8(ascii: "a") && head <= UInt8(ascii: "z") {
      return Int(head - UInt8(ascii: "a")) + 2
    }
    if head >= UInt8(ascii: "A") && head <= UInt8(ascii: "Z") {
      return Int(UInt8(ascii: "Z") - head) + 2
    }
    throw InvalidKey()
  }

  static func integerPart(_ key: [UInt8]) throws -> [UInt8] {
    guard let head = key.first else { throw InvalidKey() }
    let length = try integerLength(head)
    guard length <= key.count else { throw InvalidKey() }
    return Array(key[..<length])
  }

  static func validateOrderKey(_ key: [UInt8]) throws {
    if key == [UInt8(ascii: "A")] + Array(repeating: zero, count: 26) { throw InvalidKey() }
    let integer = try integerPart(key)
    if key.count > integer.count, key.last == zero { throw InvalidKey() }
    for byte in key.dropFirst() where index(of: byte) == nil { throw InvalidKey() }
  }

  static func incrementInteger(_ x: [UInt8]) throws -> [UInt8]? {
    guard x.count == (try integerLength(x[0])) else { throw InvalidKey() }
    let head = x[0]
    var digs = Array(x.dropFirst())
    var carry = true
    var i = digs.count - 1
    while carry && i >= 0 {
      let d = (index(of: digs[i]) ?? 0) + 1
      if d == digits.count {
        digs[i] = zero
      } else {
        digs[i] = digits[d]
        carry = false
      }
      i -= 1
    }
    guard carry else { return [head] + digs }
    if head == UInt8(ascii: "Z") { return [UInt8(ascii: "a"), zero] }
    if head == UInt8(ascii: "z") { return nil }
    let h = head + 1
    if h > UInt8(ascii: "a") { digs.append(zero) } else { digs.removeLast() }
    return [h] + digs
  }

  static func decrementInteger(_ x: [UInt8]) throws -> [UInt8]? {
    guard x.count == (try integerLength(x[0])) else { throw InvalidKey() }
    let head = x[0]
    var digs = Array(x.dropFirst())
    var borrow = true
    var i = digs.count - 1
    while borrow && i >= 0 {
      let d = (index(of: digs[i]) ?? 0) - 1
      if d == -1 {
        digs[i] = digits[digits.count - 1]
      } else {
        digs[i] = digits[d]
        borrow = false
      }
      i -= 1
    }
    guard borrow else { return [head] + digs }
    if head == UInt8(ascii: "a") { return [UInt8(ascii: "Z"), digits[digits.count - 1]] }
    if head == UInt8(ascii: "A") { return nil }
    let h = head - 1
    if h < UInt8(ascii: "Z") { digs.append(digits[digits.count - 1]) } else { digs.removeLast() }
    return [h] + digs
  }

  static func generateKeyBetween(_ a: [UInt8]?, _ b: [UInt8]?) throws -> [UInt8] {
    if let a { try validateOrderKey(a) }
    if let b { try validateOrderKey(b) }
    if let a, let b, !lessThan(a, b) { throw InvalidKey() }
    guard let a else {
      guard let b else { return [UInt8(ascii: "a"), zero] }
      let ib = try integerPart(b)
      let fb = Array(b.dropFirst(ib.count))
      if ib == [UInt8(ascii: "A")] + Array(repeating: zero, count: 26) {
        return ib + (try midpoint([], fb))
      }
      if lessThan(ib, b) { return ib }
      guard let result = try decrementInteger(ib) else { throw InvalidKey() }
      return result
    }
    guard let b else {
      let ia = try integerPart(a)
      let fa = Array(a.dropFirst(ia.count))
      if let incremented = try incrementInteger(ia) { return incremented }
      return ia + (try midpoint(fa, nil))
    }
    let ia = try integerPart(a)
    let fa = Array(a.dropFirst(ia.count))
    let ib = try integerPart(b)
    let fb = Array(b.dropFirst(ib.count))
    if ia == ib { return ia + (try midpoint(fa, fb)) }
    guard let incremented = try incrementInteger(ia) else { throw InvalidKey() }
    if lessThan(incremented, b) { return incremented }
    return ia + (try midpoint(fa, nil))
  }
}
