/// JavaScript case mapping, which differs from Swift's in two ways that matter for parity:
/// `toLowerCase()` applies the Final_Sigma rule (Σ → ς at the end of a word), and case-insensitive
/// regular expressions (without the `u` flag) compare single code units after "canonicalizing"
/// them to upper case, never mapping a non-ASCII character to an ASCII one.
enum JSCase {
  /// `String.prototype.toLowerCase()` (root locale: full mappings plus Final_Sigma).
  static func lowercase(_ p: UnsafePointer<UInt16>, _ range: Range<Int>) -> [UInt16] {
    var out: [UInt16] = []
    out.reserveCapacity(range.count)
    var i = range.lowerBound
    while i < range.upperBound {
      let u = p[i]
      if u < 0x80 {
        out.append(u >= 0x41 && u <= 0x5A ? u + 32 : u)
        i += 1
        continue
      }
      let (scalar, width) = decodeScalar(p, i, range.upperBound)
      if let scalar, scalar.value == 0x03A3 {
        let final =
          isPrecededByCased(p, i, range.lowerBound) && !isFollowedByCased(p, i + 1, range.upperBound)
        out.append(final ? 0x03C2 : 0x03C3)
      } else if let scalar, scalar.properties.changesWhenLowercased {
        out.append(contentsOf: scalar.properties.lowercaseMapping.utf16)
      } else {
        for k in 0..<width { out.append(p[i + k]) }  // unchanged, lone surrogates included
      }
      i += width
    }
    return out
  }

  static func lowercased(_ string: String) -> String {
    let buffer = UTF16Buffer(string)
    return buffer.withPointer { p, n in String(utf16Units: lowercase(p, 0..<n)) }
  }

  /// Lower case with one output unit per input unit (so offsets stay valid) and no context, like
  /// the web app's fuzzy matcher: "İ" folds to "i", "Σ" to "σ".
  static func foldOneToOne(_ p: UnsafePointer<UInt16>, _ count: Int) -> [UInt16] {
    var out = [UInt16](repeating: 0, count: count)
    out.withUnsafeMutableBufferPointer { buffer in
      let o = buffer.baseAddress!
      var i = 0
      while i < count {
        let u = p[i]
        if u < 0x80 {
          o[i] = u >= 0x41 && u <= 0x5A ? u + 32 : u
          i += 1
          continue
        }
        let (scalar, width) = decodeScalar(p, i, count)
        if let scalar, scalar.properties.changesWhenLowercased {
          var k = 0
          for unit in scalar.properties.lowercaseMapping.utf16 where k < width {
            o[i + k] = unit
            k += 1
          }
          while k < width {
            o[i + k] = p[i + k]
            k += 1
          }
        } else {
          for k in 0..<width { o[i + k] = p[i + k] }
        }
        i += width
      }
    }
    return out
  }

  /// `Canonicalize(ch)` of ECMAScript regular expressions with the `i` flag and without `u`.
  static func canonicalize(_ u: UInt16) -> UInt16 {
    if u < 0x80 { return u >= 0x61 && u <= 0x7A ? u - 32 : u }
    guard let scalar = Unicode.Scalar(u) else { return u }  // surrogate
    guard scalar.properties.changesWhenUppercased else { return u }
    let upper = Array(scalar.properties.uppercaseMapping.utf16)
    guard upper.count == 1, upper[0] >= 0x80 else { return u }
    return upper[0]
  }

  // MARK: Final_Sigma context (Unicode 3.13, as ICU implements it)

  private static func isPrecededByCased(_ p: UnsafePointer<UInt16>, _ index: Int, _ start: Int) -> Bool {
    var i = index
    while i > start {
      let (scalar, width) = decodeScalarBackward(p, i, start)
      i -= width
      guard let scalar else { return false }
      if scalar.properties.isCaseIgnorable { continue }
      return scalar.properties.isCased
    }
    return false
  }

  private static func isFollowedByCased(_ p: UnsafePointer<UInt16>, _ index: Int, _ end: Int) -> Bool {
    var i = index
    while i < end {
      let (scalar, width) = decodeScalar(p, i, end)
      i += width
      guard let scalar else { return false }
      if scalar.properties.isCaseIgnorable { continue }
      return scalar.properties.isCased
    }
    return false
  }
}

/// The scalar starting at `i` and its width in code units (nil for a lone surrogate, width 1).
@inline(__always)
func decodeScalar(_ p: UnsafePointer<UInt16>, _ i: Int, _ end: Int) -> (Unicode.Scalar?, Int) {
  let u = p[i]
  if u & 0xF800 != 0xD800 { return (Unicode.Scalar(u), 1) }
  if u & 0xFC00 == 0xD800, i + 1 < end, p[i + 1] & 0xFC00 == 0xDC00 {
    let value = 0x10000 + ((UInt32(u) - 0xD800) << 10) + (UInt32(p[i + 1]) - 0xDC00)
    return (Unicode.Scalar(value), 2)
  }
  return (nil, 1)
}

/// The scalar ending just before `i`.
@inline(__always)
func decodeScalarBackward(_ p: UnsafePointer<UInt16>, _ i: Int, _ start: Int) -> (Unicode.Scalar?, Int) {
  let u = p[i - 1]
  if u & 0xFC00 == 0xDC00, i - 2 >= start, p[i - 2] & 0xFC00 == 0xD800 {
    return decodeScalar(p, i - 2, i)
  }
  return u & 0xF800 == 0xD800 ? (nil, 1) : (Unicode.Scalar(u), 1)
}
