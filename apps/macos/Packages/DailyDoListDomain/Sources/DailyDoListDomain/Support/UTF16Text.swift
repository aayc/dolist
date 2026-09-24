import Foundation

// JavaScript strings are sequences of UTF-16 code units: lengths, offsets and regex atoms all count
// code units. Everything that must agree with @ddl/core runs on UTF-16 buffers and reads them
// through raw pointers (array subscripts cost ~20x more in unoptimized builds).

/// The UTF-16 code units of a string, as JavaScript sees it.
@usableFromInline
struct UTF16Buffer {
  let units: [UInt16]

  init(_ string: String) {
    units = string.utf16Units
  }

  init(units: [UInt16]) {
    self.units = units
  }

  var count: Int { units.count }

  /// Calls `body` with a pointer to the units (valid for `count` elements; never dereference it
  /// when `count` is 0).
  func withPointer<R>(_ body: (UnsafePointer<UInt16>, Int) throws -> R) rethrows -> R {
    try withUTF16Pointer(units, body)
  }
}

/// Calls `body` with a pointer to `units` and their count (a dummy pointer when empty).
func withUTF16Pointer<R>(_ units: [UInt16], _ body: (UnsafePointer<UInt16>, Int) throws -> R) rethrows -> R {
  try units.withUnsafeBufferPointer { buffer in
    if let base = buffer.baseAddress { return try body(base, buffer.count) }
    var zero: UInt16 = 0
    return try withUnsafePointer(to: &zero) { try body($0, 0) }
  }
}

extension String {
  /// Decodes `count` UTF-16 code units. A lone surrogate becomes U+FFFD, like `String(decoding:)`.
  init(utf16 pointer: UnsafePointer<UInt16>, count: Int) {
    if count <= 0 {
      self = ""
      return
    }
    self.init(unsafeUninitializedCapacity: count * 3) { buffer in
      let out = buffer.baseAddress!
      var o = 0
      var i = 0
      while i < count {
        let u = pointer[i]
        if u < 0x80 {
          out[o] = UInt8(truncatingIfNeeded: u)
          o += 1
        } else if u < 0x800 {
          out[o] = UInt8(truncatingIfNeeded: 0xC0 | (u >> 6))
          out[o + 1] = UInt8(truncatingIfNeeded: 0x80 | (u & 0x3F))
          o += 2
        } else if u & 0xFC00 == 0xD800, i + 1 < count, pointer[i + 1] & 0xFC00 == 0xDC00 {
          let scalar = 0x10000 + ((UInt32(u) - 0xD800) << 10) + (UInt32(pointer[i + 1]) - 0xDC00)
          out[o] = UInt8(truncatingIfNeeded: 0xF0 | (scalar >> 18))
          out[o + 1] = UInt8(truncatingIfNeeded: 0x80 | ((scalar >> 12) & 0x3F))
          out[o + 2] = UInt8(truncatingIfNeeded: 0x80 | ((scalar >> 6) & 0x3F))
          out[o + 3] = UInt8(truncatingIfNeeded: 0x80 | (scalar & 0x3F))
          o += 4
          i += 1
        } else if u & 0xF800 == 0xD800 {
          out[o] = 0xEF
          out[o + 1] = 0xBF
          out[o + 2] = 0xBD
          o += 3
        } else {
          out[o] = UInt8(truncatingIfNeeded: 0xE0 | (u >> 12))
          out[o + 1] = UInt8(truncatingIfNeeded: 0x80 | ((u >> 6) & 0x3F))
          out[o + 2] = UInt8(truncatingIfNeeded: 0x80 | (u & 0x3F))
          o += 3
        }
        i += 1
      }
      return o
    }
  }

  /// Decodes the code units `range` of `pointer`.
  init(utf16 pointer: UnsafePointer<UInt16>, _ range: Range<Int>) {
    self.init(utf16: pointer + range.lowerBound, count: range.count)
  }

  init(utf16Units units: [UInt16]) {
    self = withUTF16Pointer(units) { p, n in String(utf16: p, count: n) }
  }

  /// The UTF-16 code units, transcoded from the UTF-8 storage with pointer loops (iterating
  /// `utf16` is an order of magnitude slower in unoptimized builds).
  var utf16Units: [UInt16] {
    var copy = self
    return copy.withUTF8 { bytes in
      guard let p = bytes.baseAddress, bytes.count > 0 else { return [] }
      let n = bytes.count
      // Never more UTF-16 units than UTF-8 bytes.
      return [UInt16](unsafeUninitializedCapacity: n) { out, count in
        let o = out.baseAddress!
        var i = 0
        var k = 0
        while i < n {
          let b = p[i]
          if b < 0x80 {
            o[k] = UInt16(b)
            i += 1
          } else if b < 0xE0 {
            o[k] = UInt16(b & 0x1F) << 6 | UInt16(p[i + 1] & 0x3F)
            i += 2
          } else if b < 0xF0 {
            o[k] = UInt16(b & 0x0F) << 12 | UInt16(p[i + 1] & 0x3F) << 6 | UInt16(p[i + 2] & 0x3F)
            i += 3
          } else {
            let scalar =
              UInt32(b & 0x07) << 18 | UInt32(p[i + 1] & 0x3F) << 12 | UInt32(p[i + 2] & 0x3F) << 6
              | UInt32(p[i + 3] & 0x3F)
            o[k] = UInt16(truncatingIfNeeded: 0xD800 + ((scalar - 0x10000) >> 10))
            k += 1
            o[k] = UInt16(truncatingIfNeeded: 0xDC00 + ((scalar - 0x10000) & 0x3FF))
            i += 4
          }
          k += 1
        }
        count = k
      }
    }
  }

  /// UTF-16 length, JavaScript's `string.length`.
  var jsLength: Int { utf16.count }

  /// Code-unit equality, JavaScript's `===` (Swift's `==` also equates canonically equivalent
  /// strings such as NFC and NFD spellings, so it only serves as a fast rejection).
  func jsEquals(_ other: String) -> Bool {
    guard self == other, utf8.count == other.utf8.count else { return false }
    let exact = utf8.withContiguousStorageIfAvailable { a in
      other.utf8.withContiguousStorageIfAvailable { b in
        a.count == 0 || memcmp(a.baseAddress!, b.baseAddress!, a.count) == 0
      }
    }
    return (exact ?? nil) ?? utf8.elementsEqual(other.utf8)
  }

  /// JavaScript's `startsWith`, comparing code units.
  func jsHasPrefix(_ prefix: String) -> Bool {
    utf8.starts(with: prefix.utf8)
  }

  /// JavaScript's `endsWith`, comparing code units.
  func jsHasSuffix(_ suffix: String) -> Bool {
    utf8.reversed().starts(with: suffix.utf8.reversed())
  }

  /// JavaScript's `a < b`: lexicographic order of UTF-16 code units.
  func jsLess(_ other: String) -> Bool {
    utf16.lexicographicallyPrecedes(other.utf16)
  }

  var isASCII: Bool { utf8.allSatisfy { $0 < 0x80 } }

  /// NFC, like JavaScript's `normalize("NFC")` (ASCII is returned as is).
  var nfc: String { isASCII ? self : precomposedStringWithCanonicalMapping }
}

/// A dictionary/set key with JavaScript string identity (Swift's `String` would merge canonically
/// equivalent spellings, e.g. an NFC and an NFD folder name).
struct ExactString: Hashable {
  let value: String

  init(_ value: String) {
    self.value = value
  }

  static func == (a: ExactString, b: ExactString) -> Bool {
    a.value.jsEquals(b.value)
  }

  func hash(into hasher: inout Hasher) {
    let hashed: Void? = value.utf8.withContiguousStorageIfAvailable {
      hasher.combine(bytes: UnsafeRawBufferPointer($0))
    }
    if hashed == nil {
      for byte in value.utf8 { hasher.combine(byte) }
    }
  }
}

// MARK: - JavaScript whitespace

/// `\s` and `String.prototype.trim()` in JavaScript: WhiteSpace and LineTerminator code points.
@inline(__always)
func isJSWhitespace(_ u: UInt16) -> Bool {
  if u == 0x20 || (u >= 0x09 && u <= 0x0D) { return true }
  if u < 0xA0 { return false }
  switch u {
  case 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
  default: return false
  }
}

/// `[ \t]`
@inline(__always)
func isBlank(_ u: UInt16) -> Bool { u == 0x20 || u == 0x09 }

@inline(__always)
func isASCIIDigit(_ u: UInt16) -> Bool { u >= 0x30 && u <= 0x39 }

/// The bounds of `range` without leading and trailing JavaScript whitespace.
@inline(__always)
func jsTrim(_ p: UnsafePointer<UInt16>, _ range: Range<Int>) -> Range<Int> {
  var start = range.lowerBound
  var end = range.upperBound
  while start < end && isJSWhitespace(p[start]) { start += 1 }
  while end > start && isJSWhitespace(p[end - 1]) { end -= 1 }
  return start..<end
}

/// Collects UTF-16 code units, then decodes them once.
struct UTF16Builder {
  var units: [UInt16] = []

  init(capacity: Int = 0) {
    units.reserveCapacity(capacity)
  }

  mutating func append(_ string: String) {
    units.append(contentsOf: string.utf16)
  }

  mutating func append(_ p: UnsafePointer<UInt16>, _ range: Range<Int>) {
    units.append(contentsOf: UnsafeBufferPointer(start: p + range.lowerBound, count: range.count))
  }

  var string: String { String(utf16Units: units) }
}
